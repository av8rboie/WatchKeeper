import { thresholdLevel, type Widget } from '@watchkeeper/shared';
import { useLiveValues, type LiveReading } from '../../live/socket';
import { useThresholds } from '../api';
import { cfg, fmtInline, usePrefs, WidgetTile } from './common';
import type { WidgetDef } from './types';

interface Row {
  label: string;
  portPath: string;
  stbdPath: string;
}

/** Whole numbers for rpm, temperatures and pressures; catalog defaults otherwise. */
const decimalsFor = (path: string) => (/(revolutions|temperature|oilPressure)$/.test(path) ? 0 : undefined);

/** Port/starboard pairs side by side. Port solid, starboard dashed. Labels PORT and STBD. */
function Twin({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const rows = cfg<Row[]>(widget, 'rows', []);
  const readings = useLiveValues(rows.flatMap((r) => [r.portPath, r.stbdPath]).filter(Boolean));
  const thresholds = useThresholds().data ?? [];
  const cell = (path: string, r: LiveReading | undefined): { text: string; tone: string } => {
    if (!path || !r || r.ageMs === null) return { text: '--', tone: 'missing' };
    if (r.stale) return { text: 'stale', tone: 'stale' };
    const t = thresholds.find((x) => x.path === path && x.enabled);
    const level = t && typeof r.value === 'number' ? thresholdLevel(t, r.value) : 'normal';
    return { text: fmtInline(path, r.value, prefs, decimalsFor(path)), tone: level === 'normal' ? '' : level };
  };
  const anyFresh = rows.some((r) => [r.portPath, r.stbdPath].some((p) => readings[p] && readings[p]!.ageMs !== null && !readings[p]!.stale));
  const side = (key: 'portPath' | 'stbdPath', name: 'PORT' | 'STBD') => (
    <div className={`twin__side twin__side--${name.toLowerCase()}`}>
      <span className="twin__name">{name}</span>
      {rows.map((r) => {
        const c = cell(r[key], readings[r[key]]);
        return (
          <span key={r.label} className="twin__row">
            {r.label} <b className={c.tone ? `twin__value--${c.tone}` : ''}>{c.text}</b>
          </span>
        );
      })}
    </div>
  );
  return (
    <WidgetTile label={widget.label ?? 'Engines'} state={rows.length === 0 ? 'missing' : anyFresh ? 'normal' : 'stale'} className="twin">
      <div className="twin__grid">
        {side('portPath', 'PORT')}
        {side('stbdPath', 'STBD')}
      </div>
    </WidgetTile>
  );
}

export const twin: WidgetDef = {
  type: 'twin',
  title: 'Twin (port and starboard)',
  Component: Twin,
  usesPath: false,
  defaults: () => ({
    label: 'Engines, twin',
    path: null,
    config: {
      rows: [
        { label: 'RPM', portPath: 'propulsion.port.revolutions', stbdPath: 'propulsion.starboard.revolutions' },
        { label: 'Coolant', portPath: 'propulsion.port.temperature', stbdPath: 'propulsion.starboard.temperature' },
        { label: 'Oil', portPath: 'propulsion.port.oilPressure', stbdPath: 'propulsion.starboard.oilPressure' },
      ],
    },
  }),
  settings: [{ key: 'rows', label: 'Rows', kind: 'pairs', hint: 'Label, port path and starboard path for each row' }],
};
