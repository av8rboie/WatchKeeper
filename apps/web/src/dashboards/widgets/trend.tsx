import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { converterFor, describePath, type Widget } from '@watchkeeper/shared';
import { socket, useLive } from '../../live/socket';
import { useTheme } from '../../theme/theme';
import { useHistory } from '../api';
import { cfg, usePrefs, WidgetTile } from './common';
import type { WidgetDef } from './types';

const SIDE_NAMES: Record<string, string> = { port: 'Port', starboard: 'Stbd' };

/** Series style from the path: port solid, starboard dashed, others in the accent and secondary inks. */
function seriesStyle(path: string, i: number): { token: string; dash?: number[] } {
  if (/\.port\./.test(path)) return { token: '--port' };
  if (/\.starboard\./.test(path)) return { token: '--stbd', dash: [6, 4] };
  return { token: ['--accent', '--sub', '--warn', '--good'][i % 4]!, dash: i > 0 ? [6, 4] : undefined };
}

function seriesName(path: string): string {
  const side = /\.(port|starboard)\./.exec(path)?.[1];
  return side ? SIDE_NAMES[side]! : describePath(path).label;
}

/** uPlot draws on canvas, so it needs the token's actual color. */
const tokenColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#6f7b82';

/** Live points received since mount, per path, as [epoch ms, SI value]. */
function useLiveTail(paths: string[], windowMs: number): { tail: Record<string, [number, number][]>; tick: number } {
  const key = paths.join('\n');
  useEffect(() => socket.retain(key ? key.split('\n') : []), [key]);
  const entries = useLive((s) => s.values);
  const tail = useRef<Record<string, [number, number][]>>({});
  let tick = 0;
  for (const p of paths) {
    const e = entries[p];
    const list = (tail.current[p] ??= []);
    if (e && typeof e.value === 'number' && (list.length === 0 || list[list.length - 1]![0] < e.ts)) {
      list.push([e.ts, e.value]);
      const cutoff = e.ts - windowMs;
      while (list.length > 0 && list[0]![0] < cutoff) list.shift();
      if (list.length > 3000) list.splice(0, list.length - 3000);
    }
    tick = Math.max(tick, list.at(-1)?.[0] ?? 0);
  }
  return { tail: tail.current, tick };
}

/** uPlot, from /history, with live values appended. */
function Trend({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const { theme } = useTheme();
  const paths = cfg<string[]>(widget, 'paths', []).slice(0, 4);
  const pathKey = paths.join(',');
  const windowMin = Math.min(10_080, Math.max(10, Number(cfg(widget, 'windowMin', 60))));
  const history = useHistory(paths, windowMin);
  const { tail, tick } = useLiveTail(paths, windowMin * 60_000);
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e!.contentRect.width), h: Math.floor(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // `tick` changes when live values arrive (the tail itself is a ref).
  const data = useMemo((): uPlot.AlignedData => {
    const byTs = new Map<number, (number | null)[]>();
    const put = (i: number, ts: number, v: number | null) => {
      const row = byTs.get(ts) ?? paths.map(() => null);
      row[i] = v;
      byTs.set(ts, row);
    };
    const since = Date.now() - windowMin * 60_000;
    paths.forEach((p, i) => {
      const conv = converterFor(describePath(p).quantity, prefs);
      const series = history.data?.find((s) => s.path === p);
      const lastHist = series?.points.at(-1)?.[0] ?? 0;
      for (const [ts, avg] of series?.points ?? []) if (ts >= since) put(i, ts, avg === null ? null : conv.toDisplay(avg));
      for (const [ts, v] of tail[p] ?? []) if (ts > lastHist && ts >= since) put(i, ts, conv.toDisplay(v));
    });
    const xs = [...byTs.keys()].sort((a, b) => a - b);
    return [xs.map((t) => t / 1000), ...paths.map((_, i) => xs.map((t) => byTs.get(t)![i] ?? null))];
  }, [history.data, tick, pathKey, prefs, windowMin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build the plot when size, series, units or theme change; new data is fed in below.
  useEffect(() => {
    const el = box.current;
    if (!el || size.w < 50 || size.h < 50) return;
    const ink = tokenColor('--sub');
    const grid = tokenColor('--line');
    const axis = { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '12px Barlow' };
    // Never zoom in so far that sensor noise fills the chart: at least 2 display units tall.
    const MIN_SPAN = 2;
    const u = new uPlot(
      {
        width: size.w,
        height: size.h,
        legend: { show: false },
        cursor: { points: { show: false } },
        scales: {
          // The whole window, so a chart with little history shows it at the right edge.
          x: { time: true, range: () => [Date.now() / 1000 - windowMin * 60, Date.now() / 1000] },
          y: {
            range: (_u, min, max) => {
              if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) return [0, MIN_SPAN];
              const span = Math.max(max - min, MIN_SPAN);
              const mid = (min + max) / 2;
              return [mid - span * 0.6, mid + span * 0.6];
            },
          },
        },
        axes: [
          axis,
          {
            ...axis,
            size: 52,
            values: (_u, splits) => {
              const step = splits.length > 1 ? Math.abs(splits[1]! - splits[0]!) : 1;
              const dp = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
              return splits.map((v) => v.toFixed(dp));
            },
          },
        ],
        series: [
          {},
          ...paths.map((p, i) => {
            const s = seriesStyle(p, i);
            return { label: seriesName(p), stroke: tokenColor(s.token), width: 2.5, dash: s.dash, spanGaps: false, points: { show: false } };
          }),
        ],
      },
      data,
      el,
    );
    plot.current = u;
    return () => {
      u.destroy();
      plot.current = null;
    };
  }, [size.w, size.h, pathKey, theme, prefs, windowMin]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  const unit = paths[0] ? converterFor(describePath(paths[0]).quantity, prefs).unit : '';
  const span = windowMin >= 1440 ? `${Math.round(windowMin / 1440)} d` : windowMin >= 60 ? `${Math.round(windowMin / 60)} h` : `${windowMin} min`;
  const label = widget.label ?? `${paths.map(seriesName).join(', ')}, last ${span}`;
  const empty = data[0].length === 0;
  return (
    <WidgetTile label={label} state={paths.length === 0 ? 'missing' : 'normal'} className="trend">
      <div className="trend__legend">
        {paths.map((p, i) => {
          const s = seriesStyle(p, i);
          return (
            <span key={p} className="trend__key">
              <span className={`trend__swatch ${s.dash ? 'trend__swatch--dashed' : ''}`} style={{ borderColor: `var(${s.token})` }} />
              {seriesName(p)}
            </span>
          );
        })}
        {unit ? <span className="trend__unit">{unit}</span> : null}
      </div>
      <div ref={box} className="trend__plot" role="img" aria-label={`Trend of ${paths.map(seriesName).join(' and ')} over the last ${span}`}>
        {empty ? <div className="trend__empty muted">{paths.length === 0 ? 'Pick paths in edit mode' : history.isPending ? 'Loading history…' : 'No history recorded yet'}</div> : null}
      </div>
    </WidgetTile>
  );
}

export const trend: WidgetDef = {
  type: 'trend',
  title: 'Trend chart',
  Component: Trend,
  usesPath: false,
  defaults: () => ({ label: null, path: null, config: { paths: [], windowMin: 360 } }),
  settings: [
    { key: 'paths', label: 'Paths (1 to 4)', kind: 'paths', max: 4 },
    {
      key: 'windowMin',
      label: 'Window',
      kind: 'select',
      options: [
        { value: '10', label: '10 minutes' },
        { value: '60', label: '1 hour' },
        { value: '360', label: '6 hours' },
        { value: '1440', label: '24 hours' },
        { value: '4320', label: '3 days' },
        { value: '10080', label: '7 days' },
      ],
    },
  ],
};
