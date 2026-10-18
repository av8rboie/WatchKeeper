// Spherical geometry for positions in degrees and angles in radians.

/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_M = 6_371_008.8;

const RAD = Math.PI / 180;

export interface LatLon {
  latitude: number;
  longitude: number;
}

export function isLatLon(v: unknown): v is LatLon {
  const p = v as LatLon | null;
  return !!p && typeof p.latitude === 'number' && typeof p.longitude === 'number' && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = (b.latitude - a.latitude) * RAD;
  const dLon = (b.longitude - a.longitude) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * RAD) * Math.cos(b.latitude * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing from a to b, radians 0 to 2π. */
export function bearingRad(a: LatLon, b: LatLon): number {
  const φ1 = a.latitude * RAD;
  const φ2 = b.latitude * RAD;
  const Δλ = (b.longitude - a.longitude) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeRad(Math.atan2(y, x));
}

/** The point `distance` metres from `from` on true bearing `bearing` (radians). */
export function destination(from: LatLon, bearing: number, distance: number): LatLon {
  const δ = distance / EARTH_RADIUS_M;
  const φ1 = from.latitude * RAD;
  const λ1 = from.longitude * RAD;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearing));
  const λ2 = λ1 + Math.atan2(Math.sin(bearing) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { latitude: φ2 / RAD, longitude: ((λ2 / RAD + 540) % 360) - 180 };
}

/** Angle in [0, 2π). */
export function normalizeRad(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

/** Angle in (−π, π]. */
export function signedRad(a: number): number {
  const t = normalizeRad(a);
  return t > Math.PI ? t - 2 * Math.PI : t;
}
