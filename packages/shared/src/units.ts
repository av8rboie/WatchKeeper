// SI in, user units out. Pure conversion functions keyed by quantity.
// Signal K values and everything stored are SI; convert only for display.

import type { Quantity } from './paths.js';
import type { UnitPrefs } from './schemas.js';

export interface Converter {
  /** Unit label shown beside the value. */
  unit: string;
  toDisplay(si: number): number;
  toSI(display: number): number;
}

const linear = (unit: string, factor: number, offset = 0): Converter => ({
  unit,
  toDisplay: (si) => si * factor + offset,
  toSI: (d) => (d - offset) / factor,
});

export const KNOT_MPS = 1852 / 3600;
export const FOOT_M = 0.3048;
export const FATHOM_M = 1.8288;
export const NM_M = 1852;
export const US_GALLON_M3 = 0.003785411784;
export const INHG_PA = 3386.389;
export const PSI_PA = 6894.757293168;

export const SPEED = {
  kn: linear('kn', 1 / KNOT_MPS),
  'km/h': linear('km/h', 3.6),
  'm/s': linear('m/s', 1),
} as const satisfies Record<string, Converter>;

export const DEPTH = {
  ft: linear('ft', 1 / FOOT_M),
  m: linear('m', 1),
  fathoms: linear('fathoms', 1 / FATHOM_M),
} as const satisfies Record<string, Converter>;

export const DISTANCE = {
  nm: linear('nm', 1 / NM_M),
  km: linear('km', 1 / 1000),
} as const satisfies Record<string, Converter>;

export const TEMPERATURE = {
  '°F': { unit: '°F', toDisplay: (k: number) => ((k - 273.15) * 9) / 5 + 32, toSI: (f: number) => ((f - 32) * 5) / 9 + 273.15 },
  '°C': { unit: '°C', toDisplay: (k: number) => k - 273.15, toSI: (c: number) => c + 273.15 },
} as const satisfies Record<string, Converter>;

export const PRESSURE = {
  hPa: linear('hPa', 1 / 100),
  inHg: linear('inHg', 1 / INHG_PA),
  mbar: linear('mbar', 1 / 100),
} as const satisfies Record<string, Converter>;

export const ENGINE_PRESSURE = {
  psi: linear('psi', 1 / PSI_PA),
  bar: linear('bar', 1 / 100_000),
  kPa: linear('kPa', 1 / 1000),
} as const satisfies Record<string, Converter>;

export const VOLUME = {
  gal: linear('gal', 1 / US_GALLON_M3),
  L: linear('L', 1000),
} as const satisfies Record<string, Converter>;

export const FLOW = {
  'gal/h': linear('gal/h', 3600 / US_GALLON_M3),
  'L/h': linear('L/h', 3600 * 1000),
} as const satisfies Record<string, Converter>;

export const RPM: Converter = linear('rpm', 60);
export const HOURS: Converter = linear('h', 1 / 3600);
export const PERCENT: Converter = linear('%', 100);
export const VOLTAGE: Converter = linear('V', 1);
export const CURRENT: Converter = linear('A', 1);
export const IDENTITY: Converter = linear('', 1);

const RAD_TO_DEG = 180 / Math.PI;

/** Radians to degrees normalized to [0, 360). */
export function radToDeg360(rad: number): number {
  const d = (rad * RAD_TO_DEG) % 360;
  return d < 0 ? d + 360 : d;
}

export function degToRad(deg: number): number {
  return deg / RAD_TO_DEG;
}

export type Side = 'PORT' | 'STBD';

/** Signed wind angle (negative to port, per Signal K) to 0..180 degrees plus side. */
export function windAngleToSided(rad: number): { deg: number; side: Side | null } {
  let d = rad * RAD_TO_DEG;
  // normalize to [-180, 180)
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  if (d === -180) d = 180;
  const side: Side | null = d === 0 || d === 180 ? null : d < 0 ? 'PORT' : 'STBD';
  return { deg: Math.abs(d), side };
}

export function sidedToWindAngle(deg: number, side: Side | null): number {
  return degToRad(side === 'PORT' ? -deg : deg);
}

export type PositionFormat = UnitPrefs['position'];

/** Format one coordinate. Degrees and decimal minutes is the default. */
export function formatCoordinate(deg: number, axis: 'lat' | 'lon', format: PositionFormat): string {
  const h = axis === 'lat' ? (deg < 0 ? 'S' : 'N') : deg < 0 ? 'W' : 'E';
  const a = Math.abs(deg);
  const width = axis === 'lat' ? 2 : 3;
  if (format === 'dd') return `${a.toFixed(5)}° ${h}`;
  let d = Math.floor(a);
  if (format === 'ddm') {
    let m = Number(((a - d) * 60).toFixed(3));
    if (m >= 60) {
      d += 1;
      m = 0;
    }
    return `${String(d).padStart(width, '0')}°${m.toFixed(3).padStart(6, '0')}′${h}`;
  }
  let totalSec = Number(((a - d) * 3600).toFixed(1));
  if (totalSec >= 3600) {
    d += 1;
    totalSec = 0;
  }
  const m = Math.floor(totalSec / 60);
  const sec = Number((totalSec - m * 60).toFixed(1));
  return `${String(d).padStart(width, '0')}°${String(m).padStart(2, '0')}′${sec.toFixed(1).padStart(4, '0')}″${h}`;
}

/** Parse a coordinate in any of the three formats back to signed decimal degrees. */
export function parseCoordinate(text: string): number {
  const t = text.trim();
  const hemiMatch = /[NSEW]$/i.exec(t);
  const sign = hemiMatch && /[SW]/i.test(hemiMatch[0]) ? -1 : 1;
  const nums = t.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) throw new Error(`Unparseable coordinate: ${text}`);
  const [d = 0, m = 0, s = 0] = nums.map(Number);
  return sign * (Math.abs(d) + m / 60 + s / 3600);
}

export function formatPosition(
  pos: { latitude: number; longitude: number },
  format: PositionFormat,
): { lat: string; lon: string } {
  return { lat: formatCoordinate(pos.latitude, 'lat', format), lon: formatCoordinate(pos.longitude, 'lon', format) };
}

/** The converter for a numeric quantity under the user's preferences. */
export function converterFor(quantity: Quantity, prefs: UnitPrefs): Converter {
  switch (quantity) {
    case 'speed':
      return SPEED[prefs.speed];
    case 'depth':
      return DEPTH[prefs.depth];
    case 'distance':
      return DISTANCE[prefs.distance];
    case 'temperature':
      return TEMPERATURE[prefs.temperature];
    case 'pressure':
      return PRESSURE[prefs.pressure];
    case 'enginePressure':
      return ENGINE_PRESSURE[prefs.enginePressure];
    case 'volume':
      return VOLUME[prefs.volume];
    case 'flow':
      return FLOW[prefs.flow];
    case 'rpm':
      return RPM;
    case 'hours':
      return HOURS;
    case 'percent':
      return PERCENT;
    case 'voltage':
      return VOLTAGE;
    case 'current':
      return CURRENT;
    case 'angle':
      return { unit: prefs.heading === 'magnetic' ? '°M' : '°T', toDisplay: radToDeg360, toSI: degToRad };
    case 'windAngle':
      return { unit: '°', toDisplay: (r) => r * RAD_TO_DEG, toSI: degToRad };
    default:
      return IDENTITY;
  }
}

const DEFAULT_DECIMALS: Partial<Record<Quantity, number>> = {
  speed: 1,
  depth: 1,
  distance: 1,
  temperature: 0,
  pressure: 0,
  enginePressure: 0,
  volume: 0,
  flow: 1,
  rpm: 0,
  hours: 1,
  percent: 0,
  voltage: 1,
  current: 1,
  angle: 0,
  windAngle: 0,
};

export interface Formatted {
  text: string;
  unit: string;
  /** PORT or STBD for sided wind angles. */
  side?: Side | null;
}

/** Format an SI value for display. A null (stale or missing) value formats as "--". */
export function formatValue(quantity: Quantity, si: unknown, prefs: UnitPrefs, decimals?: number): Formatted {
  if (si === null || si === undefined) return { text: '--', unit: converterFor(quantity, prefs).unit };
  if (quantity === 'position' && typeof si === 'object') {
    const p = formatPosition(si as { latitude: number; longitude: number }, prefs.position);
    return { text: `${p.lat} ${p.lon}`, unit: '' };
  }
  if (typeof si !== 'number') return { text: String(si), unit: '' };
  const dp = decimals ?? DEFAULT_DECIMALS[quantity] ?? 2;
  if (quantity === 'windAngle' && prefs.windAngle === 'sided') {
    const { deg, side } = windAngleToSided(si);
    return { text: deg.toFixed(dp), unit: '°', side };
  }
  const c = converterFor(quantity, prefs);
  const text = c.toDisplay(si).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return { text, unit: c.unit };
}
