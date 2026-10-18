// Dashboards: widgets, per-breakpoint grid layouts, and the auto-placement
// rule shared by the backend (starter dashboards, import) and the UI.

import { z } from 'zod';

export const BREAKPOINTS = ['phone', 'tablet', 'desktop'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Grid columns per breakpoint, from the build spec. */
export const BREAKPOINT_COLS: Record<Breakpoint, number> = { phone: 2, tablet: 6, desktop: 12 };

/** Smallest viewport width (px) for each breakpoint. */
export const BREAKPOINT_MIN_WIDTH: Record<Breakpoint, number> = { phone: 0, tablet: 600, desktop: 1024 };

/** Grid row height in px; a tile of h = 1 fits label, value and a sub line (the mockup's 104 px tile plus room for glyph overhang). */
export const GRID_ROW_PX = 112;

export function breakpointFor(width: number): Breakpoint {
  if (width >= BREAKPOINT_MIN_WIDTH.desktop) return 'desktop';
  if (width >= BREAKPOINT_MIN_WIDTH.tablet) return 'tablet';
  return 'phone';
}

export const WIDGET_TYPES = ['numeric', 'gauge', 'wind', 'heading', 'depth', 'trend', 'twin', 'battery', 'tank', 'position', 'text', 'clock', 'link'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const LayoutItemSchema = z.object({
  i: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export type LayoutItem = z.infer<typeof LayoutItemSchema>;

export const LayoutsSchema = z.object({
  phone: z.array(LayoutItemSchema).default([]),
  tablet: z.array(LayoutItemSchema).default([]),
  desktop: z.array(LayoutItemSchema).default([]),
});
export type Layouts = z.infer<typeof LayoutsSchema>;

/** Signal K paths are dotted identifiers; nothing else may be bound to a widget. */
const PathString = z.string().regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, 'Not a Signal K path');

export const WidgetSchema = z.object({
  id: z.string().min(1),
  type: z.enum(WIDGET_TYPES),
  label: z.string().max(80).nullable(),
  path: PathString.nullable(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type Widget = z.infer<typeof WidgetSchema>;

export const DashboardSchema = z.object({
  id: z.string(),
  name: z.string(),
  sort: z.number().int(),
  layouts: LayoutsSchema,
  widgets: z.array(WidgetSchema),
  updatedAt: z.string(),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export const DashboardSummarySchema = DashboardSchema.pick({ id: true, name: true, sort: true, updatedAt: true });
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

/** Create or replace a dashboard. Widget ids are kept when given, so layouts stay attached. */
export const DashboardInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  sort: z.number().int().optional(),
  layouts: LayoutsSchema.optional(),
  widgets: z.array(WidgetSchema.extend({ id: z.string().min(1).optional() })).max(60).default([]),
});
export type DashboardInput = z.input<typeof DashboardInputSchema>;

/** Replace the layouts for the breakpoints given; the others are untouched. */
export const PutLayoutsSchema = z.object({
  layouts: z
    .object({ phone: z.array(LayoutItemSchema), tablet: z.array(LayoutItemSchema), desktop: z.array(LayoutItemSchema) })
    .partial(),
});

export const DASHBOARD_EXPORT_FORMAT = 'data-hub-dashboard';

export const DashboardExportSchema = z.object({
  format: z.literal(DASHBOARD_EXPORT_FORMAT),
  version: z.literal(1),
  dashboard: DashboardInputSchema.extend({ layouts: LayoutsSchema }),
});
export type DashboardExport = z.infer<typeof DashboardExportSchema>;

/** Default widget size per breakpoint, [w, h] in grid units. */
const SIZE: Record<WidgetType, Record<Breakpoint, [number, number]>> = {
  numeric: { phone: [1, 1], tablet: [2, 1], desktop: [3, 1] },
  gauge: { phone: [1, 2], tablet: [2, 2], desktop: [3, 2] },
  wind: { phone: [2, 2], tablet: [3, 2], desktop: [4, 2] },
  heading: { phone: [1, 1], tablet: [2, 1], desktop: [3, 1] },
  depth: { phone: [1, 1], tablet: [2, 1], desktop: [3, 1] },
  trend: { phone: [2, 2], tablet: [6, 2], desktop: [6, 2] },
  twin: { phone: [2, 2], tablet: [3, 2], desktop: [4, 2] },
  battery: { phone: [1, 1], tablet: [2, 1], desktop: [3, 1] },
  tank: { phone: [1, 2], tablet: [2, 2], desktop: [2, 2] },
  position: { phone: [2, 1], tablet: [3, 1], desktop: [4, 1] },
  text: { phone: [1, 1], tablet: [2, 1], desktop: [3, 1] },
  clock: { phone: [1, 1], tablet: [2, 1], desktop: [2, 1] },
  link: { phone: [1, 1], tablet: [2, 1], desktop: [2, 1] },
};

export function defaultSize(type: WidgetType, bp: Breakpoint): { w: number; h: number } {
  const [w, h] = SIZE[type][bp];
  return { w: Math.min(w, BREAKPOINT_COLS[bp]), h };
}

/**
 * Complete a breakpoint's layout: drop items for widgets that no longer exist,
 * clamp items to the column count, and place any widget missing from the
 * layout at the bottom, left to right, in widget order.
 */
export function autoPlace(layout: LayoutItem[], widgets: Pick<Widget, 'id' | 'type'>[], bp: Breakpoint): LayoutItem[] {
  const cols = BREAKPOINT_COLS[bp];
  const ids = new Set(widgets.map((w) => w.id));
  const kept = layout
    .filter((l) => ids.has(l.i))
    .map((l) => {
      const w = Math.min(l.w, cols);
      return { ...l, w, x: Math.min(l.x, cols - w) };
    });
  const placed = new Set(kept.map((l) => l.i));
  let y = kept.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  let x = 0;
  let rowH = 0;
  const added: LayoutItem[] = [];
  for (const w of widgets) {
    if (placed.has(w.id)) continue;
    const size = defaultSize(w.type, bp);
    if (x + size.w > cols) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    added.push({ i: w.id, x, y, w: size.w, h: size.h });
    x += size.w;
    rowH = Math.max(rowH, size.h);
  }
  return [...kept, ...added];
}

/** autoPlace for every breakpoint. */
export function completeLayouts(layouts: Partial<Layouts> | undefined, widgets: Pick<Widget, 'id' | 'type'>[]): Layouts {
  return {
    phone: autoPlace(layouts?.phone ?? [], widgets, 'phone'),
    tablet: autoPlace(layouts?.tablet ?? [], widgets, 'tablet'),
    desktop: autoPlace(layouts?.desktop ?? [], widgets, 'desktop'),
  };
}

/** Every Signal K path a widget reads: its main path plus any in its config. */
export function widgetPaths(w: Pick<Widget, 'path' | 'config'>): string[] {
  const out = new Set<string>();
  if (w.path) out.add(w.path);
  const visit = (v: unknown, key: string) => {
    if (typeof v === 'string' && /path/i.test(key) && /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)+$/.test(v)) out.add(v);
    else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, /path/i.test(k) ? k : key);
  };
  for (const [k, v] of Object.entries(w.config ?? {})) visit(v, k);
  return [...out];
}

// Thresholds and alarms

const Bound = z.number().finite().nullable();

export const ThresholdInputSchema = z
  .object({
    path: PathString,
    label: z.string().trim().min(1).max(80),
    warnLow: Bound.default(null),
    warnHigh: Bound.default(null),
    alarmLow: Bound.default(null),
    alarmHigh: Bound.default(null),
    enabled: z.boolean().default(true),
  })
  .refine((t) => [t.warnLow, t.warnHigh, t.alarmLow, t.alarmHigh].some((b) => b !== null), 'Set at least one limit')
  .refine((t) => t.warnLow === null || t.alarmLow === null || t.alarmLow <= t.warnLow, 'Alarm low must be at or below warn low')
  .refine((t) => t.warnHigh === null || t.alarmHigh === null || t.alarmHigh >= t.warnHigh, 'Alarm high must be at or above warn high')
  .refine((t) => {
    const low = t.warnLow ?? t.alarmLow;
    const high = t.warnHigh ?? t.alarmHigh;
    return low === null || high === null || low < high;
  }, 'Low limits must be below high limits');
export type ThresholdInput = z.input<typeof ThresholdInputSchema>;

/** Limits are SI values, the same units as the Signal K path. */
export const ThresholdSchema = z.object({
  id: z.string(),
  path: z.string(),
  label: z.string(),
  warnLow: z.number().nullable(),
  warnHigh: z.number().nullable(),
  alarmLow: z.number().nullable(),
  alarmHigh: z.number().nullable(),
  enabled: z.boolean(),
});
export type Threshold = z.infer<typeof ThresholdSchema>;

export type ThresholdLevel = 'normal' | 'warn' | 'alarm';

/** Which band a value falls in, with no hysteresis (used for tile colors). */
export function thresholdLevel(t: Pick<Threshold, 'warnLow' | 'warnHigh' | 'alarmLow' | 'alarmHigh'>, v: number): ThresholdLevel {
  if ((t.alarmLow !== null && v <= t.alarmLow) || (t.alarmHigh !== null && v >= t.alarmHigh)) return 'alarm';
  if ((t.warnLow !== null && v <= t.warnLow) || (t.warnHigh !== null && v >= t.warnHigh)) return 'warn';
  return 'normal';
}

export const AlarmStateSchema = z.enum(['warn', 'alarm', 'emergency']);
export type AlarmState = z.infer<typeof AlarmStateSchema>;

export const ActiveAlarmSchema = z.object({
  id: z.string(),
  source: z.enum(['threshold', 'system', 'anchor']),
  path: z.string().nullable(),
  title: z.string(),
  message: z.string(),
  state: AlarmStateSchema,
  raisedAt: z.string(),
  acked: z.boolean(),
  /** While set and in the future, the alarm is silenced and hidden. */
  snoozedUntil: z.string().nullable(),
});
export type ActiveAlarm = z.infer<typeof ActiveAlarmSchema>;

export const SnoozeSchema = z.object({ minutes: z.number().int().min(1).max(240) });
