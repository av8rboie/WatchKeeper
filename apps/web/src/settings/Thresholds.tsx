import { useState } from 'react';
import { converterFor, describePath, type Converter, type Threshold, type ThresholdInput } from '@watchkeeper/shared';
import { ApiError, usePaths } from '../api/client';
import { useThresholdMutations, useThresholds } from '../dashboards/api';
import { usePrefs } from '../dashboards/widgets/common';
import { Button, FormField, PrimaryButton } from '../shell/components';

type Limits = Pick<Threshold, 'warnLow' | 'warnHigh' | 'alarmLow' | 'alarmHigh'>;
const KEYS: { key: keyof Limits; label: string }[] = [
  { key: 'alarmLow', label: 'Alarm below' },
  { key: 'warnLow', label: 'Warn below' },
  { key: 'warnHigh', label: 'Warn above' },
  { key: 'alarmHigh', label: 'Alarm above' },
];
const EMPTY: Record<keyof Limits, string> = { warnLow: '', warnHigh: '', alarmLow: '', alarmHigh: '' };

function limitsText(t: Threshold, conv: Converter): string {
  const f = (v: number) => `${Number(conv.toDisplay(v).toFixed(2))}${conv.unit.startsWith('°') ? '' : ' '}${conv.unit}`;
  return KEYS.filter((k) => t[k.key] !== null)
    .map((k) => `${k.label.toLowerCase()} ${f(t[k.key]!)}`)
    .join(' · ');
}

/** Add or edit one threshold. Values typed in the user's units, saved in SI. */
function ThresholdForm({ initial, onDone }: { initial: Threshold | null; onDone(): void }) {
  const prefs = usePrefs();
  const paths = usePaths(60_000).data ?? [];
  const numeric = paths.filter((p) => !['state', 'text', 'position'].includes(p.quantity));
  const [path, setPath] = useState(initial?.path ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const conv = converterFor(describePath(path || 'unknown').quantity, prefs);
  const [text, setText] = useState<Record<keyof Limits, string>>(() =>
    initial
      ? (Object.fromEntries(KEYS.map((k) => [k.key, initial[k.key] === null ? '' : String(Number(conv.toDisplay(initial[k.key]!).toFixed(3)))])) as Record<keyof Limits, string>)
      : EMPTY,
  );
  const [error, setError] = useState<string | null>(null);
  const { create, update } = useThresholdMutations();
  const save = async () => {
    const limits = {} as Limits;
    for (const k of KEYS) {
      const t = text[k.key].trim();
      if (t === '') limits[k.key] = null;
      else {
        const n = Number(t);
        if (!Number.isFinite(n)) return setError(`${k.label} is not a number.`);
        limits[k.key] = conv.toSI(n);
      }
    }
    const body: ThresholdInput = { path, label: label.trim() || describePath(path).label, ...limits, enabled: initial?.enabled ?? true };
    try {
      if (initial) await update(initial.id, body);
      else await create(body);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
    }
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      <FormField label="Signal K path">
        {(id) => (
          <select id={id} className="select" value={path} onChange={(e) => setPath(e.target.value)} disabled={!!initial}>
            <option value="">Choose a path</option>
            {numeric.map((p) => (
              <option key={p.path} value={p.path}>
                {p.label} ({p.path})
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label="Name" hint="Shown on the alarm banner">
        {(id) => <input id={id} className="input" value={label} placeholder={path ? describePath(path).label : ''} onChange={(e) => setLabel(e.target.value)} />}
      </FormField>
      <div className="grid-2">
        {KEYS.map((k) => (
          <FormField key={k.key} label={`${k.label}${conv.unit ? ` (${conv.unit})` : ''}`}>
            {(id) => <input id={id} className="input" inputMode="decimal" value={text[k.key]} onChange={(e) => setText((t) => ({ ...t, [k.key]: e.target.value }))} />}
          </FormField>
        ))}
      </div>
      {error ? (
        <div className="field__error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row" style={{ gap: 10 }}>
        <PrimaryButton onClick={() => void save()} disabled={!path}>
          Save threshold
        </PrimaryButton>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function Row({ t, canEdit, onEdit }: { t: Threshold; canEdit: boolean; onEdit(): void }) {
  const prefs = usePrefs();
  const conv = converterFor(describePath(t.path).quantity, prefs);
  const { update, remove } = useThresholdMutations();
  return (
    <li className="threshold-row">
      <div>
        <div style={{ fontWeight: 600 }}>
          {t.label}
          {t.enabled ? '' : ' (off)'}
        </div>
        <div className="threshold-row__limits">{limitsText(t, conv)}</div>
        <div className="mono muted" style={{ fontSize: 12 }}>
          {t.path}
        </div>
      </div>
      {canEdit ? (
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="link-button" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="link-button" onClick={() => void update(t.id, { ...t, enabled: !t.enabled })}>
            {t.enabled ? 'Turn off' : 'Turn on'}
          </button>
          <button
            type="button"
            className="link-button link-button--danger"
            onClick={() => {
              if (window.confirm(`Delete the ${t.label} threshold?`)) void remove(t.id);
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Warn and alarm limits the backend evaluates. Defaults for safety limits
 * (depth, engine temperature) are deliberately absent: the skipper sets them.
 */
export function Thresholds({ canEdit }: { canEdit: boolean }) {
  const list = useThresholds().data ?? [];
  const [editing, setEditing] = useState<Threshold | 'new' | null>(null);
  return (
    <div className="stack" style={{ gap: 10 }}>
      {list.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No thresholds yet. Safety limits have no defaults: set the ones your boat needs.
        </p>
      ) : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Thresholds">
        {list.map((t) => (
          <Row key={t.id} t={t} canEdit={canEdit} onEdit={() => setEditing(t)} />
        ))}
      </ul>
      {canEdit && editing === null ? <Button onClick={() => setEditing('new')}>Add threshold</Button> : null}
      {editing !== null ? <ThresholdForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
    </div>
  );
}
