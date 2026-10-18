import { iso, type Clock } from '../clock.js';
import { getSetting, setSetting, type DB } from '../db/index.js';
import type { LiveStore } from '../signalk/store.js';
import { MAX_DRIFT_MS, type TimeSource } from '../signalk/time.js';
import type { Logbook } from './logbook.js';

const HOUR = 3_600_000;
/** With no passage but the anchor down, an entry every 4 hours (00, 04, 08 ... UTC). */
const ANCHOR_INTERVAL = 4 * HOUR;
const HEARTBEAT_KEY = 'logbook.heartbeat';
const HEARTBEAT_MS = 30_000;
const DRIFT_CHECK_MS = 60_000;
/** Wait this long after start for GPS time before deciding what was missed using the host clock. */
const GPS_WAIT_MS = 60_000;
export const CLOCK_DRIFT_ALARM = 'clockDrift';

type Mode = 'passage' | 'anchor' | 'off';

interface Heartbeat {
  /** Last log time (epoch ms) the scheduler was running. */
  at: number;
  mode: Mode;
}

export interface SchedulerDeps {
  db: DB;
  logbook: Logbook;
  store: LiveStore;
  clock: Clock;
  time: TimeSource;
  alarms?: { raiseSystem(id: string, title: string, message: string): void; clearSystem(id: string, message: string): void };
  /** Whether an anchor set is active (M5 anchor watch). Signal K's anchor position counts too. */
  anchorActive?: () => boolean;
}

const hhmm = (t: number) => iso(t).slice(11, 16);

/**
 * Writes the hourly entries. Fires on GPS-time hour boundaries (host time
 * when GPS time is stale): every hour while a passage is active, every 4
 * hours at anchor, otherwise not at all. Missed hours are never back-filled:
 * after downtime it writes one system entry naming the gap.
 */
export class LogScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastHour: number | null = null;
  private lastBeat = 0;
  private lastDriftCheck = 0;
  private startedAt: number | null = null;
  private recovered = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    const loop = () => {
      this.tick();
      this.timer = setTimeout(loop, 1000 - (Date.now() % 1000) + 50);
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.recovered) this.beat(this.deps.time.read().now);
  }

  mode(): Mode {
    if (this.deps.logbook.activePassage()) return 'passage';
    if (this.deps.anchorActive?.() || this.deps.store.fresh('navigation.anchor.position')) return 'anchor';
    return 'off';
  }

  tick(hostNow = this.deps.clock.now()): void {
    this.startedAt ??= hostNow;
    const t = this.deps.time.read();
    if (!this.recovered) {
      // The first time decides which hours were missed: prefer GPS time.
      if (t.source !== 'gps' && hostNow - this.startedAt < GPS_WAIT_MS) return;
      this.recover(t.now);
    }
    const hour = Math.floor(t.now / HOUR) * HOUR;
    if (this.lastHour === null || hour < this.lastHour) this.lastHour = hour;
    if (hour > this.lastHour) {
      // Only the boundary just crossed: a jump over several hours doesn't invent entries.
      this.lastHour = hour;
      const mode = this.mode();
      if (mode === 'passage' || (mode === 'anchor' && hour % ANCHOR_INTERVAL === 0)) {
        this.deps.logbook.write({ kind: 'hourly', ts: hour });
      }
    }
    if (t.now - this.lastBeat >= HEARTBEAT_MS) this.beat(t.now);
    if (hostNow - this.lastDriftCheck >= DRIFT_CHECK_MS) {
      this.lastDriftCheck = hostNow;
      this.checkDrift(t.driftMs);
    }
  }

  private beat(now: number): void {
    this.lastBeat = now;
    setSetting(this.deps.db, HEARTBEAT_KEY, { at: now, mode: this.mode() } satisfies Heartbeat);
  }

  /** After downtime: one system entry for the boundaries that passed while we were down. */
  private recover(now: number): void {
    this.recovered = true;
    this.lastHour = Math.floor(now / HOUR) * HOUR;
    const hb = getSetting<Heartbeat | null>(this.deps.db, HEARTBEAT_KEY, null);
    if (!hb || hb.at >= now) return;
    // What the log would have done: the mode before the outage, or now if a passage is under way.
    const mode: Mode = this.deps.logbook.activePassage() ? 'passage' : hb.mode;
    if (mode === 'off') return;
    const step = mode === 'passage' ? HOUR : ANCHOR_INTERVAL;
    const first = Math.floor(hb.at / step) * step + step;
    if (first > now) return;
    const last = Math.floor(now / step) * step;
    const remarks =
      first === last
        ? `No entry at ${hhmm(first)} UTC: data hub offline`
        : `No entries ${hhmm(first)} to ${hhmm(last)} UTC: data hub offline`;
    this.deps.logbook.write({ kind: 'system', eventType: 'offline', remarks, ts: now });
  }

  private checkDrift(driftMs: number | null): void {
    const alarms = this.deps.alarms;
    if (!alarms) return;
    if (driftMs !== null && Math.abs(driftMs) > MAX_DRIFT_MS) {
      const s = Math.round(Math.abs(driftMs) / 1000);
      alarms.raiseSystem(CLOCK_DRIFT_ALARM, 'Clock drift', `GPS and host clocks differ by ${s} s. Log times use GPS.`);
    } else if (driftMs !== null) {
      alarms.clearSystem(CLOCK_DRIFT_ALARM, 'GPS and host clocks agree');
    }
  }
}
