import { useMemo, useState } from 'react';
import { DEFAULT_UNIT_PREFS, formatValue, type PathInfo, type Quantity, type UnitPrefs } from '@watchkeeper/shared';
import { useMe, usePaths } from '../api/client';
import { useLiveValues, type LiveReading } from '../live/socket';
import { formatAge } from '../shell/components';

function valueText(p: PathInfo, r: LiveReading, prefs: UnitPrefs = DEFAULT_UNIT_PREFS): string {
  if (r.ageMs === null) return 'no data';
  if (r.stale) return `stale ${formatAge(r.ageMs)}`;
  const f = formatValue(p.quantity as Quantity, r.value, prefs);
  const side = f.side ? ` ${f.side}` : '';
  return `${f.text}${f.unit && f.unit !== '°' ? ' ' : ''}${f.unit}${side}`;
}

/**
 * Every path the app knows about plus everything Signal K publishes. Values
 * for paths the backend subscribes to stream live over the Data Hub socket;
 * the rest come from the /paths snapshot. Stale and missing values say so.
 */
export function PathBrowser({ selected, onSelect }: { selected?: string | null; onSelect?(path: string): void }) {
  const paths = usePaths();
  const me = useMe();
  const [query, setQuery] = useState('');
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (paths.data ?? []).filter((p) => !q || p.path.toLowerCase().includes(q) || p.label.toLowerCase().includes(q));
  }, [paths.data, query]);
  const live = useLiveValues(list.filter((p) => p.live).map((p) => p.path));
  const reading = (p: PathInfo): LiveReading => live[p.path] ?? { value: p.value, ageMs: p.ageMs, stale: p.stale };
  const staleCount = list.filter((p) => reading(p).stale).length;

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
        {list.map((p) => {
          const r = reading(p);
          return (
            <li key={p.path}>
              <button
                type="button"
                className={`path-row ${r.stale ? 'path-row--stale' : ''}`}
                aria-pressed={selected === p.path}
                data-stale={r.stale}
                onClick={() => onSelect?.(p.path)}
                title={`${p.label} · ${p.rateClass}`}
              >
                <span className="path-row__path">{p.path}</span>
                <span className="path-row__value">{valueText(p, r, me.data?.unitPrefs)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
