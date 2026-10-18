import type { Clock } from '../clock.js';
import type { LiveStore } from './store.js';

export const GPS_TIME_PATH = 'navigation.datetime';
/** GPS and host clocks further apart than this raise a warning. */
export const MAX_DRIFT_MS = 5_000;

export interface TimeReading {
  source: 'gps' | 'host';
  /** Best current time in epoch ms. */
  now: number;
  /** GPS minus host in ms; null when GPS time is stale. */
  driftMs: number | null;
}

/**
 * Log time comes from GPS (Signal K's navigation.datetime), not the host
 * clock: offshore, HAOS has no time source. Between updates the GPS time is
 * extrapolated from when it was received.
 */
export class TimeSource {
  constructor(
    private readonly store: LiveStore,
    private readonly clock: Clock,
  ) {}

  read(): TimeReading {
    const host = this.clock.now();
    const r = this.store.read(GPS_TIME_PATH, host);
    const gps = typeof r.value === 'string' ? Date.parse(r.value) : NaN;
    if (r.stale || r.updatedAt === null || Number.isNaN(gps)) return { source: 'host', now: host, driftMs: null };
    const now = gps + (host - r.updatedAt);
    return { source: 'gps', now, driftMs: now - host };
  }
}
