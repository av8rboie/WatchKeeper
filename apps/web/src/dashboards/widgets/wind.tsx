import { windAngleToSided, type Widget } from '@watchkeeper/shared';
import { useLiveValues } from '../../live/socket';
import { cfg, fmt, fmtInline, staleText, tileState, usePrefs, WidgetTile } from './common';
import type { WidgetDef } from './types';

const DEG = Math.PI / 180;
const C = 75;

/** Boat-relative polar point: 0 at the bow, positive to starboard. */
const at = (angle: number, r: number) => ({ x: C + r * Math.sin(angle), y: C - r * Math.cos(angle) });
const sector = (from: number, to: number, r: number) => {
  const a = at(from * DEG, r);
  const b = at(to * DEG, r);
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} A${r} ${r} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
};

const DEFAULT_PATHS = {
  awaPath: 'environment.wind.angleApparent',
  awsPath: 'environment.wind.speedApparent',
  twaPath: 'environment.wind.angleTrueWater',
  twsPath: 'environment.wind.speedTrue',
  twdPath: 'environment.wind.directionTrue',
};

/** Boat-relative rose: close-hauled sectors 20° to 60° each side, catamaran outline in the center. */
function Wind({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const p = Object.fromEntries(Object.entries(DEFAULT_PATHS).map(([k, v]) => [k, cfg(widget, k, v)])) as typeof DEFAULT_PATHS;
  const r = useLiveValues(Object.values(p));
  const awa = r[p.awaPath];
  const state = tileState(awa);
  const fresh = (path: string) => !!r[path] && !r[path]!.stale && r[path]!.ageMs !== null;
  const awaV = fresh(p.awaPath) && typeof awa?.value === 'number' ? awa.value : null;
  const twaV = fresh(p.twaPath) && typeof r[p.twaPath]?.value === 'number' ? (r[p.twaPath]!.value as number) : null;
  const sided = awaV !== null ? windAngleToSided(awaV) : null;
  const apparent = awaV !== null ? at(awaV, 45) : null;
  const truePt = twaV !== null ? at(twaV, 60) : null;
  const value = (path: string) => (fresh(path) ? fmtInline(path, r[path]!.value, prefs) : '--');
  const describe = sided ? `apparent ${sided.deg.toFixed(0)} degrees ${sided.side === 'PORT' ? 'port' : 'starboard'}` : 'no apparent wind';

  return (
    <WidgetTile label={widget.label ?? 'Wind'} state={state} className="wind">
      <div className="wind__body">
        <svg viewBox="0 0 150 150" className="wind__rose" role="img" aria-label={`Wind: ${describe}`}>
          <circle cx={C} cy={C} r={66} className="wind__ring" />
          <path d={sector(-60, -20, 66)} className="wind__sector wind__sector--port" />
          <path d={sector(20, 60, 66)} className="wind__sector wind__sector--stbd" />
          <line x1={C} y1={4} x2={C} y2={14} className="wind__bow" />
          {/* Catamaran: two hulls and the bridge deck */}
          <rect x={62} y={56} width={7} height={40} rx={3.5} className="wind__boat" />
          <rect x={81} y={56} width={7} height={40} rx={3.5} className="wind__boat" />
          <rect x={69} y={66} width={12} height={14} className="wind__boat" />
          {truePt ? <line x1={C} y1={C} x2={truePt.x} y2={truePt.y} className="wind__true" /> : null}
          {apparent ? (
            <>
              <line x1={C} y1={C} x2={apparent.x} y2={apparent.y} className="wind__apparent" />
              <circle cx={apparent.x} cy={apparent.y} r={6} className="wind__apparent-dot" />
            </>
          ) : null}
        </svg>
        <div className="wind__readouts">
          <div>
            <div className="label">AWA</div>
            <div className="tile__value">
              <span className="tile__num tile__num--md">{sided ? `${sided.deg.toFixed(0)}°` : '--'}</span>
              {sided?.side ? <span className={`tile__side tile__side--${sided.side.toLowerCase()}`}>{sided.side}</span> : null}
            </div>
          </div>
          <dl className="wind__grid">
            <div>
              <dt>AWS</dt>
              <dd>{value(p.awsPath)}</dd>
            </div>
            <div>
              <dt>TWS</dt>
              <dd>{value(p.twsPath)}</dd>
            </div>
            <div>
              <dt>TWA</dt>
              <dd>{twaV !== null ? `${windAngleToSided(twaV).deg.toFixed(0)}°` : '--'}</dd>
            </div>
            <div>
              <dt>TWD</dt>
              <dd>{fresh(p.twdPath) ? `${fmt(p.twdPath, r[p.twdPath]!.value, prefs, 0).text}${fmt(p.twdPath, 0, prefs).unit}` : '--'}</dd>
            </div>
          </dl>
          {state === 'stale' || state === 'missing' ? <div className="tile__sub">{staleText(awa)}</div> : null}
        </div>
      </div>
    </WidgetTile>
  );
}

export const wind: WidgetDef = {
  type: 'wind',
  title: 'Wind',
  Component: Wind,
  usesPath: false,
  defaults: () => ({ label: 'Wind', path: null, config: {} }),
  settings: [
    { key: 'awaPath', label: 'Apparent angle path', kind: 'path', hint: DEFAULT_PATHS.awaPath },
    { key: 'awsPath', label: 'Apparent speed path', kind: 'path', hint: DEFAULT_PATHS.awsPath },
    { key: 'twaPath', label: 'True angle path', kind: 'path', hint: DEFAULT_PATHS.twaPath },
    { key: 'twsPath', label: 'True speed path', kind: 'path', hint: DEFAULT_PATHS.twsPath },
    { key: 'twdPath', label: 'True direction path', kind: 'path', hint: DEFAULT_PATHS.twdPath },
  ],
};
