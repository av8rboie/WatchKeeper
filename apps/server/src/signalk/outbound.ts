// The only paths the app may write to Signal K. Never device paths, never
// anything that could reach the NMEA bus.

import { DERIVED_PATHS } from '@watchkeeper/shared';

const NOTIFICATION_RE = /^notifications\.app\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const DERIVED = new Set<string>(DERIVED_PATHS.map((d) => d.path));

export class OutboundPathError extends Error {
  constructor(public readonly path: string) {
    super(`Refusing to write Signal K path outside the allowlist: ${path}`);
    this.name = 'OutboundPathError';
  }
}

export function isAllowedOutbound(path: string): boolean {
  return NOTIFICATION_RE.test(path) || DERIVED.has(path);
}

export interface OutboundValue {
  path: string;
  value: unknown;
}

/** Build a Signal K delta, throwing if any path is not on the allowlist. */
export function buildDelta(values: OutboundValue[], timestamp: string) {
  for (const v of values) {
    if (!isAllowedOutbound(v.path)) throw new OutboundPathError(v.path);
  }
  return {
    context: 'vessels.self',
    updates: [{ $source: 'data-hub', timestamp, values }],
  };
}
