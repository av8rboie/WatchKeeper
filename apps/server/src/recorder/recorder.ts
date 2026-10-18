import { isRecordable, POSITION_LAT_SUFFIX, POSITION_LON_SUFFIX } from '@watchkeeper/shared';
import type { Clock } from '../clock.js';
import type { DB } from '../db/index.js';
import type { LiveStore } from '../signalk/store.js';

const SEC = 1000;
const MIN = 60 * SEC;
const TEN_MIN = 10 * MIN;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const RETENTION = { sample1sMs: DAY, sample1mMs: 90 * DAY };

const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

/**
 * History sampling. Every second, writes the current value of every
 * recordable path seen since startup (null when stale). Rolls 1 s samples
 * into 1 min and 1 min into 10 min as each bucket completes, then prunes.
 */
export class Recorder {
  private lastSecond: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly insert1s;
  private readonly rollup1m;
  private readonly rollup10m;

  constructor(
    private readonly db: DB,
    private readonly store: LiveStore,
    private readonly clock: Clock,
  ) {
    this.insert1s = db.prepare('INSERT OR REPLACE INTO sample_1s (path, ts, value) VALUES (?, ?, ?)');
    this.rollup1m = db.prepare(`
      INSERT OR REPLACE INTO sample_1m (path, ts, avg, min, max)
      SELECT path, @start, AVG(value), MIN(value), MAX(value)
      FROM sample_1s WHERE ts >= @start AND ts < @end GROUP BY path`);
    this.rollup10m = db.prepare(`
      INSERT OR REPLACE INTO sample_10m (path, ts, avg, min, max)
      SELECT path, @start, AVG(avg), MIN(min), MAX(max)
      FROM sample_1m WHERE ts >= @start AND ts < @end GROUP BY path`);
  }

  start(): void {
    const loop = () => {
      this.tick();
      this.timer = setTimeout(loop, SEC - (Date.now() % SEC) + 5);
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The rows one sample second produces. */
  private rowsAt(now: number): [string, number | null][] {
    const rows: [string, number | null][] = [];
    for (const path of this.store.paths()) {
      const def = this.store.def(path);
      if (!isRecordable(def)) continue;
      const v = this.store.fresh(path, now);
      if (def.quantity === 'position') {
        const p = v as { latitude?: number; longitude?: number } | null;
        rows.push([path + POSITION_LAT_SUFFIX, typeof p?.latitude === 'number' ? p.latitude : null]);
        rows.push([path + POSITION_LON_SUFFIX, typeof p?.longitude === 'number' ? p.longitude : null]);
      } else {
        rows.push([path, typeof v === 'number' && Number.isFinite(v) ? v : null]);
      }
    }
    return rows;
  }

  tick(now = this.clock.now()): void {
    const second = floorTo(now, SEC);
    if (this.lastSecond !== null && second <= this.lastSecond) return;
    const prev = this.lastSecond;
    const rows = this.rowsAt(now);
    this.db.transaction(() => {
      for (const [path, value] of rows) this.insert1s.run(path, second, value);
      if (prev !== null) this.rollupCompleted(prev, second);
    })();
    this.lastSecond = second;
  }

  /** Roll up every 1 min and 10 min bucket that completed between two samples. */
  private rollupCompleted(prevSecond: number, second: number): void {
    const prevMin = floorTo(prevSecond, MIN);
    const curMin = floorTo(second, MIN);
    for (let m = prevMin; m < curMin; m += MIN) this.rollupMinute(m);
    const prevTen = floorTo(prevSecond, TEN_MIN);
    const curTen = floorTo(second, TEN_MIN);
    for (let t = prevTen; t < curTen; t += TEN_MIN) this.rollupTenMinute(t);
    if (curTen > prevTen) this.prune(second);
  }

  rollupMinute(start: number): void {
    this.rollup1m.run({ start, end: start + MIN });
  }

  rollupTenMinute(start: number): void {
    this.rollup10m.run({ start, end: start + TEN_MIN });
  }

  /** Complete any open buckets up to `now`, e.g. before shutdown or in tests. */
  flush(now = this.clock.now()): void {
    const last = this.lastSecond;
    if (last === null) return;
    const end = floorTo(now, SEC);
    this.db.transaction(() => this.rollupCompleted(last, end))();
  }

  prune(now = this.clock.now()): { removed1s: number; removed1m: number } {
    const removed1s = this.db.prepare('DELETE FROM sample_1s WHERE ts < ?').run(now - RETENTION.sample1sMs).changes;
    const removed1m = this.db.prepare('DELETE FROM sample_1m WHERE ts < ?').run(now - RETENTION.sample1mMs).changes;
    return { removed1s, removed1m };
  }
}
