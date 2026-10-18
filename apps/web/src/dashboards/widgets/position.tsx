import { formatPosition, isLatLon, type Widget } from '@watchkeeper/shared';
import { useLiveValues } from '../../live/socket';
import { fmtInline, staleText, tileState, usePrefs, WidgetTile } from './common';
import type { WidgetDef } from './types';

const POS = 'navigation.position';
const SOG = 'navigation.speedOverGround';
const COG = 'navigation.courseOverGroundTrue';

/** Lat/lon in the user's format, with SOG and COG. */
function Position({ widget }: { widget: Widget }) {
  const prefs = usePrefs();
  const r = useLiveValues([POS, SOG, COG]);
  const state = tileState(r[POS]);
  const p = r[POS]?.value;
  const text = isLatLon(p) && state !== 'missing' ? formatPosition(p, prefs.position) : null;
  const line = (path: string, name: string) => {
    const x = r[path];
    return x && x.ageMs !== null && !x.stale ? `${name} ${fmtInline(path, x.value, prefs, path === COG ? 0 : undefined)}` : null;
  };
  const subs = [line(SOG, 'SOG'), line(COG, 'COG')].filter(Boolean);
  return (
    <WidgetTile label={widget.label ?? 'Position'} state={state} className="position">
      {text ? (
        <div className="position__coords">
          <span className="num">{text.lat}</span>
          <span className="num">{text.lon}</span>
        </div>
      ) : (
        <div className="tile__value">
          <span className="tile__num tile__num--md">--</span>
        </div>
      )}
      {state === 'stale' || state === 'missing' ? (
        <div className="tile__sub">{state === 'missing' ? 'No GPS fix' : staleText(r[POS])}</div>
      ) : subs.length > 0 ? (
        <div className="tile__sub">{subs.join(' · ')}</div>
      ) : null}
    </WidgetTile>
  );
}

export const position: WidgetDef = {
  type: 'position',
  title: 'Position',
  Component: Position,
  usesPath: false,
  defaults: () => ({ label: 'Position', path: null, config: {} }),
  settings: [],
};
