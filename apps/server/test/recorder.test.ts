import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describePath } from '@watchkeeper/shared';
import { ManualClock } from '../src/clock.js';
import { openDb, type DB } from '../src/db/index.js';
import { Recorder } from '../src/recorder/recorder.js';
import { LiveStore } from '../src/signalk/store.js';
import { generate, NUMERIC_PATHS, readFixture, RECORDED_COLUMNS, T0, writeFixture } from './helpers/fixtures.js';

const count = (db: DB, table: string, where = '1') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

/** Fast-class columns in the generated fixture: numeric fast paths plus position lat and lon. */
const FAST_COLUMNS = NUMERIC_PATHS.filter((p) => describePath(p).rateClass === 'fast').length + 2;

/** Replay a fixture file through the store and recorder on simulated time. */
async function replay(file: string, seconds: number, onTick?: (i: number, db: DB, r: Recorder) => void) {
  const db = openDb(':memory:');
  const clock = new ManualClock(T0);
  const store = new LiveStore(clock);
  const recorder = new Recorder(db, store, clock);
  const lines = readFixture(file);
  let pending = await lines.next();
  for (let i = 0; i < seconds; i++) {
    const now = T0 + i * 1000 + 500;
    clock.set(now);
    while (!pending.done && pending.value.t <= now) {
      for (const u of pending.value.delta.updates) for (const v of u.values) store.update(v.path, v.value, pending.value.t);
      pending = await lines.next();
    }
    recorder.tick(now);
    onTick?.(i, db, recorder);
  }
  recorder.finish(T0 + seconds * 1000);
  return { db, recorder, clock };
}

describe('history recorder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dh-fixture-'));

  it('a 2-hour replay: fast paths in sample_1s, everything in sample_1m and sample_10m', async () => {
    const file = join(dir, 'two-hour.jsonl');
    const seconds = 2 * 3600;
    writeFixture(file, generate({ seconds }));
    const { db } = await replay(file, seconds);

    expect(FAST_COLUMNS).toBe(10);
    expect(count(db, 'sample_1s')).toBe(seconds * FAST_COLUMNS);
    expect(count(db, 'sample_1s', "path = 'environment.depth.belowKeel'")).toBe(0);
    expect(count(db, 'sample_1m')).toBe(120 * RECORDED_COLUMNS);
    expect(count(db, 'sample_10m')).toBe(12 * RECORDED_COLUMNS);

    const row = db.prepare("SELECT avg, min, max FROM sample_1m WHERE path = 'propulsion.port.revolutions' AND ts = ?").get(T0) as {
      avg: number;
      min: number;
      max: number;
    };
    expect(row.avg).toBeCloseTo(36.3, 9);
    expect(row.min).toBe(36.3);
    expect(row.max).toBe(36.3);
  }, 60_000);

  it('writes land in batches every 10 s, not every second', async () => {
    const file = join(dir, 'batch.jsonl');
    writeFixture(file, generate({ seconds: 25 }));
    const seen: number[] = [];
    await replay(file, 25, (i, db) => seen.push(count(db, 'sample_1s')));
    // Nothing written for the first 10 s, then a batch of 11 seconds' worth, then the next at 20 s.
    expect(seen.slice(0, 10).every((n) => n === 0)).toBe(true);
    expect(seen[10]).toBe(11 * FAST_COLUMNS);
    expect(seen.slice(11, 20).every((n) => n === 11 * FAST_COLUMNS)).toBe(true);
    expect(seen[20]).toBe(21 * FAST_COLUMNS);
  });

  it('retention prunes 1 s samples after 24 h and 1 min samples after 90 days', async () => {
    const file = join(dir, 'ten-min.jsonl');
    writeFixture(file, generate({ seconds: 600 }));
    const { db, recorder } = await replay(file, 600);
    expect(count(db, 'sample_1s')).toBe(600 * FAST_COLUMNS);

    recorder.prune(T0 + 24 * 3600_000 + 300_000);
    expect(count(db, 'sample_1s')).toBe(300 * FAST_COLUMNS);
    expect(count(db, 'sample_1m')).toBe(10 * RECORDED_COLUMNS);

    recorder.prune(T0 + 91 * 24 * 3600_000);
    expect(count(db, 'sample_1s')).toBe(0);
    expect(count(db, 'sample_1m')).toBe(0);
    expect(count(db, 'sample_10m')).toBe(RECORDED_COLUMNS);
  });

  it('a dead sensor records null, never its last value', async () => {
    const file = join(dir, 'dead-depth.jsonl');
    writeFixture(file, generate({ seconds: 120, dead: ['environment.depth.belowKeel'], deadAfterS: 30 }));
    const { db } = await replay(file, 120);
    const rows = db.prepare("SELECT ts, avg, min, max FROM sample_1m WHERE path = 'environment.depth.belowKeel' ORDER BY ts").all() as {
      ts: number;
      avg: number | null;
    }[];
    // Depth (medium class, effective timeout 15 s) dies at 30 s: minute 0 has values, minute 1 is null.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.avg).not.toBeNull();
    expect(rows[1]).toMatchObject({ avg: null, min: null, max: null });
  });
});
