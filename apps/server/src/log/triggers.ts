import {
  DEFAULT_INSTANCE_IDS,
  formatValue,
  KNOT_MPS,
  radToDeg360,
  type InstanceIds,
  type PassageSuggestion,
  type UnitPrefs,
} from '@watchkeeper/shared';
import type { EventHub } from '../api/events.js';
import { skipperPrefs } from '../auth/users.js';
import { iso, type Clock } from '../clock.js';
import { getSetting, type DB } from '../db/index.js';
import { DERIVED } from '../derived/engine.js';
import type { LiveStore } from '../signalk/store.js';
import type { TimeSource } from '../signalk/time.js';
import type { Logbook } from './logbook.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Spec defaults (Logbook, Event triggers). */
export const TRIGGERS = {
  engineDebounceMs: 30_000,
  /** RPM above this counts as running when there's no state path: 300 rpm in Hz. */
  engineRunningHz: 300 / 60,
  courseDeltaRad: (30 * Math.PI) / 180,
  courseWindowMs: 5 * MIN,
  courseHoldMs: 5 * MIN,
  /** Below this SOG, COG is noise (at anchor or drifting). */
  courseMinSogMps: 1 * KNOT_MPS,
  windDeltaMps: 10 * KNOT_MPS,
  windWindowMs: 60 * MIN,
  windCooldownMs: HOUR,
  pressureDropPa: -200,
  pressureCooldownMs: 3 * HOUR,
  suggestStartSogMps: 2 * KNOT_MPS,
  suggestStartHoldMs: 10 * MIN,
  suggestEndSogMps: 0.5 * KNOT_MPS,
  suggestEndHoldMs: 30 * MIN,
} as const;

interface EngineState {
  confirmed: boolean | null;
  candidate: boolean | null;
  since: number;
}

const cap = (v: string) => (v ? v[0]!.toUpperCase() + v.slice(1) : v);

/** Smallest angle between two bearings, radians, 0..pi. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

export interface TriggerDeps {
  db: DB;
  store: LiveStore;
  clock: Clock;
  time: TimeSource;
  hub: EventHub;
  logbook: Logbook;
}

/**
 * Event entries the backend writes on its own (engine, course, wind,
 * pressure), and the passage start/end suggestions. Evaluated once a second
 * on host time; entries carry GPS time. Alarm entries come from the alarm
 * engine; anchor entries from anchor watch (M5).
 */
export class EventTriggers {
  private timer: NodeJS.Timeout | null = null;
  private readonly engines = new Map<string, EngineState>();
  private cog: { t: number; sin: number; cos: number }[] = [];
  private courseRef: number | null = null;
  private courseHoldSince: number | null = null;
  private wind: { t: number; v: number }[] = [];
  private lastWindMinute = 0;
  private lastWindEvent = -Infinity;
  private lastPressureEvent = -Infinity;
  private movingSince: number | null = null;
  private stoppedSince: number | null = null;
  private startArmed = true;
  // Armed only once the boat has been under way, so a passage started at the dock isn't told to end.
  private endArmed = false;
  private anchorWasDown: boolean | null = null;
  private suggestion: PassageSuggestion | null = null;

  constructor(private readonly deps: TriggerDeps) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The prompt clients should show, if any. */
  currentSuggestion(): PassageSuggestion | null {
    if (this.suggestion) {
      const active = this.deps.logbook.activePassage() !== null;
      // A start suggestion is moot once a passage is under way, and an end suggestion once it has ended.
      if ((this.suggestion.kind === 'start') === active) this.suggestion = null;
    }
    return this.suggestion;
  }

  dismissSuggestion(): void {
    this.suggestion = null;
  }

  private ids(): InstanceIds {
    return getSetting<InstanceIds>(this.deps.db, 'instanceIds', DEFAULT_INSTANCE_IDS);
  }

  private num(path: string, now: number): number | null {
    const v = this.deps.store.fresh(path, now);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  tick(now = this.deps.clock.now()): void {
    this.engineTrigger(now);
    this.courseTrigger(now);
    this.windTrigger(now);
    this.pressureTrigger(now);
    this.suggestions(now);
  }

  private event(eventType: string, remarks: string, at?: number): void {
    this.deps.logbook.write({ kind: 'event', eventType, remarks, ts: at });
  }

  /** Log time of host moment `at`, given host time `now`. */
  private logTimeAgo(now: number, at: number): number {
    return this.deps.time.read().now - (now - at);
  }

  private prefs(): UnitPrefs {
    return skipperPrefs(this.deps.db);
  }

  private fmt(quantity: 'speed' | 'pressure', v: number): string {
    const f = formatValue(quantity, v, this.prefs());
    return `${f.text} ${f.unit}`;
  }

  // Engine start or stop: any state change, or RPM crossing 300; held 30 s.
  private engineTrigger(now: number): void {
    for (const id of this.ids().propulsion) {
      const state = this.deps.store.fresh(`propulsion.${id}.state`, now);
      const rpm = this.num(`propulsion.${id}.revolutions`, now);
      const running = typeof state === 'string' ? !/stop|off/i.test(state) : rpm !== null ? rpm >= TRIGGERS.engineRunningHz : null;
      let e = this.engines.get(id);
      if (!e) {
        // The first reading is where we start from, not a change.
        this.engines.set(id, { confirmed: running, candidate: running, since: now });
        continue;
      }
      if (running === null) continue;
      if (e.confirmed === null) {
        e.confirmed = running;
        e.candidate = running;
        continue;
      }
      if (running !== e.candidate) {
        e.candidate = running;
        e.since = now;
      }
      if (e.candidate !== e.confirmed && now - e.since >= TRIGGERS.engineDebounceMs) {
        e.confirmed = e.candidate;
        this.event(running ? 'engine_start' : 'engine_stop', `${cap(id)} engine ${running ? 'started' : 'stopped'}`, this.logTimeAgo(now, e.since));
      }
    }
  }

  // Course change: the 5-minute average COG more than 30 degrees from the settled course, held 5 minutes.
  private courseTrigger(now: number): void {
    const cog = this.num('navigation.courseOverGroundTrue', now);
    const sog = this.num('navigation.speedOverGround', now);
    if (cog === null || sog === null || sog < TRIGGERS.courseMinSogMps) {
      this.cog = [];
      this.courseRef = null;
      this.courseHoldSince = null;
      return;
    }
    this.cog.push({ t: now, sin: Math.sin(cog), cos: Math.cos(cog) });
    while (this.cog.length > 0 && this.cog[0]!.t <= now - TRIGGERS.courseWindowMs) this.cog.shift();
    if (now - this.cog[0]!.t < TRIGGERS.courseWindowMs - 2000) return; // not a full window yet
    const s = this.cog.reduce((a, c) => a + c.sin, 0);
    const c = this.cog.reduce((a, x) => a + x.cos, 0);
    const avg = Math.atan2(s, c);
    if (this.courseRef === null) {
      this.courseRef = avg;
      return;
    }
    if (angleBetween(avg, this.courseRef) <= TRIGGERS.courseDeltaRad) {
      this.courseHoldSince = null;
      return;
    }
    this.courseHoldSince ??= now;
    if (now - this.courseHoldSince < TRIGGERS.courseHoldMs) return;
    const from = Math.round(radToDeg360(this.courseRef)) % 360;
    const to = Math.round(radToDeg360(avg)) % 360;
    this.event('course_change', `Course change ${String(from).padStart(3, '0')}°T to ${String(to).padStart(3, '0')}°T`);
    this.courseRef = avg;
    this.courseHoldSince = null;
  }

  // Wind change: TWS changing more than 10 kn within 60 minutes; at most one per hour.
  private windTrigger(now: number): void {
    const minute = Math.floor(now / MIN) * MIN;
    if (minute === this.lastWindMinute) return;
    this.lastWindMinute = minute;
    const tws = this.num('environment.wind.speedTrue', now);
    if (tws !== null) this.wind.push({ t: now, v: tws });
    while (this.wind.length > 0 && this.wind[0]!.t < now - TRIGGERS.windWindowMs) this.wind.shift();
    if (tws === null || now - this.lastWindEvent < TRIGGERS.windCooldownMs) return;
    let lo = this.wind[0]!;
    let hi = this.wind[0]!;
    for (const w of this.wind) {
      if (w.v < lo.v) lo = w;
      if (w.v > hi.v) hi = w;
    }
    if (hi.v - lo.v <= TRIGGERS.windDeltaMps) return;
    const rose = lo.t < hi.t;
    const [a, b] = rose ? [lo, hi] : [hi, lo];
    const mins = Math.max(1, Math.round((b.t - a.t) / MIN));
    this.event('wind_change', `TWS ${rose ? 'up' : 'down'} from ${this.fmt('speed', a.v)} to ${this.fmt('speed', b.v)} in ${mins} min`);
    this.lastWindEvent = now;
    this.wind = [{ t: now, v: tws }];
  }

  // Pressure drop: 3-hour tendency below -2 hPa; at most one per 3 hours.
  private pressureTrigger(now: number): void {
    const tendency = this.num(DERIVED.pressureTendency, now);
    if (tendency === null || tendency >= TRIGGERS.pressureDropPa) return;
    if (now - this.lastPressureEvent < TRIGGERS.pressureCooldownMs) return;
    this.lastPressureEvent = now;
    this.event('pressure_drop', `Barometer down ${this.fmt('pressure', -tendency)} in 3 h. Threshold ${this.fmt('pressure', -TRIGGERS.pressureDropPa)}.`);
  }

  // Passage auto-detection. Suggestions only; they never start or end a passage.
  private suggestions(now: number): void {
    const sog = this.num('navigation.speedOverGround', now);
    const active = this.deps.logbook.activePassage() !== null;
    const anchorDown = !!this.deps.store.fresh('navigation.anchor.position', now);
    const anchorDropped = this.anchorWasDown === false && anchorDown;
    this.anchorWasDown = anchorDown;

    if (sog !== null && sog > TRIGGERS.suggestStartSogMps) this.movingSince ??= now;
    else this.movingSince = null;
    if (sog !== null && sog < TRIGGERS.suggestEndSogMps) this.stoppedSince ??= now;
    else this.stoppedSince = null;

    const moving = this.movingSince !== null && now - this.movingSince >= TRIGGERS.suggestStartHoldMs;
    const stopped = this.stoppedSince !== null && now - this.stoppedSince >= TRIGGERS.suggestEndHoldMs;
    // Re-arm once the boat has clearly done the opposite.
    if (stopped) this.startArmed = true;
    if (moving) this.endArmed = true;

    if (!active && moving && this.startArmed) {
      this.startArmed = false;
      this.suggest('start', 'Moving at over 2 kn for 10 minutes');
    } else if (active && this.endArmed && (anchorDropped || stopped)) {
      this.endArmed = false;
      this.suggest('end', anchorDropped ? 'Anchor down' : 'Under 0.5 kn for 30 minutes');
    }
  }

  /** Raise a prompt. Public for the end-to-end test controls. */
  suggest(kind: 'start' | 'end', reason: string): void {
    this.suggestion = { kind, reason, at: iso(this.deps.time.read().now) };
    this.deps.hub.broadcast(kind === 'start' ? 'passage.suggestStart' : 'passage.suggestEnd', this.suggestion);
  }
}
