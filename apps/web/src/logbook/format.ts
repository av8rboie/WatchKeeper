import {
  EVENT_LABELS,
  formatCoordinate,
  formatSnapshotValue,
  formatValue,
  type LogEntry,
  type Quantity,
  type UnitPrefs,
} from '@watchkeeper/shared';

// Display text for log entries, in the user's units.

export const hhmm = (iso: string) => iso.slice(11, 16);

/** "Today · Sun 18 Oct · UTC" */
export function dayLabel(dateKey: string, todayKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  const text = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${dateKey === todayKey ? 'Today · ' : ''}${text} · UTC`;
}

/** Coordinates as the mockup shows them: decimal minutes to one place, e.g. 32°41.2′N. */
export function compactCoord(deg: number, axis: 'lat' | 'lon', prefs: UnitPrefs): string {
  if (prefs.position !== 'ddm') return formatCoordinate(deg, axis, prefs.position);
  const h = axis === 'lat' ? (deg < 0 ? 'S' : 'N') : deg < 0 ? 'W' : 'E';
  const a = Math.abs(deg);
  let d = Math.floor(a);
  let m = Number(((a - d) * 60).toFixed(1));
  if (m >= 60) {
    d += 1;
    m = 0;
  }
  return `${d}°${m.toFixed(1).padStart(4, '0')}′${h}`;
}

const SPEEDS: Record<string, Quantity> = { sog: 'speed', stw: 'speed', tws: 'speed', pressure: 'pressure' };

/** Snapshot value with any amendment applied; null when it was stale or missing. */
export function shownValue(e: LogEntry, key: string, prefs: UnitPrefs, decimals?: number): string | null {
  const amended = e.current[`snapshot.${key}`];
  if (amended !== undefined) return amended;
  const v = e.snapshot[key];
  if (v === null || v === undefined) return null;
  const quantity = SPEEDS[key];
  if (decimals !== undefined && typeof v === 'number' && quantity) {
    const f = formatValue(quantity, v, prefs, decimals);
    return `${f.text} ${f.unit}`;
  }
  return formatSnapshotValue(key, v, prefs);
}

/** The two summary lines of an entry: where and how fast, then wind and barometer. */
export function snapshotLines(e: LogEntry, prefs: UnitPrefs): string[] {
  const s = e.snapshot;
  const nav: string[] = [];
  const lat = e.current['snapshot.lat'] ?? (typeof s.lat === 'number' ? compactCoord(s.lat, 'lat', prefs) : null);
  const lon = e.current['snapshot.lon'] ?? (typeof s.lon === 'number' ? compactCoord(s.lon, 'lon', prefs) : null);
  if (lat && lon) nav.push(`${lat} ${lon}`);
  const cog = shownValue(e, 'cog', prefs);
  if (cog) nav.push(`COG ${cog}`);
  const sog = shownValue(e, 'sog', prefs, 1);
  if (sog) nav.push(`SOG ${sog}`);

  const met: string[] = [];
  const tws = shownValue(e, 'tws', prefs, 0);
  const twd = shownValue(e, 'twd', prefs);
  if (tws) met.push(`TWS ${tws}${twd ? ` from ${twd}` : ''}`);
  const p = shownValue(e, 'pressure', prefs, 0);
  if (p) {
    const t = s.pressureTendency;
    const trend = typeof t === 'number' && t <= -100 ? ', falling' : typeof t === 'number' && t >= 100 ? ', rising' : '';
    met.push(`${p}${trend}`);
  }
  return [nav.join(' · '), met.join(' · ')].filter(Boolean);
}

/** Crew fields line: "1 reef, full jib · Sea 1–2 m · Overcast". */
export function crewLine(e: LogEntry): string {
  const c = (k: string) => e.current[`crew.${k}`];
  return [c('sailPlan'), c('seaState') ? `Sea ${c('seaState')}` : null, c('sky'), c('visibility') ? `Vis ${c('visibility')}` : null]
    .filter(Boolean)
    .join(' · ');
}

/** "HOURLY", "EVENT · PRESSURE", "MANUAL · REEF IN". */
export function entryHeading(e: LogEntry): string {
  const kind = e.kind.toUpperCase();
  if (!e.eventType) return kind;
  return `${kind} · ${(EVENT_LABELS[e.eventType] ?? e.eventType.replace(/_/g, ' ')).toUpperCase()}`;
}

export type EntryTone = 'accent' | 'warn' | 'ink';

/** Hourly entries in the accent color, automatic events in warn, people's entries in ink. */
export function entryTone(e: LogEntry): EntryTone {
  if (e.kind === 'hourly') return 'accent';
  if (e.kind === 'event' || e.kind === 'system' || e.kind === 'anchor') return 'warn';
  return 'ink';
}

export function signatureLabel(e: LogEntry): { text: string; tone: 'warn' | 'good' } {
  if (!e.signedAt) return { text: 'UNSIGNED', tone: 'warn' };
  return { text: e.amendments.length > 0 ? 'SIGNED · AMENDED' : 'SIGNED', tone: 'good' };
}

export function fmtDistance(m: number | null, prefs: UnitPrefs): string {
  if (m === null) return '--';
  const f = formatValue('distance', m, prefs, 0);
  return `${f.text} ${f.unit}`;
}

export function fmtSpeed(mps: number | null, prefs: UnitPrefs): string {
  if (mps === null) return '--';
  const f = formatValue('speed', mps, prefs, 1);
  return `${f.text} ${f.unit}`;
}

export function fmtHours(s: number | null): string {
  return s === null ? '--' : `${(s / 3600).toFixed(1)} h`;
}
