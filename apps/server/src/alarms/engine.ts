import { describePath, formatValue, type ActiveAlarm, type AlarmState, type Snapshot, type Threshold, type UnitPrefs } from '@watchkeeper/shared';
import type { EventHub } from '../api/events.js';
import { skipperPrefs } from '../auth/users.js';
import { iso, type Clock } from '../clock.js';
import type { DB } from '../db/index.js';
import type { HaClient } from '../ha/client.js';
import { writeLogEntry } from '../log/entries.js';
import type { OutboundValue } from '../signalk/outbound.js';
import type { LiveStore } from '../signalk/store.js';
import type { TimeSource } from '../signalk/time.js';
import type { Thresholds } from './thresholds.js';

/** An alarm clears once the value is back past its limit by this share of the threshold's range... */
export const HYSTERESIS_FRACTION = 0.02;
/** ...and stays there this long. */
export const CLEAR_HOLD_MS = 10_000;

type Level = 0 | 1 | 2;

interface Active {
  alarm: ActiveAlarm;
  /** Null for system alarms (raised by raiseSystem, not by a threshold). */
  threshold: Threshold | null;
  level: 1 | 2;
  /** When the value first satisfied the clear condition; null while it doesn't. */
  clearSince: number | null;
}

export interface AlarmEngineDeps {
  db: DB;
  store: LiveStore;
  clock: Clock;
  time: TimeSource;
  hub: EventHub;
  thresholds: Thresholds;
  ha: HaClient;
  /** Write to Signal K (notifications.app.*). Absent in tests without Signal K. */
  sendToSignalK?: (values: OutboundValue[]) => void;
  /** Write the alarm's event log entry. Defaults to a bare insert; the app passes the logbook's writer. */
  writeLog?: (e: { eventType: string; remarks: string; createdBy: string | null; extra: Snapshot }) => void;
  log?: { warn(msg: string): void };
}

function rawLevel(t: Threshold, v: number): Level {
  if ((t.alarmLow !== null && v <= t.alarmLow) || (t.alarmHigh !== null && v >= t.alarmHigh)) return 2;
  if ((t.warnLow !== null && v <= t.warnLow) || (t.warnHigh !== null && v >= t.warnHigh)) return 1;
  return 0;
}

/** The threshold's range: the span between its limits, or the magnitude of a single limit. */
export function thresholdRange(t: Threshold): number {
  const bounds = [t.alarmLow, t.warnLow, t.warnHigh, t.alarmHigh].filter((b): b is number => b !== null);
  const span = Math.max(...bounds) - Math.min(...bounds);
  if (span > 0) return span;
  return Math.abs(bounds[0] ?? 0) || 1;
}

/** Whether `v` is back past every limit of `level` by the hysteresis margin. */
function clearOk(t: Threshold, level: 1 | 2, v: number): boolean {
  const m = HYSTERESIS_FRACTION * thresholdRange(t);
  const low = level === 2 ? t.alarmLow : t.warnLow;
  const high = level === 2 ? t.alarmHigh : t.warnHigh;
  return (low === null || v >= low + m) && (high === null || v <= high - m);
}

/** Signal K notification path for a threshold. On the outbound allowlist. */
export const notificationPath = (thresholdId: string) => `notifications.app.dataHub.${thresholdId}`;

/**
 * Threshold alarms, evaluated in the backend on every update (never in the
 * browser). Raising writes a notifications.app.* delta, emits alarm.raised and
 * writes an event log entry. Acknowledge silences sound but keeps the alarm
 * until the condition clears. Snooze silences for N minutes, then re-raises
 * if the condition still holds. A stale value leaves the alarm as it is.
 */
export class AlarmEngine {
  private readonly active = new Map<string, Active>();
  private byPath = new Map<string, Threshold[]>();
  private timer: NodeJS.Timeout | null = null;
  private readonly onUpdate = (path: string) => {
    const list = this.byPath.get(path);
    if (list) for (const t of list) this.evaluate(t, this.deps.clock.now());
  };

  constructor(private readonly deps: AlarmEngineDeps) {
    this.reload();
  }

  start(): void {
    this.deps.store.on('update', this.onUpdate);
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  stop(): void {
    this.deps.store.off('update', this.onUpdate);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-read thresholds after a change. Alarms for removed, disabled or changed thresholds clear. */
  reload(): void {
    const list = this.deps.thresholds.list().filter((t) => t.enabled);
    this.byPath = new Map();
    for (const t of list) this.byPath.set(t.path, [...(this.byPath.get(t.path) ?? []), t]);
    const current = new Map(list.map((t) => [t.id, t]));
    for (const [id, a] of this.active) {
      if (a.threshold === null) continue;
      const t = current.get(id);
      if (!t || JSON.stringify(t) !== JSON.stringify(a.threshold)) this.clear(id, 'Threshold changed');
    }
    const now = this.deps.clock.now();
    for (const t of list) this.evaluate(t, now);
  }

  /** Hysteresis hold and snooze expiry advance with time, not just with updates. */
  tick(now = this.deps.clock.now()): void {
    for (const list of this.byPath.values()) for (const t of list) this.evaluate(t, now);
  }

  list(): ActiveAlarm[] {
    return [...this.active.values()].map((a) => ({ ...a.alarm }));
  }

  ack(id: string, userId: string | null): ActiveAlarm | null {
    const a = this.active.get(id);
    if (!a) return null;
    a.alarm.acked = true;
    this.effects(a, 'acked', userId);
    return { ...a.alarm };
  }

  snooze(id: string, minutes: number, userId: string | null): ActiveAlarm | null {
    const a = this.active.get(id);
    if (!a) return null;
    a.alarm.snoozedUntil = iso(this.deps.clock.now() + minutes * 60_000);
    this.effects(a, 'snoozed', userId);
    return { ...a.alarm };
  }

  /**
   * Raise or update an alarm no threshold owns (e.g. GPS and host clocks
   * disagreeing). A new message alone doesn't re-raise; escalating does.
   */
  raiseSystem(id: string, title: string, message: string, state: AlarmState = 'warn'): void {
    const level = state === 'warn' ? 1 : 2;
    const existing = this.active.get(id);
    if (existing) {
      if (existing.threshold !== null) return;
      existing.alarm.message = message;
      if (level > existing.level) {
        existing.level = 2;
        Object.assign(existing.alarm, { state, acked: false, snoozedUntil: null, raisedAt: iso(this.deps.time.read().now) });
        this.effects(existing, 'raised', null);
      }
      return;
    }
    const a: Active = {
      threshold: null,
      level,
      clearSince: null,
      alarm: { id, source: 'system', path: null, title, message, state, raisedAt: iso(this.deps.time.read().now), acked: false, snoozedUntil: null },
    };
    this.active.set(id, a);
    this.effects(a, 'raised', null);
  }

  clearSystem(id: string, message: string): void {
    if (this.active.get(id)?.threshold === null) this.clear(id, message);
  }

  evaluate(t: Threshold, now: number): void {
    const a = this.active.get(t.id);
    if (a?.alarm.snoozedUntil && now >= Date.parse(a.alarm.snoozedUntil)) {
      // Snooze over and the condition still holds (it would have cleared otherwise): raise again.
      a.alarm.snoozedUntil = null;
      a.alarm.acked = false;
      a.alarm.raisedAt = iso(this.deps.time.read().now);
      this.effects(a, 'raised', null);
    }
    const v = this.deps.store.fresh(t.path, now);
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    const level = rawLevel(t, v);
    if (!a) {
      if (level > 0) this.raise(t, level as 1 | 2, v);
      return;
    }
    if (level > a.level) {
      // Warn escalated to alarm: a new raise, unacknowledged, snooze cancelled.
      a.level = 2;
      Object.assign(a.alarm, { state: 'alarm', message: this.message(t, v, 2), acked: false, snoozedUntil: null, raisedAt: iso(this.deps.time.read().now) });
      a.clearSince = null;
      this.effects(a, 'raised', null, v);
      return;
    }
    if (!clearOk(t, a.level, v)) {
      a.clearSince = null;
      return;
    }
    a.clearSince ??= now;
    if (now - a.clearSince < CLEAR_HOLD_MS) return;
    if (level === 0) {
      this.clear(t.id, `${t.label} back to normal`);
    } else {
      // Alarm eased to warn: same alarm, lower state, no new raise.
      a.level = 1;
      a.clearSince = null;
      Object.assign(a.alarm, { state: 'warn', message: this.message(t, v, 1) });
      this.deps.hub.broadcast('alarm.raised', { ...a.alarm });
      this.notifySignalK(a);
    }
  }

  private raise(t: Threshold, level: 1 | 2, v: number): void {
    const a: Active = {
      threshold: t,
      level,
      clearSince: null,
      alarm: {
        id: t.id,
        source: 'threshold',
        path: t.path,
        title: t.label,
        message: this.message(t, v, level),
        state: level === 2 ? 'alarm' : 'warn',
        raisedAt: iso(this.deps.time.read().now),
        acked: false,
        snoozedUntil: null,
      },
    };
    this.active.set(t.id, a);
    this.effects(a, 'raised', null, v);
  }

  private clear(id: string, message: string): void {
    const a = this.active.get(id);
    if (!a) return;
    this.active.delete(id);
    this.deps.hub.broadcast('alarm.cleared', { id });
    this.send([{ path: notificationPath(id), value: { state: 'normal', method: [], message } }]);
  }

  private effects(a: Active, what: 'raised' | 'acked' | 'snoozed', userId: string | null, value?: number): void {
    const { alarm } = a;
    this.deps.hub.broadcast(what === 'raised' ? 'alarm.raised' : 'alarm.acked', { ...alarm });
    this.notifySignalK(a);
    const path = a.threshold?.path ?? null;
    const remarks =
      what === 'raised'
        ? `${alarm.title}: ${alarm.message}`
        : `${alarm.title}: ${what === 'acked' ? 'acknowledged' : `snoozed until ${alarm.snoozedUntil}`}`;
    const extra: Snapshot = {};
    if (path) {
      const v = value ?? this.deps.store.fresh(path);
      extra[path] = typeof v === 'number' || typeof v === 'string' ? v : null;
    }
    try {
      if (this.deps.writeLog) this.deps.writeLog({ eventType: `alarm_${what}`, remarks, createdBy: userId, extra });
      else {
        const time = this.deps.time.read();
        writeLogEntry(this.deps.db, { ts: time.now, kind: 'event', eventType: `alarm_${what}`, snapshot: { ...extra, clockSource: time.source }, remarks, createdBy: userId });
      }
    } catch (e) {
      this.deps.log?.warn(`Could not write alarm log entry: ${(e as Error).message}`);
    }
    // The phone notification is a convenience; the onboard sounder is the real alarm.
    if (what === 'raised' && alarm.state !== 'warn') {
      this.deps.ha.notify(alarm.title, alarm.message, { critical: true }).catch((e: Error) => this.deps.log?.warn(`HA notification failed: ${e.message}`));
    }
  }

  private notifySignalK(a: Active): void {
    const silenced = a.alarm.acked || a.alarm.snoozedUntil !== null;
    this.send([
      {
        path: notificationPath(a.alarm.id),
        value: { state: a.alarm.state, method: silenced ? ['visual'] : ['visual', 'sound'], message: `${a.alarm.title}: ${a.alarm.message}` },
      },
    ]);
  }

  private send(values: OutboundValue[]): void {
    try {
      this.deps.sendToSignalK?.(values);
    } catch (e) {
      this.deps.log?.warn(`Could not send alarm to Signal K: ${(e as Error).message}`);
    }
  }

  /** Alarm text in the skipper's units, e.g. "4 ft, below alarm limit 5 ft". */
  private message(t: Threshold, v: number, level: 1 | 2): string {
    const prefs = this.prefs();
    const q = describePath(t.path).quantity;
    const fmt = (x: number) => {
      const f = formatValue(q, x, prefs);
      return `${f.text}${f.unit && f.unit !== '°' ? ' ' : ''}${f.unit}${f.side ? ` ${f.side}` : ''}`;
    };
    const low = level === 2 ? t.alarmLow : t.warnLow;
    const high = level === 2 ? t.alarmHigh : t.warnHigh;
    const kind = level === 2 ? 'alarm' : 'warning';
    if (low !== null && v <= low) return `${fmt(v)}, below ${kind} limit ${fmt(low)}`;
    if (high !== null && v >= high) return `${fmt(v)}, above ${kind} limit ${fmt(high)}`;
    return fmt(v);
  }

  private prefs(): UnitPrefs {
    return skipperPrefs(this.deps.db);
  }
}
