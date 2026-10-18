import { describePath, type Widget } from '@watchkeeper/shared';
import { useLiveValues } from '../../live/socket';
import { cfg, fmt, staleText, tileState, usePrefs, useThresholdFor, WidgetTile } from './common';
import type { WidgetDef } from './types';

const R = 80;
const point = (f: number) => {
  const a = Math.PI * (1 - Math.min(1, Math.max(0, f)));
  return `${(100 + R * Math.cos(a)).toFixed(2)} ${(100 - R * Math.sin(a)).toFixed(2)}`;
};
const arc = (f1: number, f2: number) => `M${point(f1)} A${R} ${R} 0 0 1 ${point(f2)}`;

/** Semicircle arc, as in the edit-mode mockup. Warn and alarm zones come from the path's threshold. */
function Gauge({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const path = widget.path ?? '';
  const min = cfg(widget, 'min', 0);
  const max = cfg(widget, 'max', 100);
  const decimals = cfg<number | undefined>(widget, 'decimals', undefined);
  const r = useLiveValues(path ? [path] : [])[path];
  const threshold = useThresholdFor(path);
  const state = tileState(r, threshold);
  const span = max - min || 1;
  const frac = (v: number) => (v - min) / span;
  const value = typeof r?.value === 'number' ? r.value : null;
  const shown = fmt(path, state === 'missing' ? null : value, prefs, decimals);
  const zones: { from: number; to: number; tone: 'warn' | 'alarm' }[] = [];
  if (threshold) {
    const { warnLow, alarmLow, warnHigh, alarmHigh } = threshold;
    if (alarmLow !== null) zones.push({ from: min, to: alarmLow, tone: 'alarm' });
    if (warnLow !== null) zones.push({ from: alarmLow ?? min, to: warnLow, tone: 'warn' });
    if (warnHigh !== null) zones.push({ from: warnHigh, to: alarmHigh ?? max, tone: 'warn' });
    if (alarmHigh !== null) zones.push({ from: alarmHigh, to: max, tone: 'alarm' });
  }
  const label = widget.label ?? (path ? describePath(path).label : 'Gauge');
  const fresh = state !== 'stale' && state !== 'missing';
  const scale = `scale ${fmt(path, min, prefs, 0).text} to ${fmt(path, max, prefs, 0).text}`;
  return (
    <WidgetTile label={label} state={state} className="gauge">
      <svg viewBox="0 0 200 112" className="gauge__svg" role="img" aria-label={`${label}: ${shown.text} ${shown.unit}, ${scale}`}>
        <path d={arc(0, 1)} className="gauge__track" />
        {zones.map((z) => (
          <path key={`${z.tone}-${z.from}`} d={arc(frac(z.from), frac(z.to))} className={`gauge__zone gauge__zone--${z.tone}`} />
        ))}
        {value !== null && fresh ? <path d={arc(0, frac(value))} className="gauge__value" /> : null}
      </svg>
      <div className="gauge__readout">
        <span className="tile__num tile__num--md">{shown.text}</span> <span className="tile__unit">{shown.unit}</span>
      </div>
      {!fresh ? <div className="tile__sub">{staleText(r)}</div> : null}
    </WidgetTile>
  );
}

export const gauge: WidgetDef = {
  type: 'gauge',
  title: 'Analog gauge',
  Component: Gauge,
  usesPath: true,
  thresholds: true,
  defaults: () => ({ label: null, path: null, config: { min: 0, max: 100, decimals: 0 } }),
  settings: [
    { key: 'min', label: 'Scale from', kind: 'number', unitOf: 'path' },
    { key: 'max', label: 'Scale to', kind: 'number', unitOf: 'path' },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3, step: 1 },
  ],
};
