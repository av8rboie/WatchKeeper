import { useEffect, useState } from 'react';
import { describePath, type Widget } from '@watchkeeper/shared';
import { useLiveValues } from '../../live/socket';
import { BigValue, cfg, fmt, fmtInline, staleText, subText, tileState, usePrefs, useThresholdFor, WidgetTile } from './common';
import type { WidgetDef } from './types';

interface MinMax {
  min: number;
  max: number;
  since: number;
}

/** Min/max since reset, per device: the helm phone and the saloon laptop reset separately. */
function useMinMax(id: string, value: unknown, enabled: boolean): [MinMax | null, () => void] {
  const key = `dh.minmax.${id}`;
  const [mm, setMm] = useState<MinMax | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null') as MinMax | null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!enabled || typeof value !== 'number') return;
    setMm((cur) => {
      const next = cur ? { ...cur, min: Math.min(cur.min, value), max: Math.max(cur.max, value) } : { min: value, max: value, since: Date.now() };
      if (cur && next.min === cur.min && next.max === cur.max) return cur;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage unavailable: min/max lasts until reload.
      }
      return next;
    });
  }, [enabled, key, value]);
  const reset = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage unavailable: nothing to clear.
    }
    setMm(null);
  };
  return [mm, reset];
}

function Numeric({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const path = widget.path ?? '';
  const subPaths = cfg<string[]>(widget, 'subPaths', []);
  const decimals = cfg<number | undefined>(widget, 'decimals', undefined);
  const showMinMax = cfg<boolean>(widget, 'showMinMax', false);
  const readings = useLiveValues([path, ...subPaths].filter(Boolean));
  const r = readings[path];
  const threshold = useThresholdFor(path);
  const state = tileState(r, threshold);
  const fresh = state !== 'stale' && state !== 'missing';
  const [mm, reset] = useMinMax(widget.id, fresh ? r?.value : null, showMinMax);
  const label = widget.label ?? (path ? describePath(path).label : 'Value');
  const subs = subPaths.map((p) => subText(p, readings[p], prefs)).filter((s): s is NonNullable<typeof s> => s !== null);

  return (
    <WidgetTile label={label} state={state}>
      <BigValue shown={state === 'missing' ? { text: '--', unit: fmt(path, null, prefs).unit } : fmt(path, r?.value, prefs, decimals)} />
      {!fresh ? <div className="tile__sub">{staleText(r, path)}</div> : null}
      {fresh && state !== 'normal' ? <div className="tile__sub">{state === 'alarm' ? 'Past alarm limit' : 'Past warning limit'}</div> : null}
      {fresh
        ? subs.map((s) => (
            <div key={s.text} className={`tile__sub ${s.tone === 'warn' ? 'tile__sub--warn' : ''}`}>
              {s.text}
            </div>
          ))
        : null}
      {showMinMax && mm ? (
        <div className="tile__sub row" style={{ gap: 8 }}>
          <span>
            Min {fmtInline(path, mm.min, prefs, decimals)} · Max {fmtInline(path, mm.max, prefs, decimals)}
          </span>
          <button type="button" className="link-button" onClick={reset}>
            Reset
          </button>
        </div>
      ) : null}
    </WidgetTile>
  );
}

export const numeric: WidgetDef = {
  type: 'numeric',
  title: 'Numeric',
  Component: Numeric,
  usesPath: true,
  thresholds: true,
  defaults: () => ({ label: null, path: null, config: { decimals: null, showMinMax: false, subPaths: [] } }),
  settings: [
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 4, step: 1, hint: 'Blank for the default' },
    {
      key: 'showMinMax',
      label: 'Min and max',
      kind: 'select',
      options: [
        { value: 'false', label: 'Hidden' },
        { value: 'true', label: 'Since reset' },
      ],
    },
    { key: 'subPaths', label: 'Secondary values', kind: 'paths', max: 2 },
  ],
};
