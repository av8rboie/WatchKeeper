// Signal K path catalog. Every path the app knows about, its SI unit, the
// quantity used for display conversion, and how long before a value is stale.

export type Quantity =
  | 'position'
  | 'speed'
  | 'angle'
  | 'windAngle'
  | 'pressure'
  | 'enginePressure'
  | 'temperature'
  | 'depth'
  | 'distance'
  | 'rpm'
  | 'hours'
  | 'flow'
  | 'volume'
  | 'voltage'
  | 'current'
  | 'percent'
  | 'state'
  | 'number'
  | 'text';

export interface PathDef {
  path: string;
  label: string;
  siUnit: string;
  quantity: Quantity;
  /** Milliseconds after the last update before the value is stale. null = never stale. */
  staleMs: number | null;
}

/** Stale timeout for paths Signal K publishes that aren't in the catalog. */
export const UNKNOWN_PATH_STALE_MS = 30_000;

const s = (sec: number) => sec * 1000;

/**
 * Catalog templates. `<id>` is an instance id (port, starboard, house...),
 * `<type>` a tank type (fuel, freshWater...). Expanded with the boat's
 * configured instance ids by `expandCatalog`.
 */
export const PATH_TEMPLATES: readonly PathDef[] = [
  { path: 'navigation.position', label: 'Position', siUnit: 'lat/lon', quantity: 'position', staleMs: s(10) },
  { path: 'navigation.speedOverGround', label: 'SOG', siUnit: 'm/s', quantity: 'speed', staleMs: s(5) },
  { path: 'navigation.speedThroughWater', label: 'STW', siUnit: 'm/s', quantity: 'speed', staleMs: s(5) },
  { path: 'navigation.courseOverGroundTrue', label: 'COG', siUnit: 'rad', quantity: 'angle', staleMs: s(5) },
  { path: 'navigation.headingTrue', label: 'Heading (true)', siUnit: 'rad', quantity: 'angle', staleMs: s(5) },
  { path: 'navigation.headingMagnetic', label: 'Heading (magnetic)', siUnit: 'rad', quantity: 'angle', staleMs: s(5) },
  { path: 'navigation.anchor.position', label: 'Anchor position', siUnit: 'lat/lon', quantity: 'position', staleMs: null },
  { path: 'environment.wind.angleApparent', label: 'AWA', siUnit: 'rad', quantity: 'windAngle', staleMs: s(5) },
  { path: 'environment.wind.speedApparent', label: 'AWS', siUnit: 'm/s', quantity: 'speed', staleMs: s(5) },
  { path: 'environment.wind.angleTrueWater', label: 'TWA', siUnit: 'rad', quantity: 'windAngle', staleMs: s(5) },
  { path: 'environment.wind.speedTrue', label: 'TWS', siUnit: 'm/s', quantity: 'speed', staleMs: s(5) },
  { path: 'environment.wind.directionTrue', label: 'TWD', siUnit: 'rad', quantity: 'angle', staleMs: s(5) },
  { path: 'environment.outside.pressure', label: 'Barometer', siUnit: 'Pa', quantity: 'pressure', staleMs: s(60) },
  { path: 'environment.outside.temperature', label: 'Air temp', siUnit: 'K', quantity: 'temperature', staleMs: s(60) },
  { path: 'environment.water.temperature', label: 'Water temp', siUnit: 'K', quantity: 'temperature', staleMs: s(60) },
  { path: 'environment.depth.belowKeel', label: 'Depth below keel', siUnit: 'm', quantity: 'depth', staleMs: s(10) },
  { path: 'propulsion.<id>.revolutions', label: '<Id> engine RPM', siUnit: 'Hz', quantity: 'rpm', staleMs: s(5) },
  { path: 'propulsion.<id>.state', label: '<Id> engine state', siUnit: 'string', quantity: 'state', staleMs: s(30) },
  { path: 'propulsion.<id>.temperature', label: '<Id> engine temp', siUnit: 'K', quantity: 'temperature', staleMs: s(30) },
  { path: 'propulsion.<id>.oilPressure', label: '<Id> oil pressure', siUnit: 'Pa', quantity: 'enginePressure', staleMs: s(30) },
  { path: 'propulsion.<id>.runTime', label: '<Id> engine hours', siUnit: 's', quantity: 'hours', staleMs: s(300) },
  { path: 'propulsion.<id>.fuel.rate', label: '<Id> fuel rate', siUnit: 'm3/s', quantity: 'flow', staleMs: s(30) },
  { path: 'electrical.batteries.<id>.voltage', label: '<Id> battery voltage', siUnit: 'V', quantity: 'voltage', staleMs: s(30) },
  { path: 'electrical.batteries.<id>.current', label: '<Id> battery current', siUnit: 'A', quantity: 'current', staleMs: s(30) },
  { path: 'electrical.batteries.<id>.capacity.stateOfCharge', label: '<Id> battery SoC', siUnit: 'ratio', quantity: 'percent', staleMs: s(60) },
  { path: 'electrical.solar.<id>.current', label: '<Id> solar current', siUnit: 'A', quantity: 'current', staleMs: s(60) },
  { path: 'tanks.<type>.<id>.currentLevel', label: '<Type> tank <id>', siUnit: 'ratio', quantity: 'percent', staleMs: s(300) },
  { path: 'steering.autopilot.state', label: 'Autopilot', siUnit: 'string', quantity: 'state', staleMs: s(30) },
];

export interface InstanceIds {
  propulsion: string[];
  batteries: string[];
  solar: string[];
  tanks: { type: string; id: string }[];
}

/**
 * Placeholder instance ids until the skipper confirms the real ones in
 * settings (open item in the build spec).
 */
export const DEFAULT_INSTANCE_IDS: InstanceIds = {
  propulsion: ['port', 'starboard'],
  batteries: ['house'],
  solar: ['main'],
  tanks: [
    { type: 'fuel', id: 'port' },
    { type: 'fuel', id: 'starboard' },
    { type: 'freshWater', id: 'main' },
  ],
};

const cap = (v: string) => (v ? v[0]!.toUpperCase() + v.slice(1) : v);

function fill(def: PathDef, id: string, type?: string): PathDef {
  let path = def.path.replace('<id>', id);
  let label = def.label.replace('<Id>', cap(id)).replace('<id>', id);
  if (type !== undefined) {
    path = path.replace('<type>', type);
    label = label.replace('<Type>', cap(type));
  }
  return { ...def, path, label };
}

/** Expand templates into concrete paths for this boat's instance ids. */
export function expandCatalog(ids: InstanceIds = DEFAULT_INSTANCE_IDS): PathDef[] {
  const out: PathDef[] = [];
  for (const def of PATH_TEMPLATES) {
    if (def.path.startsWith('propulsion.<id>')) {
      for (const id of ids.propulsion) out.push(fill(def, id));
    } else if (def.path.startsWith('electrical.batteries.<id>')) {
      for (const id of ids.batteries) out.push(fill(def, id));
    } else if (def.path.startsWith('electrical.solar.<id>')) {
      for (const id of ids.solar) out.push(fill(def, id));
    } else if (def.path.startsWith('tanks.<type>')) {
      for (const t of ids.tanks) out.push(fill(def, t.id, t.type));
    } else {
      out.push(def);
    }
  }
  return out;
}

function templateRegex(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/<id>|<type>/g, '[^.]+') + '$');
}

const TEMPLATE_MATCHERS = PATH_TEMPLATES.map((def) => ({ def, re: templateRegex(def.path) }));

function labelFromParts(def: PathDef, parts: string[]): string {
  const tParts = def.path.split('.');
  let label = def.label;
  tParts.forEach((tp, i) => {
    const v = parts[i] ?? '';
    if (tp === '<id>') label = label.replace('<Id>', cap(v)).replace('<id>', v);
    if (tp === '<type>') label = label.replace('<Type>', cap(v));
  });
  return label;
}

/**
 * Describe any path: the catalog entry if it matches a template (whatever its
 * instance id), otherwise a generic entry with the default stale timeout.
 */
export function describePath(path: string, sample?: unknown): PathDef {
  const derived = DERIVED_PATHS.find((d) => d.path === path);
  if (derived) return derived;
  for (const { def, re } of TEMPLATE_MATCHERS) {
    if (re.test(path)) {
      const label = def.path.includes('<') ? labelFromParts(def, path.split('.')) : def.label;
      return { ...def, path, label };
    }
  }
  return {
    path,
    label: path.split('.').slice(-2).join(' '),
    siUnit: '',
    quantity: typeof sample === 'number' || sample === undefined ? 'number' : 'text',
    staleMs: UNKNOWN_PATH_STALE_MS,
  };
}

/** Numeric paths are written to the history tables. Positions are split into lat/lon. */
export function isRecordable(def: PathDef): boolean {
  return def.quantity !== 'state' && def.quantity !== 'text' && def.path !== 'navigation.anchor.position';
}

export const POSITION_LAT_SUFFIX = '.latitude';
export const POSITION_LON_SUFFIX = '.longitude';

/**
 * Vendor prefix for derived values. Signal K defines no `performance.*` path
 * for any of them, so all live under this prefix (see DECISIONS.md).
 */
export const DERIVED_PREFIX = 'dataHub';

/** Values the backend computes at 1 Hz and publishes to Signal K. */
export const DERIVED_PATHS: readonly PathDef[] = [
  { path: 'dataHub.fuel.totalRate', label: 'Fuel rate, total', siUnit: 'm3/s', quantity: 'flow', staleMs: s(30) },
  { path: 'dataHub.fuel.range', label: 'Fuel range', siUnit: 'm', quantity: 'distance', staleMs: s(30) },
  { path: 'dataHub.electrical.netCurrent', label: 'Net battery current', siUnit: 'A', quantity: 'current', staleMs: s(30) },
  { path: 'dataHub.electrical.timeToEmpty', label: 'Time to empty', siUnit: 's', quantity: 'hours', staleMs: s(60) },
  { path: 'dataHub.navigation.distanceRun', label: 'Distance run', siUnit: 'm', quantity: 'distance', staleMs: null },
  { path: 'dataHub.navigation.run24h', label: '24-hour run', siUnit: 'm', quantity: 'distance', staleMs: s(60) },
  { path: 'dataHub.environment.current.setTrue', label: 'Set', siUnit: 'rad', quantity: 'angle', staleMs: s(5) },
  { path: 'dataHub.environment.current.drift', label: 'Drift', siUnit: 'm/s', quantity: 'speed', staleMs: s(5) },
  { path: 'dataHub.environment.pressureTendency', label: 'Pressure tendency (3 h)', siUnit: 'Pa', quantity: 'pressure', staleMs: s(120) },
];
