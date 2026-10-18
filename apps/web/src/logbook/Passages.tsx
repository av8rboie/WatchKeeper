import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { roleAtLeast } from '@watchkeeper/shared';
import { useMe } from '../api/client';
import { BackIcon } from '../shell/icons';
import { Button, Card, PrimaryButton, StatusPill } from '../shell/components';
import { exportUrl, useActivePassage, useLogMutations, usePassages, usePassageSummary, useSuggestion } from './api';
import { CrewOnly, PassageStats, StartPassageForm } from './Logbook';

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The passage track on a plain equirectangular projection: no chart tiles offshore. */
function Track({ points }: { points: [number, number][] }) {
  if (points.length < 2)
    return (
      <p className="muted" style={{ margin: 0 }}>
        No track recorded yet.
      </p>
    );
  const lat0 = points.reduce((a, p) => a + p[0], 0) / points.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xy = points.map(([lat, lon]) => [lon * k, -lat] as const);
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX;
  const h = Math.max(...ys) - minY;
  const span = Math.max(w, h, 1e-4);
  const pad = span * 0.08;
  const last = xy[xy.length - 1]!;
  return (
    <svg
      className="passage-track"
      viewBox={`${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Track of ${points.length} positions`}
    >
      <polyline points={xy.map((p) => p.join(',')).join(' ')} />
      <circle cx={last[0]} cy={last[1]} r={span * 0.012} />
    </svg>
  );
}

export function PassagesScreen() {
  const role = useMe().data?.role ?? 'guest';
  const isCrew = roleAtLeast(role, 'crew');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const list = usePassages();
  const active = useActivePassage(isCrew).data?.passage;
  const [starting, setStarting] = useState(params.get('start') === '1');
  if (!isCrew) return <CrewOnly title="Passages" />;
  return (
    <>
      <div className="screen-head">
        <h1 className="screen-title">Passages</h1>
        {!active && !starting ? <PrimaryButton onClick={() => setStarting(true)}>Start passage</PrimaryButton> : null}
      </div>
      {starting && !active ? (
        <Card title="Start a passage">
          <StartPassageForm onDone={() => navigate('/log')} onCancel={() => setStarting(false)} />
        </Card>
      ) : null}
      {list.data && list.data.length === 0 ? (
        <Card>
          <p className="muted" style={{ margin: 0 }}>
            No passages yet.
          </p>
        </Card>
      ) : null}
      <ul className="passage-list" style={{ marginTop: 8 }}>
        {list.data?.map((p) => (
          <li key={p.id}>
            <Link to={`/passages/${p.id}`}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <strong>{p.name}</strong>
                <span className="muted" style={{ fontSize: 13 }}>
                  {when(p.startedAt)}
                  {p.endedAt ? ` to ${when(p.endedAt)}` : ''}
                </span>
              </span>
              {p.endedAt ? null : <StatusPill tone="good">Under way</StatusPill>}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function PassageDetailScreen() {
  const { id } = useParams();
  const role = useMe().data?.role ?? 'guest';
  const isCrew = roleAtLeast(role, 'crew');
  const q = usePassageSummary(isCrew ? id : undefined);
  const m = useLogMutations();
  const [editing, setEditing] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isCrew) return <CrewOnly title="Passage" />;
  if (q.isPending) return <div className="muted">Loading…</div>;
  if (!q.data) return <div className="warn-box">This passage does not exist.</div>;
  const { passage } = q.data;
  const route = [passage.fromPlace, passage.toPlace].filter(Boolean).join(' to ');
  const end = () =>
    void m
      .endPassage(passage.id)
      .then(() => setConfirmEnd(false))
      .catch((e: Error) => setError(e.message));

  return (
    <>
      <div className="screen-head">
        <div className="row" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
          <Link to="/passages" className="icon-button" aria-label="All passages">
            <BackIcon />
          </Link>
          <div style={{ minWidth: 0 }}>
            <h1 className="screen-title">{passage.name}</h1>
            <div className="log-sub">
              {route ? `${route} · ` : ''}Day {q.data.day}
              {passage.endedAt ? ' · ended' : ''}
            </div>
          </div>
        </div>
        {passage.endedAt ? null : <StatusPill tone="good">Under way</StatusPill>}
      </div>

      {error ? (
        <div className="warn-box" role="alert" style={{ marginBottom: 8 }}>
          {error}
        </div>
      ) : null}

      <PassageStats summary={q.data} wide />

      <Card
        title="Track"
        actions={
          <Link to={`/log?passage=${passage.id}`} className="button">
            Timeline
          </Link>
        }
      >
        <Track points={q.data.track} />
      </Card>

      <Card title="Export">
        <div className="row">
          {(['pdf', 'csv', 'gpx'] as const).map((ext) => (
            <a key={ext} className="button" href={exportUrl(passage.id, ext)} download>
              {ext.toUpperCase()}
            </a>
          ))}
        </div>
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
          PDF in logbook layout, one page per UTC day. CSV with every recorded value in your units. GPX track of 1-minute positions.
        </p>
      </Card>

      <Card title="Details" actions={editing ? undefined : <Button onClick={() => setEditing(true)}>Edit</Button>}>
        {editing ? (
          <StartPassageForm initial={passage} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        ) : (
          <dl className="kv">
            <dt>Started</dt>
            <dd>{when(passage.startedAt)}</dd>
            <dt>Ended</dt>
            <dd>{passage.endedAt ? when(passage.endedAt) : 'Under way'}</dd>
            <dt>Crew</dt>
            <dd>{passage.crew.length > 0 ? passage.crew.join(', ') : '--'}</dd>
          </dl>
        )}
      </Card>

      {passage.endedAt ? null : (
        <Card title="End passage">
          {confirmEnd ? (
            <div className="row">
              <span>Stop the hourly log for this passage?</span>
              <Button danger onClick={end}>
                End passage
              </Button>
              <Button onClick={() => setConfirmEnd(false)}>Keep going</Button>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Hourly entries stop when the passage ends. At anchor the log runs every 4 hours.</span>
              <Button danger onClick={() => setConfirmEnd(true)}>
                End passage
              </Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

/**
 * The auto-detection prompt, under the alarm banner. It only suggests:
 * starting or ending a passage is always someone's decision.
 */
export function PassageSuggestionStrip() {
  const role = useMe().data?.role ?? 'guest';
  const isCrew = roleAtLeast(role, 'crew');
  const s = useSuggestion(isCrew).data?.suggestion;
  const active = useActivePassage(isCrew);
  const m = useLogMutations();
  const navigate = useNavigate();
  if (!isCrew || !s) return null;
  const passage = active.data?.passage;
  return (
    <div className="suggest-strip" role="status">
      <span className="suggest-strip__text">
        {s.kind === 'start' ? `${s.reason}. Start a passage?` : `${s.reason}. End the passage${passage ? ` ${passage.name}` : ''}?`}
      </span>
      {s.kind === 'start' ? (
        <PrimaryButton
          onClick={() => {
            void m.dismissSuggestion();
            navigate('/passages?start=1');
          }}
        >
          Start passage
        </PrimaryButton>
      ) : passage ? (
        <PrimaryButton onClick={() => navigate(`/passages/${passage.id}`)}>Review and end</PrimaryButton>
      ) : null}
      <Button onClick={() => void m.dismissSuggestion()}>Not now</Button>
    </div>
  );
}
