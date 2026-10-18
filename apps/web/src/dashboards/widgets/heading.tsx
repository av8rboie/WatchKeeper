import { describePath, radToDeg360, type Widget } from '@watchkeeper/shared';
import { useLiveValues } from '../../live/socket';
import { BigValue, cfg, fmt, staleText, subText, tileState, usePrefs, WidgetTile } from './common';
import type { WidgetDef } from './types';

/** A ±40° strip of compass card centred on the heading. */
function Tape({ deg }: { deg: number }) {
  const ticks = [];
  for (let d = Math.ceil((deg - 40) / 5) * 5; d <= deg + 40; d += 5) {
    const x = 100 + (d - deg) * 2.4;
    const norm = ((d % 360) + 360) % 360;
    const major = norm % 10 === 0;
    ticks.push(
      <g key={d}>
        <line x1={x} y1={major ? 4 : 8} x2={x} y2={14} className="tape__tick" />
        {norm % 30 === 0 ? (
          <text x={x} y={26} className="tape__label" textAnchor="middle">
            {norm === 0 ? 'N' : norm === 90 ? 'E' : norm === 180 ? 'S' : norm === 270 ? 'W' : norm}
          </text>
        ) : null}
      </g>,
    );
  }
  return (
    <svg viewBox="0 0 200 30" className="tape" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      {ticks}
      <path d="M96 0 L104 0 L100 6 Z" className="tape__index" />
    </svg>
  );
}

function Heading({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const path = widget.path ?? 'navigation.headingTrue';
  const subPaths = cfg<string[]>(widget, 'subPaths', []);
  const readings = useLiveValues([path, ...subPaths]);
  const r = readings[path];
  const state = tileState(r);
  const fresh = state !== 'stale' && state !== 'missing';
  const formatted = fmt(path, state === 'missing' ? null : r?.value, prefs, 0);
  // The path decides true or magnetic, whatever the heading preference says.
  const unit = path.endsWith('Magnetic') ? '°M' : path.endsWith('True') ? '°T' : formatted.unit;
  const subs = subPaths.map((p) => subText(p, readings[p], prefs)).filter((s): s is NonNullable<typeof s> => s !== null);
  return (
    <WidgetTile label={widget.label ?? describePath(path).label} state={state}>
      <BigValue shown={{ ...formatted, unit }} />
      {fresh && typeof r?.value === 'number' ? <Tape deg={radToDeg360(r.value)} /> : null}
      {!fresh ? <div className="tile__sub">{staleText(r)}</div> : subs.length > 0 ? <div className="tile__sub">{subs.map((s) => s.text).join(' · ')}</div> : null}
    </WidgetTile>
  );
}

export const heading: WidgetDef = {
  type: 'heading',
  title: 'Heading',
  Component: Heading,
  usesPath: true,
  defaults: () => ({ label: 'Heading', path: 'navigation.headingTrue', config: { subPaths: ['navigation.courseOverGroundTrue'] } }),
  settings: [{ key: 'subPaths', label: 'Secondary values', kind: 'paths', max: 2 }],
};
