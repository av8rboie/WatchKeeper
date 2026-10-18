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

export const UserPublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

export const MeSchema = UserPublicSchema.extend({ unitPrefs: UnitPrefsSchema });
export type Me = z.infer<typeof MeSchema>;

export const LoginRequestSchema = z.object({ userId: z.string().min(1), pin: Pin });
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const CreateUserSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: RoleSchema,
  pin: Pin,
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  role: RoleSchema.optional(),
  pin: Pin.optional(),
});

export const SetupSkipperSchema = z.object({ name: z.string().trim().min(1).max(60), pin: Pin });

export const ErrorSchema = z.object({ error: z.string(), message: z.string().optional() });

export const PathInfoSchema = z.object({
  path: z.string(),
  label: z.string(),
  siUnit: z.string(),
  quantity: z.string(),
  staleMs: z.number().nullable(),
  inCatalog: z.boolean(),
  /** Current SI value; null when stale or never seen. */
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
  }),
  gps: z.object({ fix: z.boolean(), ageMs: z.number().nullable() }),
  clock: z.object({ synced: z.boolean().nullable(), source: z.string().nullable(), offsetMs: z.number().nullable() }),
  disk: z.object({ freeBytes: z.number().nullable(), totalBytes: z.number().nullable() }),
  lastBackup: z.string().nullable(),
  passage: z.object({ active: z.boolean(), name: z.string().nullable() }),
  serverTime: z.string(),
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

/** Server-to-client events on /api/v1/events. */
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
