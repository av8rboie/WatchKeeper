import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { roleAtLeast, type LogEntry, type Passage, type PassageSummary } from '@watchkeeper/shared';
import { useMe } from '../api/client';
import { usePrefs } from '../dashboards/widgets/common';
import { Button, Card, FilterChips, FormField, PrimaryButton } from '../shell/components';
import { useActivePassage, useLog, useLogMutations, usePassageSummary, type LogFilter } from './api';
import { crewLine, dayLabel, entryHeading, entryTone, fmtDistance, fmtHours, fmtSpeed, hhmm, signatureLabel, snapshotLines } from './format';

export const PlusIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);

export const DownloadIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <path d="M4 19h16" />
  </svg>
);

/** Guests see dashboards only; the log is for crew. */
export function CrewOnly({ title }: { title: string }) {
  return (
    <>
      <div className="screen-head">
        <h1 className="screen-title">{title}</h1>
      </div>
      <Card>
        <p style={{ margin: 0 }}>The logbook is for crew. On a shared helm device, sign in with your crew PIN.</p>
        <div className="row" style={{ marginTop: 12 }}>
          <Link to="/login" className="button">
            Sign in with PIN
          </Link>
        </div>
      </Card>
    </>
  );
}

export function PassageStats({ summary, wide }: { summary: PassageSummary; wide?: boolean }) {
  const prefs = usePrefs();
  return (
    <div className={`log-stats ${wide ? 'log-stats--wide' : ''}`}>
      <div className="log-stat">
        <span className="label">Run</span>
        <span className="log-stat__value">{fmtDistance(summary.distanceM, prefs)}</span>
      </div>
      <div className="log-stat">
        <span className="label">Avg SOG</span>
        <span className="log-stat__value">{fmtSpeed(summary.avgSogMps, prefs)}</span>
      </div>
      <div className="log-stat">
        <span className="label">Engines</span>
        <span className="log-stat__value">{fmtHours(summary.engineS)}</span>
      </div>
      {wide ? (
        <>
          <div className="log-stat">
            <span className="label">Entries</span>
            <span className="log-stat__value">{summary.entries}</span>
          </div>
          <div className="log-stat">
            <span className="label">Unsigned</span>
            <span className="log-stat__value">{summary.unsigned}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function StartPassageForm({ onDone, onCancel, initial }: { onDone(p: Passage): void; onCancel?(): void; initial?: Passage }) {
  const m = useLogMutations();
  const [name, setName] = useState(initial?.name ?? '');
  const [from, setFrom] = useState(initial?.fromPlace ?? '');
  const [to, setTo] = useState(initial?.toPlace ?? '');
  const [crew, setCrew] = useState(initial?.crew.join(', ') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const input = {
      name: name.trim() || [from.trim(), to.trim()].filter(Boolean).join(' to '),
      fromPlace: from.trim() || null,
      toPlace: to.trim() || null,
      crew: crew
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    };
    if (!input.name) {
      setError('Give the passage a name, or where it starts and ends.');
      return;
    }
    setBusy(true);
    (initial ? m.updatePassage(initial.id, input) : m.startPassage(input))
      .then(onDone)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid-2">
        <FormField label="From">{(id) => <input id={id} className="input" value={from} onChange={(e) => setFrom(e.target.value)} />}</FormField>
        <FormField label="To">{(id) => <input id={id} className="input" value={to} onChange={(e) => setTo(e.target.value)} />}</FormField>
      </div>
      <FormField label="Passage name" hint="Leave empty to use From and To.">
        {(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}
      </FormField>
      <FormField label="Crew" hint="Names, separated by commas.">
        {(id) => <input id={id} className="input" value={crew} onChange={(e) => setCrew(e.target.value)} />}
      </FormField>
      {error ? (
        <div className="warn-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row">
        <PrimaryButton type="submit" disabled={busy}>
          {initial ? 'Save passage' : 'Start passage'}
        </PrimaryButton>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}

function EntryCard({ e }: { e: LogEntry }) {
  const prefs = usePrefs();
  const tone = entryTone(e);
  const lines = e.kind === 'hourly' || e.kind === 'system' ? snapshotLines(e, prefs) : [];
  const remarks = e.current.remarks;
  const crew = crewLine(e);
  const photos = e.attachments.length;
  // Hourly entries always carry the signing flag; others show it once signed, else their photo count.
  const flag = e.kind === 'hourly' || e.signedAt ? signatureLabel(e) : null;
  return (
    <Link to={`/log/${e.id}`} className="log-row" aria-label={`${hhmm(e.ts)} ${entryHeading(e)}${e.signedAt ? '' : ', unsigned'}`}>
      <div className="log-time">{hhmm(e.ts)}</div>
      <div className={`log-card ${e.kind === 'hourly' && !e.signedAt ? 'log-card--unsigned' : ''}`}>
        <div className="log-card__head">
          <span className={`log-card__kind ${tone === 'ink' ? '' : `log-card__kind--${tone}`}`}>{entryHeading(e)}</span>
          {flag ? (
            <span className={`log-card__flag log-card__flag--${flag.tone}`}>{flag.text}</span>
          ) : photos > 0 ? (
            <span className="log-card__flag log-card__flag--muted">{photos === 1 ? '1 photo' : `${photos} photos`}</span>
          ) : null}
        </div>
        {remarks ? <div className="log-card__body">{remarks}</div> : null}
        {lines.length > 0 ? (
          <div className="log-card__body">
            {lines.map((l, i) => (
              <span key={i}>
                {i > 0 ? <br /> : null}
                {l}
              </span>
            ))}
          </div>
        ) : null}
        {crew && e.kind !== 'event' ? <div className="log-card__crew">{crew}</div> : null}
      </div>
    </Link>
  );
}

export function Timeline({ entries }: { entries: LogEntry[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const days: { key: string; list: LogEntry[] }[] = [];
  for (const e of entries) {
    const key = e.ts.slice(0, 10);
    if (days.at(-1)?.key !== key) days.push({ key, list: [] });
    days.at(-1)!.list.push(e);
  }
  return (
    <div className="log-timeline">
      {days.map((d) => (
        <div key={d.key} className="log-timeline">
          <div className="label log-day">{dayLabel(d.key, today)}</div>
          {d.list.map((e) => (
            <EntryCard key={e.id} e={e} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The logbook timeline for the active passage. With none under way it shows
 * the latest entries (anchor and dock entries included) and offers to start
 * one. `?passage=<id>` shows a past passage.
 */
export function LogbookScreen() {
  const role = useMe().data?.role ?? 'guest';
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const chosen = params.get('passage');
  const isCrew = roleAtLeast(role, 'crew');
  const active = useActivePassage(isCrew);
  const pastSummary = usePassageSummary(chosen ?? undefined);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [starting, setStarting] = useState(false);

  const summary = chosen ? pastSummary.data : active.data?.summary;
  const passage = chosen ? (pastSummary.data?.passage ?? null) : (active.data?.passage ?? null);
  const loaded = chosen ? !pastSummary.isPending : !active.isPending;
  const log = useLog(isCrew && loaded ? (passage?.id ?? null) : undefined, filter);
  if (!isCrew) return <CrewOnly title="Logbook" />;

  const unsigned = summary?.unsigned;
  return (
    <>
      <div className="screen-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <h1 className="screen-title">Logbook</h1>
          <div className="log-sub">
            {passage ? `${passage.name} · Day ${summary?.day ?? 1}${passage.endedAt ? ' · ended' : ''}` : 'No passage under way'}
          </div>
        </div>
        {passage ? (
          <Link to={`/passages/${passage.id}`} className="icon-button" aria-label="Export passage">
            <DownloadIcon />
          </Link>
        ) : null}
      </div>

      {summary ? <PassageStats summary={summary} /> : null}

      {!passage && !chosen ? (
        <Card>
          {starting ? (
            <StartPassageForm onDone={() => setStarting(false)} onCancel={() => setStarting(false)} />
          ) : (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>Start a passage to log every hour on the hour.</span>
              <PrimaryButton onClick={() => setStarting(true)}>Start passage</PrimaryButton>
            </div>
          )}
        </Card>
      ) : null}

      <div className="log-toolbar">
        <FilterChips<LogFilter>
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'hourly', label: 'Hourly' },
            { value: 'events', label: 'Events' },
            { value: 'unsigned', label: unsigned !== undefined ? `Unsigned ${unsigned}` : 'Unsigned' },
          ]}
        />
        {!passage?.endedAt ? (
          <Link to="/log/new" className="log-quick">
            <PlusIcon />
            Quick entry
          </Link>
        ) : (
          <Button onClick={() => navigate('/log')}>Back to the current log</Button>
        )}
      </div>

      {log.isError ? <div className="warn-box">Could not load the log. Retrying…</div> : null}
      {log.data && log.data.length === 0 ? (
        <Card>
          <p className="muted" style={{ margin: 0 }}>
            {filter === 'all' ? 'No entries yet.' : 'No entries match this filter.'}
          </p>
        </Card>
      ) : null}
      {log.data ? <Timeline entries={log.data} /> : null}
    </>
  );
}
