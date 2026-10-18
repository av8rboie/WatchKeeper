import type { Widget } from '@watchkeeper/shared';
import { cfg, WidgetTile } from './common';
import type { WidgetDef } from './types';

/** Only web links: anything else (javascript:, data:) would run in the app's origin. */
export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Opens Freeboard-SK, the Signal K admin, and so on. */
function Link({ widget }: { widget: Widget }) {
  const url = safeUrl(cfg(widget, 'url', ''));
  const text = cfg(widget, 'text', '') || (url ? new URL(url).host : 'Set a link in edit mode');
  return (
    <WidgetTile label={widget.label ?? 'Link'} state={url ? 'normal' : 'missing'} className="link-widget">
      {url ? (
        <a className="link-widget__a" href={url} target="_blank" rel="noopener noreferrer">
          {text}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <div className="tile__sub">{text}</div>
      )}
    </WidgetTile>
  );
}

export const link: WidgetDef = {
  type: 'link',
  title: 'Link',
  Component: Link,
  usesPath: false,
  defaults: () => ({ label: 'Chart plotter', path: null, config: { url: '', text: 'Open Freeboard-SK' } }),
  settings: [
    { key: 'url', label: 'Address', kind: 'text', placeholder: 'http:// or https:// address' },
    { key: 'text', label: 'Link text', kind: 'text' },
  ],
};
