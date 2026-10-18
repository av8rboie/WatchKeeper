import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { openDb, type DB } from '../src/db/index.js';
import { Recorder } from '../src/recorder/recorder.js';
import { LiveStore } from '../src/signalk/store.js';
import { generate, readFixture, RECORDED_COLUMNS, T0, writeFixture } from './helpers/fixtures.js';

const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Replay a fixture file through the store and recorder on simulated time. */
async function replay(file: string, seconds: number) {
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
  }
  recorder.flush(T0 + seconds * 1000);
  return { db, recorder, clock };
}

describe('history recorder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dh-fixture-'));

  it('a 2-hour replay produces the expected 1 s, 1 min and 10 min row counts', async () => {
    const file = join(dir, 'two-hour.jsonl');
    const seconds = 2 * 3600;
    writeFixture(file, generate({ seconds }));
    const { db } = await replay(file, seconds);

    expect(count(db, 'sample_1s')).toBe(seconds * RECORDED_COLUMNS);
    expect(count(db, 'sample_1m')).toBe(120 * RECORDED_COLUMNS);
    expect(count(db, 'sample_10m')).toBe(12 * RECORDED_COLUMNS);

    // Rollups carry avg/min/max of the underlying samples.
    const row = db.prepare("SELECT avg, min, max FROM sample_1m WHERE path = 'propulsion.port.revolutions' AND ts = ?").get(T0) as {
      avg: number;
      min: number;
      max: number;
    };
    expect(row).toEqual({ avg: 36.3, min: 36.3, max: 36.3 });
  }, 60_000);

  it('retention prunes 1 s samples after 24 h and 1 min samples after 90 days', async () => {
    const file = join(dir, 'ten-min.jsonl');
    writeFixture(file, generate({ seconds: 600 }));
    const { db, recorder } = await replay(file, 600);
    expect(count(db, 'sample_1s')).toBe(600 * RECORDED_COLUMNS);

    // 24 h after the 5-minute mark: the first 5 minutes of 1 s samples go.
    recorder.prune(T0 + 24 * 3600_000 + 300_000);
    expect(count(db, 'sample_1s')).toBe(300 * RECORDED_COLUMNS);
    expect(count(db, 'sample_1m')).toBe(10 * RECORDED_COLUMNS);

    recorder.prune(T0 + 91 * 24 * 3600_000);
    expect(count(db, 'sample_1s')).toBe(0);
    expect(count(db, 'sample_1m')).toBe(0);
    // 10 min rollups are kept indefinitely.
    expect(count(db, 'sample_10m')).toBe(RECORDED_COLUMNS);
  });

  it('a dead sensor records null, never its last value', async () => {
    const file = join(dir, 'dead-depth.jsonl');
    writeFixture(file, generate({ seconds: 120, dead: ['environment.depth.belowKeel'], deadAfterS: 30 }));
    const { db } = await replay(file, 120);
    const rows = db.prepare("SELECT ts, value FROM sample_1s WHERE path = 'environment.depth.belowKeel' ORDER BY ts").all() as {
      ts: number;
      value: number | null;
    }[];
    expect(rows).toHaveLength(120);
    // Last depth update at t=29 s; its 10 s timeout passes before the sample
    // taken at t=39.5 s, so the 39 s row is the first null.
    for (const r of rows) {
      const age = (r.ts - T0) / 1000;
      if (age <= 38) expect(r.value).not.toBeNull();
      else expect(r.value).toBeNull();
    }
  });
});
