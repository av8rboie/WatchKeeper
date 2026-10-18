import { isRecordable, POSITION_LAT_SUFFIX, POSITION_LON_SUFFIX } from '@watchkeeper/shared';
import type { Clock } from '../clock.js';
import type { DB } from '../db/index.js';
import type { LiveStore } from '../signalk/store.js';

const SEC = 1000;
const MIN = 60 * SEC;
const TEN_MIN = 10 * MIN;
const DAY = 24 * 3600 * SEC;

export const RETENTION = { sample1sMs: DAY, sample1mMs: 90 * DAY };
/** Samples are buffered in memory and written in one transaction this often. */
export const FLUSH_MS = 10 * SEC;

const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

interface Acc {
  sum: number;
  count: number;
  min: number;
  max: number;
}

type Row1s = [path: string, ts: number, value: number | null];
type Row1m = [path: string, ts: number, avg: number | null, min: number | null, max: number | null];

/**
 * History sampling, kept light on the CPU and the SD/NVMe:
 * - once a second, read every recordable path seen since startup (null while stale);
 * - fast-class paths are kept at 1 s resolution, everything else goes straight
 *   to the 1 min tier, aggregated in memory;
 * - all of it is buffered and written in one transaction every 10 s;
 * - 10 min rollups and retention run inside that flush.
 */
export class Recorder {
  private lastSecond: number | null = null;
  private lastFlush: number | null = null;
  private minuteStart: number | null = null;
  private readonly acc = new Map<string, Acc | null>();
  private buf1s: Row1s[] = [];
  private pending1m: Row1m[] = [];
  private completedTen: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly insert1s;
  private readonly insert1m;
  private readonly rollup10m;

  constructor(
    private readonly db: DB,
    private readonly store: LiveStore,
    private readonly clock: Clock,
    private readonly flushMs = FLUSH_MS,
  ) {
    this.insert1s = db.prepare('INSERT OR REPLACE INTO sample_1s (path, ts, value) VALUES (?, ?, ?)');
    this.insert1m = db.prepare('INSERT OR REPLACE INTO sample_1m (path, ts, avg, min, max) VALUES (?, ?, ?, ?, ?)');
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

  /** Rows still in memory, for tests and shutdown accounting. */
  get buffered(): number {
    return this.buf1s.length + this.pending1m.length;
  }

  tick(now = this.clock.now()): void {
    const second = floorTo(now, SEC);
    if (this.lastSecond !== null && second <= this.lastSecond) return;
    const minute = floorTo(second, MIN);
    if (this.minuteStart !== null && minute > this.minuteStart) this.closeMinute(this.minuteStart);
    this.minuteStart = minute;

    for (const path of this.store.paths()) {
      const def = this.store.def(path);
      if (!isRecordable(def)) continue;
      const v = this.store.fresh(path, now);
      const fast = def.rateClass === 'fast';
      if (def.quantity === 'position') {
        const p = v as { latitude?: number; longitude?: number } | null;
        this.sample(path + POSITION_LAT_SUFFIX, second, typeof p?.latitude === 'number' ? p.latitude : null, fast);
        this.sample(path + POSITION_LON_SUFFIX, second, typeof p?.longitude === 'number' ? p.longitude : null, fast);
      } else {
        this.sample(path, second, typeof v === 'number' && Number.isFinite(v) ? v : null, fast);
      }
    }

    this.lastSecond = second;
    this.lastFlush ??= second;
    if (second - this.lastFlush >= this.flushMs) this.flush(second);
  }

  private sample(col: string, second: number, value: number | null, fast: boolean): void {
    if (fast) this.buf1s.push([col, second, value]);
    const a = this.acc.get(col) ?? null;
    if (value === null) {
      if (!this.acc.has(col)) this.acc.set(col, null);
      return;
    }
    if (a === null) this.acc.set(col, { sum: value, count: 1, min: value, max: value });
    else {
      a.sum += value;
      a.count += 1;
      if (value < a.min) a.min = value;
      if (value > a.max) a.max = value;
    }
  }

  /** Turn the in-memory minute into 1 min rows, null where nothing fresh arrived. */
  private closeMinute(start: number): void {
    for (const [col, a] of this.acc) {
      this.pending1m.push(a ? [col, start, a.sum / a.count, a.min, a.max] : [col, start, null, null, null]);
    }
    this.acc.clear();
    if ((start + MIN) % TEN_MIN === 0) this.completedTen.push(start + MIN - TEN_MIN);
  }

  /** Write everything buffered in one transaction, then roll up and prune. */
  flush(now = this.clock.now()): void {
    const rows1s = this.buf1s;
    const rows1m = this.pending1m;
    const tens = this.completedTen;
    this.buf1s = [];
    this.pending1m = [];
    this.completedTen = [];
    this.lastFlush = floorTo(now, SEC);
    if (rows1s.length === 0 && rows1m.length === 0 && tens.length === 0) return;
    this.db.transaction(() => {
      for (const r of rows1s) this.insert1s.run(...r);
      for (const r of rows1m) this.insert1m.run(...r);
      for (const t of tens) this.rollup10m.run({ start: t, end: t + TEN_MIN });
      if (tens.length > 0) this.prune(now);
    })();
  }

  /**
   * Close the current minute if `now` is past it (or always, with `partial`,
   * on shutdown so nothing in memory is lost) and flush.
   */
  finish(now = this.clock.now(), opts: { partial?: boolean } = {}): void {
    if (this.minuteStart !== null && (opts.partial || now >= this.minuteStart + MIN)) {
      this.closeMinute(this.minuteStart);
      this.minuteStart = null;
    }
    this.flush(now);
  }

  prune(now = this.clock.now()): { removed1s: number; removed1m: number } {
    const removed1s = this.db.prepare('DELETE FROM sample_1s WHERE ts < ?').run(now - RETENTION.sample1sMs).changes;
    const removed1m = this.db.prepare('DELETE FROM sample_1m WHERE ts < ?').run(now - RETENTION.sample1mMs).changes;
    return { removed1s, removed1m };
  }
}
