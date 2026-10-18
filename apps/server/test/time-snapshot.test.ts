import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { openDb } from '../src/db/index.js';
import { restoreIfMissing, takeSnapshot } from '../src/db/snapshot.js';
import { LiveStore } from '../src/signalk/store.js';
import { TimeSource } from '../src/signalk/time.js';
import { T0 } from './helpers/fixtures.js';

describe('GPS time', () => {
  it('uses navigation.datetime, extrapolated, and reports drift from the host clock', () => {
    const host = new ManualClock(T0);
    const store = new LiveStore(host);
    const time = new TimeSource(store, host);
    expect(time.read()).toEqual({ source: 'host', now: T0, driftMs: null });

    // GPS is 7 s ahead of a wrong host clock.
    store.update('navigation.datetime', new Date(T0 + 7000).toISOString());
    host.advance(3000);
    expect(time.read()).toEqual({ source: 'gps', now: T0 + 10_000, driftMs: 7000 });
  });

  it('falls back to the host clock when GPS time goes stale', () => {
    const host = new ManualClock(T0);
    const store = new LiveStore(host);
    const time = new TimeSource(store, host);
    store.update('navigation.datetime', new Date(T0).toISOString());
    host.advance(16_000); // past the 15 s timeout
    expect(time.read().source).toBe('host');
  });
});

describe('HA backup snapshot', () => {
  it('a snapshot taken while writing restores to an identical, consistent database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dh-snap-'));
    const dbFile = join(dir, 'data-hub.db');
    const snap = join(dir, 'snapshot', 'data-hub.db');
    const db = openDb(dbFile);
    const insert = db.prepare('INSERT INTO sample_1m (path, ts, avg, min, max) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 500; i++) insert.run('p', i, i, i, i);
    db.prepare("INSERT INTO log_entry (id, ts, kind, snapshot) VALUES ('e1', '2026-10-18T12:00:00.000Z', 'hourly', '{}')").run();

    // Keep logging while the snapshot runs.
    const writing = (async () => {
      for (let i = 500; i < 600; i++) {
        insert.run('p', i, i, i, i);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await takeSnapshot(dbFile, snap);
    await writing;
    db.close();

    // Simulate an HA restore: the live database and WAL are not in the backup.
    for (const f of ['data-hub.db', 'data-hub.db-wal', 'data-hub.db-shm']) rmSync(join(dir, f), { force: true });
    expect(restoreIfMissing(dbFile, snap)).toBe(true);
    const restored = openDb(dbFile);
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    const n = (restored.prepare('SELECT COUNT(*) AS n FROM sample_1m').get() as { n: number }).n;
    expect(n).toBeGreaterThanOrEqual(500);
    expect(n).toBeLessThanOrEqual(600);
    expect(restored.prepare('SELECT id FROM log_entry').all()).toEqual([{ id: 'e1' }]);
    restored.close();
  });

  it('does nothing when the live database exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dh-snap-'));
    const dbFile = join(dir, 'data-hub.db');
    openDb(dbFile).close();
    expect(restoreIfMissing(dbFile, join(dir, 'snapshot', 'data-hub.db'))).toBe(false);
    expect(existsSync(dbFile)).toBe(true);
  });
});
