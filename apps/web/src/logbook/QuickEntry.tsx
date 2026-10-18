import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isLatLon, QUICK_EVENTS, roleAtLeast, SEA_STATES } from '@watchkeeper/shared';
import { useMe, usePaths } from '../api/client';
import { fmtInline, usePrefs } from '../dashboards/widgets/common';
import { useLiveValues, useNow } from '../live/socket';
import { resizePhoto, useActivePassage, useLogMutations } from './api';
import { compactCoord } from './format';
import { CrewOnly } from './Logbook';

const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </svg>
);

const CameraIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);

const CAPTURED = [
  'navigation.position',
  'navigation.courseOverGroundTrue',
  'navigation.speedOverGround',
  'environment.wind.speedTrue',
  'environment.outside.pressure',
] as const;

const engineName = (id: string) => (id === 'starboard' ? 'Stbd' : id[0]!.toUpperCase() + id.slice(1));

/** What the backend will record with the entry, previewed from live values. */
function useCapturedText(): string {
  const prefs = usePrefs();
  const paths = usePaths(30_000).data;
  const engines = useMemo(
    () => (paths ?? []).map((p) => /^propulsion\.([^.]+)\.state$/.exec(p.path)?.[1]).filter((id): id is string => !!id),
    [paths],
  );
  const live = useLiveValues([...CAPTURED, ...engines.map((id) => `propulsion.${id}.state`)]);
  const fresh = (path: string) => {
    const r = live[path];
    return r && !r.stale ? r.value : null;
  };
  const parts: string[] = [];
  const pos = fresh('navigation.position');
  if (isLatLon(pos)) parts.push(`${compactCoord(pos.latitude, 'lat', prefs)} ${compactCoord(pos.longitude, 'lon', prefs)}`);
  const cog = fresh('navigation.courseOverGroundTrue');
  if (cog !== null) parts.push(`COG ${fmtInline('navigation.courseOverGroundTrue', cog, prefs)}`);
  const sog = fresh('navigation.speedOverGround');
  if (sog !== null) parts.push(`SOG ${fmtInline('navigation.speedOverGround', sog, prefs, 1)}`);
  const tws = fresh('environment.wind.speedTrue');
  if (tws !== null) parts.push(`TWS ${fmtInline('environment.wind.speedTrue', tws, prefs, 0)}`);
  const p = fresh('environment.outside.pressure');
  if (p !== null) parts.push(fmtInline('environment.outside.pressure', p, prefs, 0));
  for (const id of engines) {
    const s = fresh(`propulsion.${id}.state`);
    if (typeof s === 'string') parts.push(`${engineName(id)} eng ${/stop|off/i.test(s) ? 'off' : 'on'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'No instrument data right now. The entry records what is missing as missing.';
}

/** Quick log entry: what happened, sea state, a note, a photo. The instruments are recorded automatically. */
export function QuickEntryScreen() {
  const role = useMe().data?.role ?? 'guest';
  const navigate = useNavigate();
  const m = useLogMutations();
  const active = useActivePassage(roleAtLeast(role, 'crew')).data;
  const now = useNow(15_000);
  const captured = useCapturedText();
  const [eventType, setEventType] = useState<string | null>(null);
  const [seaState, setSeaState] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!roleAtLeast(role, 'crew')) return <CrewOnly title="Quick entry" />;

  const time = new Date(now).toISOString().slice(11, 16);
  const canSave = !busy && (eventType !== null || seaState !== null || notes.trim() !== '' || photo !== null);
  const save = () => {
    setBusy(true);
    setError(null);
    m.create({ eventType, crewFields: seaState ? { seaState } : {}, remarks: notes.trim() || null }, photo)
      .then(({ photoError }) => {
        if (photoError) setError(`Saved, but the photo did not upload: ${photoError}`);
        else navigate('/log');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const pickPhoto = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPhoto(await resizePhoto(f));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="qe">
      <div className="qe-head">
        <Link to="/log" className="icon-button" aria-label="Close">
          <CloseIcon />
        </Link>
        <div style={{ flex: 1 }}>
          <h1>Quick entry</h1>
          <div className="log-sub" style={{ fontSize: 13 }}>
            {time} UTC{active?.summary ? ` · Day ${active.summary.day}` : ''}
          </div>
        </div>
      </div>

      <div className="qe-captured">
        <div className="qe-captured__title">Captured automatically</div>
        {captured}
      </div>

      <div className="label qe-section qe-section--first" id="qe-what">
        What happened
      </div>
      <div className="qe-events" role="group" aria-labelledby="qe-what">
        {QUICK_EVENTS.map((ev) => (
          <button key={ev.id} type="button" aria-pressed={eventType === ev.id} onClick={() => setEventType(eventType === ev.id ? null : ev.id)}>
            {ev.label}
          </button>
        ))}
      </div>

      <div className="label qe-section" id="qe-sea">
        Sea state
      </div>
      <div className="qe-sea" role="group" aria-labelledby="qe-sea">
        {SEA_STATES.map((s) => (
          <button key={s} type="button" aria-pressed={seaState === s} onClick={() => setSeaState(seaState === s ? null : s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="qe-notes">
        <label htmlFor="qe-notes" className="label">
          Notes
        </label>
        <textarea id="qe-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {error ? (
        <div className="warn-box" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      ) : null}

      <div className="qe-actions">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void pickPhoto(e.target.files?.[0])} />
        <button
          type="button"
          className="qe-photo"
          aria-label={photo ? 'Photo added. Replace photo' : 'Add photo'}
          data-has-photo={photo !== null}
          onClick={() => fileRef.current?.click()}
        >
          <CameraIcon />
        </button>
        <button type="button" className="qe-save" disabled={!canSave} onClick={save}>
          {busy ? 'Saving…' : 'Save to log'}
        </button>
      </div>
    </div>
  );
}
