import { describePath, type Widget } from '@watchkeeper/shared';
import { useLiveValues } from '../../live/socket';
import { staleText, tileState, WidgetTile } from './common';
import type { WidgetDef } from './types';

/** Non-numeric paths: engine state, autopilot mode and the like. */
function Text({ widget }: { widget: Widget }) {
  const path = widget.path ?? '';
  const r = useLiveValues(path ? [path] : [])[path];
  const state = tileState(r);
  const v = r?.value;
  const text = state === 'missing' || v === null || v === undefined ? '--' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return (
    <WidgetTile label={widget.label ?? (path ? describePath(path).label : 'Text')} state={state}>
      <div className="tile__value">
        <span className="tile__num tile__num--words">{text}</span>
      </div>
      {state === 'stale' || state === 'missing' ? <div className="tile__sub">{staleText(r)}</div> : null}
    </WidgetTile>
  );
}

export const text: WidgetDef = {
  type: 'text',
  title: 'Text',
  Component: Text,
  usesPath: true,
  defaults: () => ({ label: null, path: null, config: {} }),
  settings: [],
};
