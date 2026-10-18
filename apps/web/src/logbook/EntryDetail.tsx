import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  amendFieldLabel,
  CREW_FIELD_KEYS,
  CREW_FIELD_LABELS,
  describeSnapshotKey,
  formatSnapshotValue,
  orderedSnapshotKeys,
  roleAtLeast,
  type LogEntry,
} from '@watchkeeper/shared';
import { useMe } from '../api/client';
import { usePrefs } from '../dashboards/widgets/common';
import { BackIcon } from '../shell/icons';
import { Button, Card, FormField, PrimaryButton, StatusPill } from '../shell/components';
import { attachmentUrl, resizePhoto, useEntry, useLogMutations } from './api';
import { entryHeading, hhmm, signatureLabel } from './format';
import { CrewOnly } from './Logbook';

/** A value that may have been amended: the original struck through, then the current one. */
function Amended({ original, current }: { original: string | null; current: string | null | undefined }) {
  if (current === undefined || current === original) return <>{original ?? '--'}</>;
  return (
    <>
      <span className="amended-old">{original ?? '--'}</span>
      <span>{current ?? '--'}</span>
    </>
  );
}

function AmendForm({ entry, onDone }: { entry: LogEntry; onDone(): void }) {
  const prefs = usePrefs();
  const m = useLogMutations();
  const snapshotKeys = orderedSnapshotKeys(Object.keys(entry.snapshot));
  const [field, setField] = useState('remarks');
  const current = (f: string) => {
    if (f in entry.current) return entry.current[f] ?? '';
    if (f.startsWith('snapshot.')) {
      const key = f.slice(9);
      return formatSnapshotValue(key, entry.snapshot[key], prefs);
    }
    return '';
  };
  const [value, setValue] = useState(current('remarks'));
  // Filling in an unsigned entry is still recorded as an amendment, with a stock reason.
  const [reason, setReason] = useState(entry.signedAt ? '' : 'Completed before signing');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!reason.trim()) {
      setError('Give a reason for the change.');
      return;
    }
    setBusy(true);
    m.amend(entry.id, { field, newValue: value.trim() || null, reason: reason.trim() })
      .then(onDone)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <form className="stack" onSubmit={submit}>
      <FormField label="Field">
        {(id) => (
          <select
            id={id}
            className="select"
            value={field}
            onChange={(e) => {
              setField(e.target.value);
              setValue(current(e.target.value));
            }}
          >
            <option value="remarks">Remarks</option>
            {CREW_FIELD_KEYS.map((k) => (
              <option key={k} value={`crew.${k}`}>
                {CREW_FIELD_LABELS[k]}
              </option>
            ))}
            {snapshotKeys.map((k) => (
              <option key={k} value={`snapshot.${k}`}>
                {describeSnapshotKey(k).label}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label="New value" hint={field.startsWith('snapshot.') ? 'Include the unit, e.g. 6.9 kn.' : undefined}>
        {(id) =>
          field === 'remarks' ? (
            <textarea id={id} className="input" style={{ minHeight: 90, padding: 10 }} value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input id={id} className="input" value={value} onChange={(e) => setValue(e.target.value)} />
          )
        }
      </FormField>
      <FormField label="Reason" hint="Required. Shown with the change, and the original stays visible.">
        {(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}
      </FormField>
      {error ? (
        <div className="warn-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row">
        <PrimaryButton type="submit" disabled={busy}>
          Save amendment
        </PrimaryButton>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

/** One entry: snapshot, crew fields, remarks, photos, signing, amendments. */
export function EntryDetailScreen() {
  const { entryId } = useParams();
  const role = useMe().data?.role ?? 'guest';
  const isCrew = roleAtLeast(role, 'crew');
  const prefs = usePrefs();
  const q = useEntry(isCrew ? entryId : undefined);
  const m = useLogMutations();
  const [amending, setAmending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!isCrew) return <CrewOnly title="Log entry" />;
  if (q.isPending) return <div className="muted">Loading…</div>;
  if (!q.data) return <div className="warn-box">This entry does not exist.</div>;
  const e = q.data;
  const sig = signatureLabel(e);
  const keys = orderedSnapshotKeys(Object.keys(e.snapshot));

  const sign = () => void m.sign(e.id).catch((err: Error) => setError(err.message));
  const addPhoto = async (f: File | undefined) => {
    if (!f) return;
    try {
      await m.addPhoto(e.id, await resizePhoto(f));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div className="screen-head">
        <div className="row" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
          <Link to="/log" className="icon-button" aria-label="Back to the logbook">
            <BackIcon />
          </Link>
          <div style={{ minWidth: 0 }}>
            <h1 className="screen-title">{hhmm(e.ts)} UTC</h1>
            <div className="log-sub">
              {entryHeading(e)} · {e.ts.slice(0, 10)}
            </div>
          </div>
        </div>
        <StatusPill tone={sig.tone}>{sig.text}</StatusPill>
      </div>

      {error ? (
        <div className="warn-box" role="alert" style={{ marginBottom: 8 }}>
          {error}
        </div>
      ) : null}

      <Card title="Signature" actions={!e.signedAt ? <PrimaryButton onClick={sign}>Sign entry</PrimaryButton> : undefined}>
        <p style={{ margin: 0 }}>
          {e.signedAt
            ? `Signed by ${e.signedByName ?? 'unknown'} at ${hhmm(e.signedAt)} UTC on ${e.signedAt.slice(0, 10)}.`
            : 'Not signed yet. Signing records who and when; any later change is an amendment with a reason.'}
        </p>
        {e.createdByName ? (
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Written by {e.createdByName}.
          </p>
        ) : null}
        {e.snapshot.clockSource === 'host' ? (
          <p className="muted" style={{ margin: '6px 0 0' }}>
            GPS time was unavailable; this entry used the host clock.
          </p>
        ) : null}
      </Card>

      <Card title="Remarks" actions={<Button onClick={() => setAmending(true)}>Amend</Button>}>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          <Amended original={e.remarks} current={e.current.remarks} />
        </p>
      </Card>

      {amending ? (
        <Card title="Amend this entry">
          <AmendForm entry={e} onDone={() => setAmending(false)} />
        </Card>
      ) : null}

      <Card title="Crew fields">
        <dl className="kv">
          {CREW_FIELD_KEYS.map((k) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{CREW_FIELD_LABELS[k]}</dt>
              <dd>
                <Amended original={e.crewFields[k] ?? null} current={e.current[`crew.${k}`]} />
                {e.carried.includes(k) ? (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
                    carried forward
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Instruments">
        <dl className="kv">
          {keys.map((k) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{describeSnapshotKey(k).label}</dt>
              <dd className="num">
                <Amended original={formatSnapshotValue(k, e.snapshot[k], prefs)} current={e.current[`snapshot.${k}`]} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
          -- means the value was stale or missing when the entry was written.
        </p>
      </Card>

      <Card
        title="Photos"
        actions={
          <>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(ev) => void addPhoto(ev.target.files?.[0])} />
            <Button onClick={() => fileRef.current?.click()}>Add photo</Button>
          </>
        }
      >
        {e.attachments.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            None.
          </p>
        ) : (
          <div className="photo-strip">
            {e.attachments.map((a) => (
              <a key={a.id} href={attachmentUrl(a.id)} target="_blank" rel="noreferrer">
                <img src={attachmentUrl(a.id)} alt={a.caption ?? 'Photo attached to this entry'} />
              </a>
            ))}
          </div>
        )}
      </Card>

      {e.amendments.length > 0 ? (
        <Card title="Amendments">
          <ul className="amend-list">
            {e.amendments.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{amendFieldLabel(a.field)}:</strong> <span className="amended-old">{a.oldValue ?? '--'}</span>
                  <span>{a.newValue ?? '--'}</span>
                </div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Reason: {a.reason}. {a.userName ?? 'Unknown'}, {hhmm(a.ts)} UTC {a.ts.slice(0, 10)}.
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
