// Zod schemas shared by the API (request/response validation) and the UI.

import { z } from 'zod';

export const RoleSchema = z.enum(['skipper', 'crew', 'guest']);
export type Role = z.infer<typeof RoleSchema>;

/** Roles in ascending privilege. */
export const ROLE_RANK: Record<Role, number> = { guest: 0, crew: 1, skipper: 2 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export const UnitPrefsSchema = z.object({
  speed: z.enum(['kn', 'km/h', 'm/s']).default('kn'),
  depth: z.enum(['ft', 'm', 'fathoms']).default('ft'),
  distance: z.enum(['nm', 'km']).default('nm'),
  temperature: z.enum(['°F', '°C']).default('°F'),
  pressure: z.enum(['hPa', 'inHg', 'mbar']).default('hPa'),
  enginePressure: z.enum(['psi', 'bar', 'kPa']).default('psi'),
  volume: z.enum(['gal', 'L']).default('gal'),
  flow: z.enum(['gal/h', 'L/h']).default('gal/h'),
  heading: z.enum(['true', 'magnetic']).default('true'),
  windAngle: z.enum(['sided', 'signed']).default('sided'),
  position: z.enum(['ddm', 'dms', 'dd']).default('ddm'),
});
export type UnitPrefs = z.infer<typeof UnitPrefsSchema>;

/** US defaults, per the build spec. */
export const DEFAULT_UNIT_PREFS: UnitPrefs = UnitPrefsSchema.parse({});

const Pin = z.string().regex(/^\d{4,8}$/, 'PIN is 4 to 8 digits');

/**
 * The current user. `id` and `name` come from HA ingress. `actingAs` is set
 * when a guest device has elevated with a crew member's PIN.
 */
export const MeSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
  roleSource: z.enum(['mapped', 'unmapped', 'pin']),
  actingAs: z.object({ id: z.string(), name: z.string(), until: z.string() }).nullable(),
  unitPrefs: UnitPrefsSchema,
});
export type Me = z.infer<typeof MeSchema>;

/** An HA user as the skipper sees it on the role-mapping screen. */
export const UserMappingSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
  mapped: z.boolean(),
  hasPin: z.boolean(),
  lastSeen: z.string().nullable(),
});
export type UserMapping = z.infer<typeof UserMappingSchema>;

export const PutUsersSchema = z.object({
  users: z
    .array(
      z.object({
        id: z.string().min(1),
        role: RoleSchema,
        /** Set or replace the helm PIN; null removes it; omitted leaves it. */
        pin: Pin.nullable().optional(),
      }),
    )
    .min(1),
});

/** Users whose PIN may elevate a guest device to crew. */
export const PinUserSchema = z.object({ id: z.string(), name: z.string() });

export const PinElevateSchema = z.object({ userId: z.string().min(1), pin: Pin });

export const ErrorSchema = z.object({ error: z.string(), message: z.string().optional() });

export const PathInfoSchema = z.object({
  path: z.string(),
  label: z.string(),
  siUnit: z.string(),
  quantity: z.string(),
  rateClass: z.enum(['fast', 'medium', 'slow', 'verySlow']),
  /** Effective stale timeout in ms; null = never stale. */
  staleMs: z.number().nullable(),
  inCatalog: z.boolean(),
  /** Whether the backend subscribes to it, so live updates are available. */
  live: z.boolean(),
  /** Last SI value received (shown greyed when stale); null when never seen. */
  value: z.unknown().nullable(),
  /** Milliseconds since last update; null when never seen. */
  ageMs: z.number().nullable(),
  stale: z.boolean(),
});
export type PathInfo = z.infer<typeof PathInfoSchema>;

export const SystemStatusSchema = z.object({
  signalk: z.object({
    connected: z.boolean(),
    url: z.string(),
    since: z.string().nullable(),
    authorized: z.boolean(),
    accessRequest: z.enum(['approved', 'pending', 'denied', 'not-required', 'error', 'unknown']),
  }),
  gps: z.object({ fix: z.boolean(), ageMs: z.number().nullable() }),
  time: z.object({
    source: z.enum(['gps', 'host']),
    /** Best current time: GPS when fresh, otherwise the host clock. */
    now: z.string(),
    /** GPS minus host clock in ms; null when GPS time is stale. */
    driftMs: z.number().nullable(),
  }),
  cpuTempC: z.number().nullable(),
  disk: z.object({ freeBytes: z.number().nullable(), totalBytes: z.number().nullable() }),
  lastSnapshot: z.string().nullable(),
  passage: z.object({ active: z.boolean(), name: z.string().nullable() }),
  version: z.string(),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const HistoryQuerySchema = z.object({
  paths: z.string().min(1),
  from: z.string().datetime(),
  to: z.string().datetime(),
  maxPoints: z.coerce.number().int().min(2).max(10_000).default(500),
});

export const HistorySeriesSchema = z.object({
  path: z.string(),
  resolution: z.enum(['1s', '1m', '10m']),
  /** [epochMs, avg, min, max]; value columns null for gaps. */
  points: z.array(z.tuple([z.number(), z.number().nullable(), z.number().nullable(), z.number().nullable()])),
});
export type HistorySeries = z.infer<typeof HistorySeriesSchema>;

/** Inputs to derived values that Signal K doesn't provide. */
export const DerivedSettingsSchema = z.object({
  /** House bank capacity. Ships as a placeholder the skipper confirms. */
  houseCapacityAh: z.number().positive().max(10_000),
  /** Time to empty counts down to this state of charge (0 to 0.95). */
  floorSoc: z.number().min(0).max(0.95),
  confirmed: z.boolean(),
});
export type DerivedSettings = z.infer<typeof DerivedSettingsSchema>;

/** Server-to-client change events on /api/v1/events. */
export const EventTypeSchema = z.enum([
  'alarm.raised',
  'alarm.cleared',
  'alarm.acked',
  'log.created',
  'log.signed',
  'log.amended',
  'passage.suggestStart',
  'passage.suggestEnd',
  'passage.started',
  'passage.ended',
  'dashboard.updated',
  'task.statusChanged',
  'system.status',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export interface ServerEvent<T = unknown> {
  type: EventType;
  payload: T;
}

/** Client to server: replaces this client's live subscription. */
export const LiveSubscribeSchema = z.object({ type: z.literal('live.subscribe'), paths: z.array(z.string()).max(500) });

/** Server to client: changed values since the last batch, `[SI value, epoch ms]`. */
export interface LiveMessage {
  type: 'live';
  /**
   * Server time when sent. Browsers age values as (now - ts) plus local time
   * since receipt, so a phone with a wrong clock still judges staleness right.
   */
  now: number;
  values: Record<string, [unknown, number]>;
}

/** Most live batches a client receives per second. */
export const LIVE_MAX_HZ = 4;
