import { useMemo, useState } from 'react';
import { DEFAULT_UNIT_PREFS, formatValue, type PathInfo, type Quantity } from '@watchkeeper/shared';
import { useMe, usePaths } from '../api/client';
import { formatAge } from '../shell/components';

function valueText(p: PathInfo, prefs = DEFAULT_UNIT_PREFS): string {
  if (p.ageMs === null) return 'no data';
  if (p.stale) return `stale ${formatAge(p.ageMs)}`;
  const f = formatValue(p.quantity as Quantity, p.value, prefs);
  const side = f.side ? ` ${f.side}` : '';
  return `${f.text}${f.unit && f.unit !== '°' ? ' ' : ''}${f.unit}${side}`;
}

/**
 * Every path the app knows about plus everything Signal K publishes, with
 * the current value in the user's units. Stale and missing values say so.
 */
export function PathBrowser({ selected, onSelect }: { selected?: string | null; onSelect?(path: string): void }) {
  const paths = usePaths();
  const me = useMe();
  const [query, setQuery] = useState('');
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (paths.data ?? []).filter((p) => !q || p.path.toLowerCase().includes(q) || p.label.toLowerCase().includes(q));
  }, [paths.data, query]);
  const staleCount = list.filter((p) => p.stale).length;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <label htmlFor="pb-search" className="sr-only">
        Search paths
      </label>
      <input id="pb-search" className="input" type="search" placeholder="Search paths" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="muted" style={{ fontSize: 13 }} role="status">
        {paths.isError ? 'Could not load paths.' : `${list.length} paths · ${staleCount} stale or missing`}
      </div>
      <ul className="path-list" aria-label="Signal K paths">
        {list.map((p) => (
          <li key={p.path}>
            <button
              type="button"
              className={`path-row ${p.stale ? 'path-row--stale' : ''}`}
              aria-pressed={selected === p.path}
              data-stale={p.stale}
              onClick={() => onSelect?.(p.path)}
              title={p.label}
            >
              <span className="path-row__path">{p.path}</span>
              <span className="path-row__value">{valueText(p, me.data?.unitPrefs)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
