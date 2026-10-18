import { converterFor, describePath, type Widget } from '@watchkeeper/shared';
import { useLiveValues } from '../../live/socket';
import { cfg, staleText, tileState, usePrefs, useThresholdFor, WidgetTile } from './common';
import type { WidgetDef } from './types';

/** Vertical fill bar, volume shown in user units (level × capacity). */
function Tank({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const path = widget.path ?? '';
  const capacityPath = cfg<string | null>(widget, 'capacityPath', null);
  const capacityConfig = cfg<number | null>(widget, 'capacity', null);
  const r = useLiveValues([path, capacityPath].filter((p): p is string => !!p));
  const reading = r[path];
  const threshold = useThresholdFor(path);
  const state = tileState(reading, threshold);
  const level = typeof reading?.value === 'number' ? Math.min(1, Math.max(0, reading.value)) : null;
  // Capacity is static: any value Signal K has sent counts, stale or not.
  const capReading = capacityPath ? r[capacityPath]?.value : undefined;
  const capacity = typeof capReading === 'number' ? capReading : capacityConfig;
  const vol = converterFor('volume', prefs);
  const fresh = state !== 'stale' && state !== 'missing';
  const label = widget.label ?? (path ? describePath(path).label : 'Tank');
  return (
    <WidgetTile label={label} state={state} className="tank">
      <div className="tank__body">
        <div
          className="tank__bar"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={level === null ? undefined : Math.round(level * 100)}
          aria-label={label}
        >
          <div className="tank__fill" style={{ height: `${(level ?? 0) * 100}%` }} />
        </div>
        <div className="tank__readout">
          <div className="tile__value">
            <span className="tile__num tile__num--md">{level === null || state === 'missing' ? '--' : Math.round(level * 100)}</span>
            <span className="tile__unit">%</span>
          </div>
          {fresh && level !== null && capacity ? (
            <div className="tile__sub">
              {vol.toDisplay(level * capacity).toFixed(0)} of {vol.toDisplay(capacity).toFixed(0)} {vol.unit}
            </div>
          ) : null}
          {!fresh ? <div className="tile__sub">{staleText(reading)}</div> : null}
        </div>
      </div>
    </WidgetTile>
  );
}

export const tank: WidgetDef = {
  type: 'tank',
  title: 'Tank',
  Component: Tank,
  usesPath: true,
  thresholds: true,
  defaults: () => ({ label: null, path: null, config: { capacityPath: null, capacity: null } }),
  settings: [
    { key: 'capacityPath', label: 'Capacity path', kind: 'path', hint: 'tanks.<type>.<id>.capacity, if Signal K has it' },
    { key: 'capacity', label: 'Capacity', kind: 'number', unitOf: 'tanks.fuel.main.capacity', hint: 'Used when Signal K has no capacity' },
  ],
};
