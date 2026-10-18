import { z } from 'zod';
import { describePath, type Quantity } from './paths.js';
import type { UnitPrefs } from './schemas.js';
import { formatCoordinate, formatValue } from './units.js';

// Logbook: passages, append-only entries, amendments. Snapshots hold raw SI
// values keyed by the flat names below; stale or missing values are null.

export const LOG_KINDS = ['hourly', 'event', 'manual', 'anchor', 'checklist', 'system'] as const;
export const LogKindSchema = z.enum(LOG_KINDS);
export type LogKind = z.infer<typeof LogKindSchema>;

/** A snapshot value: SI number, state string, or null when stale or missing. */
export type SnapshotValue = number | string | null;
export type Snapshot = Record<string, SnapshotValue>;

interface SnapshotFieldDef {
  label: string;
  quantity: Quantity | 'latitude' | 'longitude';
}

/** Fixed snapshot fields, in display and CSV order. Engine and tank fields follow, per instance. */
export const SNAPSHOT_FIELDS: Readonly<Record<string, SnapshotFieldDef>> = {
  lat: { label: 'Latitude', quantity: 'latitude' },
  lon: { label: 'Longitude', quantity: 'longitude' },
  cog: { label: 'COG', quantity: 'angle' },
  sog: { label: 'SOG', quantity: 'speed' },
  heading: { label: 'Heading', quantity: 'angle' },
  stw: { label: 'STW', quantity: 'speed' },
  distanceHour: { label: 'Distance this hour', quantity: 'distance' },
  distancePassage: { label: 'Distance since departure', quantity: 'distance' },
  tws: { label: 'TWS', quantity: 'speed' },
  twd: { label: 'TWD', quantity: 'angle' },
  awa: { label: 'AWA', quantity: 'windAngle' },
  pressure: { label: 'Barometer', quantity: 'pressure' },
  pressureTendency: { label: 'Pressure tendency (3 h)', quantity: 'pressure' },
  airTemp: { label: 'Air temp', quantity: 'temperature' },
  waterTemp: { label: 'Water temp', quantity: 'temperature' },
  depth: { label: 'Depth below keel', quantity: 'depth' },
  houseVoltage: { label: 'House voltage', quantity: 'voltage' },
  houseSoc: { label: 'House SoC', quantity: 'percent' },
  solarCurrent: { label: 'Solar current', quantity: 'current' },
  autopilot: { label: 'Autopilot', quantity: 'state' },
};

/** Snapshot keys that are bookkeeping, not observations. */
export const SNAPSHOT_META_KEYS = ['clockSource', 'distanceTotal'] as const;

const cap = (v: string) => (v ? v[0]!.toUpperCase() + v.slice(1) : v);

/** Label and quantity for any snapshot key, including engine.<id>.* and tank.<type>.<id>.level. */
export function describeSnapshotKey(key: string): SnapshotFieldDef {
  const fixed = SNAPSHOT_FIELDS[key];
  if (fixed) return fixed;
  const engine = /^engine\.([^.]+)\.(state|rpm|hours)$/.exec(key);
  if (engine) {
    const id = engine[1]!;
    const f = engine[2] as 'state' | 'rpm' | 'hours';
    const quantity: Quantity = f === 'rpm' ? 'rpm' : f === 'hours' ? 'hours' : 'state';
    return { label: `${cap(id)} engine ${f === 'rpm' ? 'RPM' : f}`, quantity };
  }
  const tank = /^tank\.([^.]+)\.([^.]+)\.level$/.exec(key);
  if (tank) return { label: `${cap(tank[1]!)} tank ${tank[2]}`, quantity: 'percent' };
  // Anything else is a Signal K path (e.g. the value an alarm entry records).
  const d = describePath(key);
  return { label: d.label, quantity: d.quantity };
}

/** Snapshot keys in display order: fixed fields, then engines, then tanks. */
export function orderedSnapshotKeys(keys: Iterable<string>): string[] {
  const all = new Set(keys);
  for (const m of SNAPSHOT_META_KEYS) all.delete(m);
  const fixed = Object.keys(SNAPSHOT_FIELDS).filter((k) => all.has(k));
  const rest = [...all].filter((k) => !(k in SNAPSHOT_FIELDS)).sort();
  return [...fixed, ...rest.filter((k) => k.startsWith('engine.')), ...rest.filter((k) => !k.startsWith('engine.'))];
}

// Crew fields: filled by people, carried forward from the previous entry.

export const SEA_STATES = ['< 1 m', '1–2 m', '2–3 m', '3 m +'] as const;
export const CREW_FIELD_KEYS = ['seaState', 'sky', 'visibility', 'sailPlan', 'watchKeeper'] as const;
export type CrewFieldKey = (typeof CREW_FIELD_KEYS)[number];
export const CREW_FIELD_LABELS: Record<CrewFieldKey, string> = {
  seaState: 'Sea state',
  sky: 'Sky',
  visibility: 'Visibility',
  sailPlan: 'Sail plan',
  watchKeeper: 'Watch keeper',
};

export const CrewFieldsSchema = z
  .object({
    seaState: z.string().max(40),
    sky: z.string().max(80),
    visibility: z.string().max(80),
    sailPlan: z.string().max(120),
    watchKeeper: z.string().max(80),
  })
  .partial();
export type CrewFields = z.infer<typeof CrewFieldsSchema>;

/** Quick-entry event choices (the mockup's grid). */
export const QUICK_EVENTS = [
  { id: 'reef_in', label: 'Reef in' },
  { id: 'reef_out', label: 'Reef out' },
  { id: 'sail_change', label: 'Sail change' },
  { id: 'engine', label: 'Engine start/stop' },
  { id: 'vessel_sighted', label: 'Vessel sighted' },
  { id: 'gear_issue', label: 'Gear issue' },
  { id: 'weather_note', label: 'Weather note' },
  { id: 'other', label: 'Other' },
] as const;

/** Display names for event types written by the backend and by people. */
export const EVENT_LABELS: Record<string, string> = {
  ...Object.fromEntries(QUICK_EVENTS.map((e) => [e.id, e.label])),
  engine_start: 'Engine start',
  engine_stop: 'Engine stop',
  course_change: 'Course change',
  wind_change: 'Wind change',
  pressure_drop: 'Pressure',
  alarm_raised: 'Alarm',
  alarm_acked: 'Alarm acknowledged',
  alarm_snoozed: 'Alarm snoozed',
  passage_start: 'Passage start',
  passage_end: 'Passage end',
  offline: 'Offline',
  anchor_drop: 'Anchor down',
  anchor_lift: 'Anchor up',
};

// Passages

export const PassageInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fromPlace: z.string().trim().max(120).nullable().default(null),
  toPlace: z.string().trim().max(120).nullable().default(null),
  crew: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});
export type PassageInput = z.input<typeof PassageInputSchema>;

export const PassageSchema = z.object({
  id: z.string(),
  name: z.string(),
  fromPlace: z.string().nullable(),
  toPlace: z.string().nullable(),
  skipperId: z.string().nullable(),
  crew: z.array(z.string()),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type Passage = z.infer<typeof PassageSchema>;

export const PassageSummarySchema = z.object({
  passage: PassageSchema,
  /** Day of the passage, 1-based, by UTC date. */
  day: z.number().int(),
  /** Metres since departure; null without a distance source. */
  distanceM: z.number().nullable(),
  /** Mean SOG over the elapsed time, m/s. */
  avgSogMps: z.number().nullable(),
  /** Engine running time during the passage, seconds, summed over engines. */
  engineS: z.number().nullable(),
  entries: z.number().int(),
  unsigned: z.number().int(),
  /** Downsampled track, [lat, lon] in degrees. */
  track: z.array(z.tuple([z.number(), z.number()])),
});
export type PassageSummary = z.infer<typeof PassageSummarySchema>;

/** The current auto-detection prompt, if any. Suggestions never start or end a passage on their own. */
export const PassageSuggestionSchema = z.object({
  kind: z.enum(['start', 'end']),
  reason: z.string(),
  at: z.string(),
});
export type PassageSuggestion = z.infer<typeof PassageSuggestionSchema>;

// Entries

export const AmendmentSchema = z.object({
  id: z.string(),
  field: z.string(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  reason: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  ts: z.string(),
});
export type Amendment = z.infer<typeof AmendmentSchema>;

export const LogEntrySchema = z.object({
  id: z.string(),
  passageId: z.string().nullable(),
  ts: z.string(),
  kind: LogKindSchema,
  eventType: z.string().nullable(),
  /** As written. Never changes. */
  snapshot: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  crewFields: CrewFieldsSchema,
  /** Crew fields copied from the previous entry rather than entered for this one. */
  carried: z.array(z.string()),
  remarks: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  signedBy: z.string().nullable(),
  signedByName: z.string().nullable(),
  signedAt: z.string().nullable(),
  amendments: z.array(AmendmentSchema),
  /** Values with amendments applied, keyed like amendment fields (remarks, crew.<key>, snapshot.<key>). */
  current: z.record(z.string(), z.string().nullable()),
  attachments: z.array(z.object({ id: z.string(), mime: z.string(), caption: z.string().nullable() })),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const ManualEntryInputSchema = z.object({
  eventType: z.string().trim().min(1).max(40).nullable().default(null),
  crewFields: CrewFieldsSchema.default({}),
  remarks: z.string().trim().max(4000).nullable().default(null),
});
export type ManualEntryInput = z.input<typeof ManualEntryInputSchema>;

/** Amendable fields: remarks, crew.<key>, snapshot.<key>. */
export const AMEND_FIELD_RE = /^(remarks|crew\.(seaState|sky|visibility|sailPlan|watchKeeper)|snapshot\.[A-Za-z0-9_.]+)$/;

export const AmendInputSchema = z.object({
  field: z.string().regex(AMEND_FIELD_RE, 'not an amendable field'),
  newValue: z.string().max(4000).nullable(),
  reason: z.string().trim().min(1, 'a reason is required').max(500),
});
export type AmendInput = z.infer<typeof AmendInputSchema>;

export const LogQuerySchema = z.object({
  passageId: z.string().optional(),
  kind: z.enum([...LOG_KINDS, 'events']).optional(),
  unsigned: z.enum(['true', 'false']).optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Field label for an amendment field key. */
export function amendFieldLabel(field: string): string {
  if (field === 'remarks') return 'Remarks';
  if (field.startsWith('crew.')) return CREW_FIELD_LABELS[field.slice(5) as CrewFieldKey] ?? field;
  if (field.startsWith('snapshot.')) return describeSnapshotKey(field.slice(9)).label;
  return field;
}

/** One snapshot value as display text in the user's units, e.g. "7.4 kn", "32°41.200′N", "--". */
export function formatSnapshotValue(key: string, value: SnapshotValue | undefined, prefs: UnitPrefs): string {
  if (value === null || value === undefined) return '--';
  const { quantity } = describeSnapshotKey(key);
  if (quantity === 'latitude' || quantity === 'longitude') {
    return typeof value === 'number' ? formatCoordinate(value, quantity === 'latitude' ? 'lat' : 'lon', prefs.position) : String(value);
  }
  const f = formatValue(quantity, value, prefs);
  return `${f.text}${f.unit && f.unit !== '°' && !f.unit.startsWith('°') ? ' ' : ''}${f.unit}${f.side ? ` ${f.side}` : ''}`;
}

/** A snapshot value converted to the user's units for CSV: a number, or text for states and positions. */
export function snapshotValueForCsv(key: string, value: SnapshotValue | undefined, prefs: UnitPrefs): { value: string; unit: string } {
  const { quantity } = describeSnapshotKey(key);
  if (quantity === 'latitude' || quantity === 'longitude') return { value: typeof value === 'number' ? value.toFixed(6) : '', unit: 'deg' };
  if (quantity === 'state' || quantity === 'text') return { value: value === null || value === undefined ? '' : String(value), unit: '' };
  const f = formatValue(quantity, typeof value === 'number' ? value : null, prefs);
  return { value: typeof value === 'number' ? f.text.replace(/,/g, '') : '', unit: f.unit };
}
