import { ulid } from 'ulid';
import { ThresholdInputSchema, type Threshold, type ThresholdInput } from '@watchkeeper/shared';
import type { Clock } from '../clock.js';
import type { DB } from '../db/index.js';

interface Row {
  id: string;
  path: string;
  label: string;
  warn_low: number | null;
  warn_high: number | null;
  alarm_low: number | null;
  alarm_high: number | null;
  enabled: number;
}

const toThreshold = (r: Row): Threshold => ({
  id: r.id,
  path: r.path,
  label: r.label,
  warnLow: r.warn_low,
  warnHigh: r.warn_high,
  alarmLow: r.alarm_low,
  alarmHigh: r.alarm_high,
  enabled: r.enabled === 1,
});

export class ThresholdConflictError extends Error {
  readonly statusCode = 409;
  constructor(path: string) {
    super(`A threshold for ${path} already exists.`);
    this.name = 'ThresholdConflictError';
  }
}

/** Limits in SI units, one threshold per path. */
export class Thresholds {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  list(): Threshold[] {
    return (this.db.prepare('SELECT * FROM threshold ORDER BY label').all() as Row[]).map(toThreshold);
  }

  get(id: string): Threshold | null {
    const r = this.db.prepare('SELECT * FROM threshold WHERE id = ?').get(id) as Row | undefined;
    return r ? toThreshold(r) : null;
  }

  byPath(path: string): Threshold | null {
    const r = this.db.prepare('SELECT * FROM threshold WHERE path = ?').get(path) as Row | undefined;
    return r ? toThreshold(r) : null;
  }

  create(input: ThresholdInput): Threshold {
    const t = ThresholdInputSchema.parse(input);
    if (this.byPath(t.path)) throw new ThresholdConflictError(t.path);
    const id = ulid(this.clock.now());
    this.db
      .prepare('INSERT INTO threshold (id, path, label, warn_low, warn_high, alarm_low, alarm_high, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.path, t.label, t.warnLow, t.warnHigh, t.alarmLow, t.alarmHigh, t.enabled ? 1 : 0);
    return this.get(id)!;
  }

  update(id: string, input: ThresholdInput): Threshold | null {
    const t = ThresholdInputSchema.parse(input);
    const other = this.byPath(t.path);
    if (other && other.id !== id) throw new ThresholdConflictError(t.path);
    const changes = this.db
      .prepare('UPDATE threshold SET path = ?, label = ?, warn_low = ?, warn_high = ?, alarm_low = ?, alarm_high = ?, enabled = ? WHERE id = ?')
      .run(t.path, t.label, t.warnLow, t.warnHigh, t.alarmLow, t.alarmHigh, t.enabled ? 1 : 0, id).changes;
    return changes > 0 ? this.get(id) : null;
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM threshold WHERE id = ?').run(id).changes > 0;
  }
}
