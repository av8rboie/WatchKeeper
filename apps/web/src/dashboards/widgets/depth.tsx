import { describePath, type Widget } from '@watchkeeper/shared';
import { useLiveValues } from '../../live/socket';
import { BigValue, cfg, fmt, fmtInline, staleText, tileState, usePrefs, useThresholdFor, WidgetTile } from './common';
import type { WidgetDef } from './types';

/**
 * Depth with an offset (keel or waterline) and a shallow mark. "No bottom"
 * when the sounder has no reading (Signal K sends null) or reads past its range.
 */
function Depth({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const path = widget.path ?? 'environment.depth.belowKeel';
  const offset = cfg(widget, 'offset', 0);
  const shallow = cfg<number | null>(widget, 'shallow', null);
  const maxRange = cfg<number | null>(widget, 'maxRange', null);
  const r = useLiveValues([path])[path];
  const threshold = useThresholdFor(path);
  let state = tileState(r, threshold);
  const fresh = state !== 'stale' && state !== 'missing';
  const raw = typeof r?.value === 'number' ? r.value + offset : null;
  const noBottom = fresh && (raw === null || (maxRange !== null && raw > maxRange));
  const isShallow = fresh && !noBottom && shallow !== null && raw !== null && raw <= shallow;
  if (isShallow && state === 'normal') state = 'warn';
  const label = widget.label ?? describePath(path).label;
  return (
    <WidgetTile label={label} state={state}>
      {noBottom ? (
        <>
          <div className="tile__value">
            <span className="tile__num tile__num--words">No bottom</span>
          </div>
          <div className="tile__sub">Out of range</div>
        </>
      ) : (
        <>
          <BigValue shown={state === 'missing' ? { text: '--', unit: fmt(path, null, prefs).unit } : fmt(path, raw ?? r?.value, prefs)} />
          {!fresh ? <div className="tile__sub">{staleText(r)}</div> : null}
          {isShallow ? <div className="tile__sub">Shallower than {fmtInline(path, shallow, prefs)}</div> : null}
        </>
      )}
    </WidgetTile>
  );
}

export const depth: WidgetDef = {
  type: 'depth',
  title: 'Depth',
  Component: Depth,
  usesPath: true,
  thresholds: true,
  defaults: () => ({ label: 'Depth below keel', path: 'environment.depth.belowKeel', config: { offset: 0, shallow: null, maxRange: 180 } }),
  settings: [
    { key: 'offset', label: 'Offset', kind: 'number', unitOf: 'path', hint: 'Added to the reading, e.g. keel depth' },
    { key: 'shallow', label: 'Shallow mark', kind: 'number', unitOf: 'path', hint: 'Colors the tile. No default: set your own.' },
    { key: 'maxRange', label: 'Sounder range', kind: 'number', unitOf: 'path', hint: 'Deeper than this shows No bottom' },
  ],
};
