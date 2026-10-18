import type { Widget } from '@watchkeeper/shared';
import { useSystemStatus } from '../../api/client';
import { useNow } from '../../live/socket';
import { cfg, WidgetTile } from './common';
import type { WidgetDef } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC from the server's best time (GPS when fresh), local time, or a countdown. */
function Clock({ widget }: { widget: Widget }) {
  const mode = cfg<'utc' | 'local' | 'countdown'>(widget, 'mode', 'utc');
  const target = cfg<string | null>(widget, 'target', null);
  const status = useSystemStatus();
  const now = useNow(1000);
  // The server's time, advanced by local time since it was fetched: a phone with a wrong clock still shows GPS time.
  const best = status.data ? Date.parse(status.data.time.now) + (now - status.dataUpdatedAt) : now;
  const d = new Date(best);
  let value: string;
  let sub: string;
  if (mode === 'local') {
    value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    sub = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } else if (mode === 'countdown') {
    const end = target ? Date.parse(target) : NaN;
    if (Number.isNaN(end)) {
      value = '--';
      sub = 'Set a target time';
    } else {
      const s = Math.max(0, Math.round((end - best) / 1000));
      value = `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
      const e = new Date(end);
      sub = s === 0 ? 'Done' : `Until ${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())} UTC`;
    }
  } else {
    value = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    sub = status.data ? (status.data.time.source === 'gps' ? 'UTC · GPS time' : 'UTC · host clock') : 'UTC';
  }
  return (
    <WidgetTile label={widget.label ?? (mode === 'local' ? 'Local time' : mode === 'countdown' ? 'Countdown' : 'UTC')} state="normal">
      <div className="tile__value">
        <span className="tile__num">{value}</span>
      </div>
      <div className="tile__sub">{sub}</div>
    </WidgetTile>
  );
}

export const clock: WidgetDef = {
  type: 'clock',
  title: 'Clock',
  Component: Clock,
  usesPath: false,
  defaults: () => ({ label: null, path: null, config: { mode: 'utc', target: null } }),
  settings: [
    {
      key: 'mode',
      label: 'Shows',
      kind: 'select',
      options: [
        { value: 'utc', label: 'UTC' },
        { value: 'local', label: 'Local time' },
        { value: 'countdown', label: 'Countdown' },
      ],
    },
    { key: 'target', label: 'Countdown to (UTC)', kind: 'text', placeholder: '2026-10-19T06:00Z' },
  ],
};
