import type { Widget } from '@watchkeeper/shared';
import { useLiveValues, type LiveReading } from '../../live/socket';
import { BigValue, cfg, fmt, staleText, tileState, usePrefs, useThresholdFor, WidgetTile } from './common';
import type { WidgetDef } from './types';

const DEFAULTS = {
  socPath: 'electrical.batteries.house.capacity.stateOfCharge',
  voltagePath: 'electrical.batteries.house.voltage',
  currentPath: 'electrical.batteries.house.current',
  solarPath: 'electrical.solar.main.current',
};

const fresh = (r: LiveReading | undefined) => !!r && r.ageMs !== null && !r.stale && typeof r.value === 'number';
const signed = (v: number, digits: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;

/** State of charge big; voltage, current and solar on the sub line. Falls back to voltage without a SoC sensor. */
function Battery({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const p = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, cfg(widget, k, v)])) as typeof DEFAULTS;
  const r = useLiveValues(Object.values(p).filter(Boolean));
  const hasSoc = r[p.socPath] !== undefined && r[p.socPath]!.ageMs !== null;
  const main = hasSoc ? p.socPath : p.voltagePath;
  const threshold = useThresholdFor(main);
  const state = tileState(r[main], threshold);
  // As in the mockup: voltage and solar on the sub line; net current below it when the tile has room.
  const parts: string[] = [];
  if (hasSoc && fresh(r[p.voltagePath])) parts.push(`${(r[p.voltagePath]!.value as number).toFixed(1)} V`);
  if (fresh(r[p.solarPath])) parts.push(`${signed(r[p.solarPath]!.value as number, 1)} A solar`);
  const net = fresh(r[p.currentPath]) ? `Net ${signed(r[p.currentPath]!.value as number, 1)} A` : null;
  const missing = { text: '--', unit: hasSoc ? '%' : 'V' };
  return (
    <WidgetTile label={widget.label ?? 'Battery'} state={state}>
      <BigValue shown={state === 'missing' ? missing : fmt(main, r[main]?.value, prefs, hasSoc ? 0 : 1)} />
      {state === 'stale' || state === 'missing' ? (
        <div className="tile__sub">{staleText(r[main])}</div>
      ) : (
        <>
          {parts.length > 0 ? <div className="tile__sub">{parts.join(' · ')}</div> : null}
          {net ? <div className="tile__sub tile__sub--extra">{net}</div> : null}
        </>
      )}
    </WidgetTile>
  );
}

export const battery: WidgetDef = {
  type: 'battery',
  title: 'Battery',
  Component: Battery,
  usesPath: false,
  defaults: () => ({ label: 'House battery', path: null, config: { ...DEFAULTS } }),
  settings: [
    { key: 'socPath', label: 'State of charge path', kind: 'path' },
    { key: 'voltagePath', label: 'Voltage path', kind: 'path' },
    { key: 'currentPath', label: 'Current path', kind: 'path' },
    { key: 'solarPath', label: 'Solar current path', kind: 'path' },
  ],
};
