import { isLatLon, type InstanceIds, type Snapshot } from '@watchkeeper/shared';
import { DERIVED } from '../derived/engine.js';
import type { LiveStore } from '../signalk/store.js';
import type { TimeReading } from '../signalk/time.js';

/** Fixed snapshot fields and the Signal K path each one reads. */
const FIXED: ReadonlyArray<[string, string]> = [
  ['cog', 'navigation.courseOverGroundTrue'],
  ['sog', 'navigation.speedOverGround'],
  ['heading', 'navigation.headingTrue'],
  ['stw', 'navigation.speedThroughWater'],
  ['tws', 'environment.wind.speedTrue'],
  ['twd', 'environment.wind.directionTrue'],
  ['awa', 'environment.wind.angleApparent'],
  ['pressure', 'environment.outside.pressure'],
  ['pressureTendency', DERIVED.pressureTendency],
  ['airTemp', 'environment.outside.temperature'],
  ['waterTemp', 'environment.water.temperature'],
  ['depth', 'environment.depth.belowKeel'],
  ['autopilot', 'steering.autopilot.state'],
];

export interface DistanceMarks {
  /** Distance-run total at the start of this hour's span; null when unknown. */
  hourStart: number | null;
  /** Distance-run total when the passage started; null with no passage or no distance source. */
  passageStart: number | null;
}

/**
 * The values a log entry records, read from the live store at `now`. Raw SI;
 * anything stale or missing is null, never the last known value.
 */
export function buildSnapshot(store: LiveStore, now: number, ids: InstanceIds, time: TimeReading, marks: DistanceMarks): Snapshot {
  const num = (path: string): number | null => {
    const v = store.fresh(path, now);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const text = (path: string): string | null => {
    const v = store.fresh(path, now);
    return typeof v === 'string' ? v : null;
  };

  const s: Snapshot = { clockSource: time.source };
  const pos = store.fresh('navigation.position', now);
  s.lat = isLatLon(pos) ? pos.latitude : null;
  s.lon = isLatLon(pos) ? pos.longitude : null;
  for (const [key, path] of FIXED) s[key] = key === 'autopilot' ? text(path) : num(path);

  const total = num(DERIVED.distanceRun);
  s.distanceTotal = total;
  s.distanceHour = total !== null && marks.hourStart !== null ? Math.max(0, total - marks.hourStart) : null;
  s.distancePassage = total !== null && marks.passageStart !== null ? Math.max(0, total - marks.passageStart) : null;

  const house = ids.batteries[0];
  s.houseVoltage = house ? num(`electrical.batteries.${house}.voltage`) : null;
  s.houseSoc = house ? num(`electrical.batteries.${house}.capacity.stateOfCharge`) : null;
  const solar = ids.solar.map((id) => num(`electrical.solar.${id}.current`)).filter((v): v is number => v !== null);
  s.solarCurrent = solar.length > 0 ? solar.reduce((a, b) => a + b, 0) : null;

  for (const id of ids.propulsion) {
    s[`engine.${id}.state`] = text(`propulsion.${id}.state`);
    s[`engine.${id}.rpm`] = num(`propulsion.${id}.revolutions`);
    s[`engine.${id}.hours`] = num(`propulsion.${id}.runTime`);
  }
  for (const t of ids.tanks) s[`tank.${t.type}.${t.id}.level`] = num(`tanks.${t.type}.${t.id}.currentLevel`);
  return s;
}
