import { DEFAULT_INSTANCE_IDS, distanceM, isLatLon, normalizeRad, type DerivedSettings, type InstanceIds, type LatLon } from '@watchkeeper/shared';
import type { Clock } from '../clock.js';
import { getSetting, setSetting, type DB } from '../db/index.js';
import type { OutboundValue } from '../signalk/outbound.js';
import type { LiveStore } from '../signalk/store.js';

export const DERIVED = {
  totalFuelRate: 'dataHub.fuel.totalRate',
  fuelRange: 'dataHub.fuel.range',
  netCurrent: 'dataHub.electrical.netCurrent',
  timeToEmpty: 'dataHub.electrical.timeToEmpty',
  distanceRun: 'dataHub.navigation.distanceRun',
  run24h: 'dataHub.navigation.run24h',
  setTrue: 'dataHub.environment.current.setTrue',
  drift: 'dataHub.environment.current.drift',
  pressureTendency: 'dataHub.environment.pressureTendency',
} as const;

/** The house bank capacity is a placeholder until the skipper confirms it in settings. */
export const DEFAULT_DERIVED_SETTINGS: DerivedSettings = { houseCapacityAh: 400, floorSoc: 0.5, confirmed: false };

/** Position jumps faster than this are GPS glitches, not distance run (1 nm in 1 s). */
const MAX_JUMP_MPS = 1852;
const HOUR = 3_600_000;

interface DistanceState {
  m: number;
  last: (LatLon & { t: number }) | null;
}

/**
 * Values computed in the backend at 1 Hz, put in the live store (so they're
 * recorded and streamed like any path) and published to Signal K under
 * dataHub.*. A value whose inputs are stale or missing isn't computed, so it
 * goes stale too.
 */
export class DerivedEngine {
  private timer: NodeJS.Timeout | null = null;
  private dist: DistanceState;
  private lastSaved = 0;
  private readonly cache = new Map<string, { value: number | null; at: number }>();

  constructor(
    private readonly db: DB,
    private readonly store: LiveStore,
    private readonly clock: Clock,
    private readonly sendToSignalK?: (values: OutboundValue[]) => void,
  ) {
    this.dist = getSetting<DistanceState>(db, 'distanceRun', { m: 0, last: null });
  }

  start(): void {
    const loop = () => {
      this.tick();
      this.timer = setTimeout(loop, 1000 - (Date.now() % 1000) + 20);
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.saveDistance();
  }

  /** Compute everything once. Returns what was computed (null = inputs stale or missing). */
  tick(now = this.clock.now()): Record<string, number | null> {
    const battery = this.ids().batteries[0] ?? 'house';
    const current = this.num(`electrical.batteries.${battery}.current`, now);
    const rate = this.totalFuelRate(now);
    const sd = this.setAndDrift(now);
    const out: Record<string, number | null> = {
      [DERIVED.totalFuelRate]: rate,
      [DERIVED.fuelRange]: this.fuelRange(now, rate),
      // The shunt sits on the battery negative, so its current is already net.
      [DERIVED.netCurrent]: current,
      [DERIVED.timeToEmpty]: this.timeToEmpty(current, this.num(`electrical.batteries.${battery}.capacity.stateOfCharge`, now)),
      [DERIVED.distanceRun]: this.distanceRun(now),
      [DERIVED.setTrue]: sd?.set ?? null,
      [DERIVED.drift]: sd?.drift ?? null,
      [DERIVED.pressureTendency]: this.every(DERIVED.pressureTendency, 30_000, now, () => this.pressureTendency(now)),
      [DERIVED.run24h]: this.every(DERIVED.run24h, 60_000, now, () => this.run24h(now)),
    };

    const outbound: OutboundValue[] = [];
    for (const [path, value] of Object.entries(out)) {
      if (value === null) continue;
      this.store.update(path, value, now);
      outbound.push({ path, value });
    }
    if (outbound.length > 0) {
      try {
        this.sendToSignalK?.(outbound);
      } catch {
        // Not connected; the values are still recorded and shown.
      }
    }
    return out;
  }

  settings(): DerivedSettings {
    return { ...DEFAULT_DERIVED_SETTINGS, ...getSetting<Partial<DerivedSettings>>(this.db, 'derived', {}) };
  }

  private ids(): InstanceIds {
    return getSetting<InstanceIds>(this.db, 'instanceIds', DEFAULT_INSTANCE_IDS);
  }

  private num(path: string, now: number): number | null {
    const v = this.store.fresh(path, now);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /** Run `fn` at most every `periodMs`; the cached result is republished in between. */
  private every(key: string, periodMs: number, now: number, fn: () => number | null): number | null {
    const c = this.cache.get(key);
    if (c && now - c.at < periodMs) return c.value;
    const value = fn();
    this.cache.set(key, { value, at: now });
    return value;
  }

  /** Sum of propulsion.*.fuel.rate, m³/s. */
  private totalFuelRate(now: number): number | null {
    const rates = this.store
      .paths()
      .filter((p) => /^propulsion\.[^.]+\.fuel\.rate$/.test(p))
      .map((p) => this.num(p, now))
      .filter((v): v is number => v !== null);
    return rates.length > 0 ? rates.reduce((a, b) => a + b, 0) : null;
  }

  /** Fuel aboard in m³: each fuel tank's volume, or level × capacity. */
  fuelVolume(now: number): number | null {
    const ids = new Set(
      this.store
        .paths()
        .map((p) => /^tanks\.fuel\.([^.]+)\.(currentLevel|currentVolume)$/.exec(p)?.[1])
        .filter((x): x is string => !!x),
    );
    let total = 0;
    let any = false;
    for (const id of ids) {
      const volume = this.num(`tanks.fuel.${id}.currentVolume`, now);
      const level = this.num(`tanks.fuel.${id}.currentLevel`, now);
      // Capacity is static configuration: any value seen counts.
      const capacity = this.store.read(`tanks.fuel.${id}.capacity`, now).value;
      const v = volume ?? (level !== null && typeof capacity === 'number' ? level * capacity : null);
      if (v !== null) {
        total += v;
        any = true;
      }
    }
    return any ? total : null;
  }

  /** Fuel range, metres: fuel volume ÷ total fuel rate × SOG. */
  private fuelRange(now: number, rate: number | null): number | null {
    const sog = this.num('navigation.speedOverGround', now);
    const volume = this.fuelVolume(now);
    if (rate === null || rate <= 0 || sog === null || volume === null) return null;
    return (volume / rate) * sog;
  }

  /** Seconds until the floor state of charge at the present discharge current; only while discharging. */
  private timeToEmpty(current: number | null, soc: number | null): number | null {
    if (current === null || soc === null || current >= 0) return null;
    const s = this.settings();
    return (Math.max(0, soc - s.floorSoc) * s.houseCapacityAh * 3600) / -current;
  }

  /** Cumulative great-circle distance, metres, ignoring jumps over 1 nm in 1 s. Persists across restarts. */
  private distanceRun(now: number): number {
    const p = this.store.fresh('navigation.position', now);
    if (isLatLon(p)) {
      const last = this.dist.last;
      if (last) {
        const d = distanceM(last, p);
        const dt = Math.max(1, (now - last.t) / 1000);
        if (d / dt <= MAX_JUMP_MPS) this.dist.m += d;
      }
      this.dist.last = { latitude: p.latitude, longitude: p.longitude, t: now };
    }
    if (now - this.lastSaved >= 60_000) this.saveDistance(now);
    return this.dist.m;
  }

  private saveDistance(now = this.clock.now()): void {
    setSetting(this.db, 'distanceRun', this.dist);
    this.lastSaved = now;
  }

  /** Vector difference of COG/SOG and heading/STW, when all four are fresh. */
  private setAndDrift(now: number): { set: number; drift: number } | null {
    const cog = this.num('navigation.courseOverGroundTrue', now);
    const sog = this.num('navigation.speedOverGround', now);
    const hdg = this.num('navigation.headingTrue', now);
    const stw = this.num('navigation.speedThroughWater', now);
    if (cog === null || sog === null || hdg === null || stw === null) return null;
    const e = sog * Math.sin(cog) - stw * Math.sin(hdg);
    const n = sog * Math.cos(cog) - stw * Math.cos(hdg);
    return { set: normalizeRad(Math.atan2(e, n)), drift: Math.hypot(e, n) };
  }

  /** Recorded 1-minute average of `path` nearest to `at`, within ± `tolMs`. */
  private historyAt(path: string, at: number, tolMs: number): number | null {
    const row = this.db
      .prepare('SELECT avg FROM sample_1m WHERE path = ? AND ts BETWEEN ? AND ? AND avg IS NOT NULL ORDER BY ABS(ts - ?) LIMIT 1')
      .get(path, at - tolMs, at + tolMs, at) as { avg: number } | undefined;
    return row?.avg ?? null;
  }

  /** Change in outside pressure over the last 3 h, Pa. Needs 3 h of history. */
  private pressureTendency(now: number): number | null {
    const p = this.num('environment.outside.pressure', now);
    const then = this.historyAt('environment.outside.pressure', now - 3 * HOUR, 5 * 60_000);
    return p === null || then === null ? null : p - then;
  }

  /** Distance run over the trailing 24 h, from the recorded distance run (or since recording began). */
  private run24h(now: number): number | null {
    const row = this.db
      .prepare('SELECT avg FROM sample_1m WHERE path = ? AND ts >= ? AND avg IS NOT NULL ORDER BY ts LIMIT 1')
      .get(DERIVED.distanceRun, now - 24 * HOUR) as { avg: number } | undefined;
    return row ? Math.max(0, this.dist.m - row.avg) : null;
  }
}
