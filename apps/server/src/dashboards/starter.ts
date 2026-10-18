// Starter dashboards created by setup: Helm, Engines, Energy and Anchor,
// using only the paths Signal K is actually publishing. Widget configs here
// follow the web app's widget registry (apps/web/src/dashboards/widgets).

import type { DashboardInput, InstanceIds, Widget } from '@watchkeeper/shared';

type W = Omit<Widget, 'id'>;

const w = (type: W['type'], label: string | null, path: string | null, config: Record<string, unknown> = {}): W => ({ type, label, path, config });
const title = (id: string) => `${id[0]!.toUpperCase()}${id.slice(1)}`;

/**
 * @param publishing paths with a value from Signal K (or derived from them)
 * @param ids the boat's instance ids
 */
export function starterDashboards(publishing: Set<string>, ids: InstanceIds): DashboardInput[] {
  const has = (p: string) => publishing.has(p);
  const some = (ps: string[]) => ps.filter(has);
  const out: DashboardInput[] = [];
  const battery = ids.batteries[0] ?? 'house';
  const solar = ids.solar[0] ?? 'main';
  const [port, stbd] = [ids.propulsion[0], ids.propulsion[1]];
  const engine = (id: string | undefined, leaf: string) => (id ? `propulsion.${id}.${leaf}` : '');
  const bat = (leaf: string) => `electrical.batteries.${battery}.${leaf}`;

  const batteryWidget = () =>
    has(bat('capacity.stateOfCharge')) || has(bat('voltage'))
      ? w('battery', `${title(battery)} battery`, null, {
          socPath: bat('capacity.stateOfCharge'),
          voltagePath: bat('voltage'),
          currentPath: bat('current'),
          solarPath: `electrical.solar.${solar}.current`,
        })
      : null;
  const windWidget = () => (has('environment.wind.angleApparent') ? w('wind', 'Wind', null) : null);
  // The shallow limit is safety-related: left empty for the skipper to set.
  const depthWidget = () =>
    has('environment.depth.belowKeel') ? w('depth', 'Depth below keel', 'environment.depth.belowKeel', { offset: 0, shallow: null, maxRange: 180 }) : null;

  // Helm, as in the phone mockup.
  out.push({
    name: 'Helm',
    widgets: [
      windWidget(),
      has('navigation.speedOverGround') ? w('numeric', 'SOG', 'navigation.speedOverGround', { decimals: 1, subPaths: some(['navigation.speedThroughWater']) }) : null,
      has('navigation.headingTrue')
        ? w('heading', 'Heading', 'navigation.headingTrue', { subPaths: some(['navigation.courseOverGroundTrue', 'steering.autopilot.state']) })
        : null,
      has('environment.outside.pressure')
        ? w('numeric', 'Barometer', 'environment.outside.pressure', { decimals: 0, subPaths: ['dataHub.environment.pressureTendency'] })
        : null,
      batteryWidget(),
      depthWidget(),
      has('environment.water.temperature') ? w('numeric', 'Water temp', 'environment.water.temperature', { decimals: 0 }) : null,
    ].filter((x): x is W => x !== null),
  });

  // Engines
  const twinRows = [
    { label: 'RPM', leaf: 'revolutions' },
    { label: 'Coolant', leaf: 'temperature' },
    { label: 'Oil', leaf: 'oilPressure' },
    { label: 'Hours', leaf: 'runTime' },
  ]
    .map((r) => ({ label: r.label, portPath: engine(port, r.leaf), stbdPath: engine(stbd, r.leaf) }))
    .filter((r) => has(r.portPath) || has(r.stbdPath));
  const alt = { label: 'Alt', portPath: port ? `electrical.alternators.${port}.voltage` : '', stbdPath: stbd ? `electrical.alternators.${stbd}.voltage` : '' };
  if (has(alt.portPath) || has(alt.stbdPath)) twinRows.splice(Math.min(3, twinRows.length), 0, alt);
  const rpm = (id: string | undefined) =>
    id && has(engine(id, 'revolutions')) ? w('gauge', `${title(id)} engine RPM`, engine(id, 'revolutions'), { min: 0, max: 60, decimals: 0 }) : null;
  const fuelRates = [...publishing].filter((p) => /^propulsion\.[^.]+\.fuel\.rate$/.test(p));
  const coolant = some([engine(port, 'temperature'), engine(stbd, 'temperature')]);
  out.push({
    name: 'Engines',
    widgets: [
      rpm(port),
      twinRows.length > 0 ? w('twin', 'Engines, twin', null, { rows: twinRows }) : null,
      fuelRates.length > 0 ? w('numeric', 'Fuel rate, total', 'dataHub.fuel.totalRate', { decimals: 1, subPaths: ['dataHub.fuel.range'] }) : null,
      coolant.length > 0 ? w('trend', 'Coolant temp, last 6 h', null, { paths: coolant, windowMin: 360 }) : null,
      rpm(stbd),
    ].filter((x): x is W => x !== null),
  });

  // Energy
  const tanks = [...publishing].filter((p) => /^tanks\.[^.]+\.[^.]+\.currentLevel$/.test(p)).sort();
  out.push({
    name: 'Energy',
    widgets: [
      batteryWidget(),
      has(bat('current')) && has(bat('capacity.stateOfCharge')) ? w('numeric', 'Time to empty', 'dataHub.electrical.timeToEmpty', { decimals: 1 }) : null,
      has(`electrical.solar.${solar}.current`) ? w('numeric', 'Solar', `electrical.solar.${solar}.current`, { decimals: 1 }) : null,
      ...tanks.map((p) => w('tank', null, p, { capacityPath: p.replace(/currentLevel$/, 'capacity') })),
      has(bat('capacity.stateOfCharge')) ? w('trend', 'Battery, last 24 h', null, { paths: [bat('capacity.stateOfCharge')], windowMin: 1440 }) : null,
    ].filter((x): x is W => x !== null),
  });

  // Anchor
  out.push({
    name: 'Anchor',
    widgets: [
      has('navigation.position') ? w('position', 'Position', null) : null,
      depthWidget(),
      windWidget(),
      has('navigation.speedOverGround') ? w('numeric', 'SOG', 'navigation.speedOverGround', { decimals: 1 }) : null,
      has('environment.depth.belowKeel') ? w('trend', 'Depth, last 6 h', null, { paths: ['environment.depth.belowKeel'], windowMin: 360 }) : null,
      w('clock', 'Time', null, { mode: 'utc' }),
    ].filter((x): x is W => x !== null),
  });

  // A dashboard with nothing from Signal K on it isn't created.
  return out.filter((d) => (d.widgets ?? []).some((x) => x.type !== 'clock'));
}
