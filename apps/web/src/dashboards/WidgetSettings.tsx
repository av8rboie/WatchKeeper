import { useEffect, useState } from 'react';
import { converterFor, describePath, WIDGET_TYPES, type Threshold, type Widget, type WidgetType } from '@watchkeeper/shared';
import { ApiError } from '../api/client';
import { useLiveValues } from '../live/socket';
import { PathBrowser } from '../settings/PathBrowser';
import { Button, FormField } from '../shell/components';
import { useThresholdMutations, useThresholds } from './api';
import { fmtInline, usePrefs } from './widgets/common';
import { WIDGETS, type SettingField } from './widgets';

/** Where the next path picked in the path browser goes. */
type Target =
  | { kind: 'main' }
  | { kind: 'field'; key: string }
  | { kind: 'list'; key: string }
  | { kind: 'pair'; key: string; row: number; side: 'portPath' | 'stbdPath' };

type PairRow = { label: string; portPath: string; stbdPath: string };

const targetText = (t: Target, fields: SettingField[]) => {
  if (t.kind === 'main') return 'the widget';
  const f = fields.find((x) => x.key === t.key);
  return t.kind === 'pair' ? `${f?.label ?? t.key}, row ${t.row + 1} ${t.side === 'portPath' ? 'port' : 'starboard'}` : (f?.label ?? t.key);
};

/** A number in the user's units, stored in SI. Blank stores null. */
function UnitNumber(props: { id: string; si: number | null; quantityPath: string | null; onChange(si: number | null): void }) {
  const prefs = usePrefs();
  const conv = props.quantityPath ? converterFor(describePath(props.quantityPath).quantity, prefs) : null;
  const toText = (si: number | null) => (si === null ? '' : String(Number((conv ? conv.toDisplay(si) : si).toFixed(3))));
  const [text, setText] = useState(toText(props.si));
  useEffect(() => setText(toText(props.si)), [props.si, conv?.unit]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    const t = text.trim();
    if (t === '') return props.onChange(null);
    const n = Number(t.replace(/,/g, ''));
    if (Number.isFinite(n)) props.onChange(conv ? conv.toSI(n) : n);
    else setText(toText(props.si));
  };
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <input
        id={props.id}
        className="input"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        style={{ minWidth: 0, flex: 1 }}
      />
      {conv?.unit ? <span className="muted">{conv.unit}</span> : null}
    </div>
  );
}

function PathChip({ path, onRemove, onPick, picking }: { path: string | null; onRemove?(): void; onPick(): void; picking: boolean }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <button type="button" className={`path-chip ${picking ? 'path-chip--picking' : ''}`} onClick={onPick} aria-pressed={picking}>
        <span className="mono">{path ?? 'Pick a path'}</span>
      </button>
      {onRemove && path ? (
        <button type="button" className="link-button" onClick={onRemove} aria-label={`Remove ${path}`}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

type Limits = Pick<Threshold, 'warnLow' | 'warnHigh' | 'alarmLow' | 'alarmHigh'>;
const NO_LIMITS: Limits = { warnLow: null, warnHigh: null, alarmLow: null, alarmHigh: null };

/** Warn and alarm limits for the widget's path: the same thresholds the backend alarms on. */
function ThresholdFields({ path, label }: { path: string; label: string }) {
  const existing = useThresholds().data?.find((t) => t.path === path) ?? null;
  const { create, update } = useThresholdMutations();
  const [draft, setDraft] = useState<Limits>(NO_LIMITS);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setDraft(existing ? { warnLow: existing.warnLow, warnHigh: existing.warnHigh, alarmLow: existing.alarmLow, alarmHigh: existing.alarmHigh } : NO_LIMITS);
    setMsg(null);
  }, [existing?.id, path]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    try {
      const body = { path, label: existing?.label ?? label, ...draft, enabled: existing?.enabled ?? true };
      if (existing) await update(existing.id, body);
      else await create(body);
      setMsg('Saved. The backend alarms on these limits.');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Could not save the limits.');
    }
  };
  const field = (key: keyof Limits, text: string) => (
    <FormField label={text}>{(id) => <UnitNumber id={id} si={draft[key]} quantityPath={path} onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))} />}</FormField>
  );
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="grid-2">
        {field('warnHigh', 'Warn above')}
        {field('alarmHigh', 'Alarm above')}
        {field('warnLow', 'Warn below')}
        {field('alarmLow', 'Alarm below')}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <Button onClick={() => void save()} disabled={!existing && Object.values(draft).every((v) => v === null)}>
          Save limits
        </Button>
        {msg ? (
          <span className="muted" role="status" style={{ fontSize: 13 }}>
            {msg}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SettingInput(props: { field: SettingField; widget: Widget; set(key: string, v: unknown): void; target: Target | null; setTarget(t: Target): void }) {
  const { field, widget, set, target, setTarget } = props;
  const value = widget.config[field.key];
  switch (field.kind) {
    case 'number':
      return (
        <FormField label={field.label} hint={field.hint}>
          {(id) => (
            <UnitNumber
              id={id}
              si={typeof value === 'number' ? value : null}
              quantityPath={field.unitOf === 'path' ? widget.path : (field.unitOf ?? null)}
              onChange={(v) => set(field.key, field.step === 1 && v !== null ? Math.round(v) : v)}
            />
          )}
        </FormField>
      );
    case 'text':
      return (
        <FormField label={field.label} hint={field.hint}>
          {(id) => <input id={id} className="input" placeholder={field.placeholder} value={typeof value === 'string' ? value : ''} onChange={(e) => set(field.key, e.target.value)} />}
        </FormField>
      );
    case 'select':
      return (
        <FormField label={field.label}>
          {(id) => (
            <select
              id={id}
              className="select"
              value={String(value ?? field.options[0]?.value ?? '')}
              onChange={(e) => {
                const v = e.target.value;
                set(field.key, v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
              }}
            >
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </FormField>
      );
    case 'path':
      return (
        <div className="field">
          <span className="field__label">{field.label}</span>
          <PathChip
            path={typeof value === 'string' && value ? value : null}
            picking={target?.kind === 'field' && target.key === field.key}
            onPick={() => setTarget({ kind: 'field', key: field.key })}
            onRemove={() => set(field.key, null)}
          />
          {field.hint ? <span className="field__hint mono">{field.hint}</span> : null}
        </div>
      );
    case 'paths': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      const picking = target?.kind === 'list' && target.key === field.key;
      return (
        <div className="field">
          <span className="field__label">{field.label}</span>
          {list.map((p) => (
            <PathChip key={p} path={p} picking={false} onPick={() => undefined} onRemove={() => set(field.key, list.filter((x) => x !== p))} />
          ))}
          {list.length < field.max ? (
            <button type="button" className={`path-chip ${picking ? 'path-chip--picking' : ''}`} aria-pressed={picking} onClick={() => setTarget({ kind: 'list', key: field.key })}>
              Add a path from the browser
            </button>
          ) : null}
        </div>
      );
    }
    case 'pairs': {
      const rows = Array.isArray(value) ? (value as PairRow[]) : [];
      const setRow = (i: number, patch: Partial<PairRow>) => set(field.key, rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
      return (
        <div className="field">
          <span className="field__label">{field.label}</span>
          {field.hint ? <span className="field__hint">{field.hint}</span> : null}
          {rows.map((r, i) => (
            <div key={i} className="pair-row">
              <label className="sr-only" htmlFor={`pair-${widget.id}-${i}`}>
                Row {i + 1} label
              </label>
              <input id={`pair-${widget.id}-${i}`} className="input" value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
              {(['portPath', 'stbdPath'] as const).map((side) => {
                const picking = target?.kind === 'pair' && target.row === i && target.side === side;
                return (
                  <button
                    key={side}
                    type="button"
                    className={`path-chip ${picking ? 'path-chip--picking' : ''}`}
                    aria-pressed={picking}
                    onClick={() => setTarget({ kind: 'pair', key: field.key, row: i, side })}
                  >
                    <span className="pair-row__side">{side === 'portPath' ? 'PORT' : 'STBD'}</span> <span className="mono">{r[side] || 'pick'}</span>
                  </button>
                );
              })}
              <button type="button" className="link-button" onClick={() => set(field.key, rows.filter((_, j) => j !== i))}>
                Remove row
              </button>
            </div>
          ))}
          <button type="button" className="link-button" onClick={() => set(field.key, [...rows, { label: 'New', portPath: '', stbdPath: '' }])}>
            Add row
          </button>
        </div>
      );
    }
  }
}

/** Edit-mode side panel: widget settings above, the path browser below. */
export function WidgetSettings({ widget, onChange, onRemove }: { widget: Widget; onChange(w: Widget): void; onRemove(): void }) {
  const prefs = usePrefs();
  const def = WIDGETS[widget.type];
  const [target, setTarget] = useState<Target | null>(def.usesPath ? { kind: 'main' } : null);
  useEffect(() => setTarget(WIDGETS[widget.type].usesPath ? { kind: 'main' } : null), [widget.id, widget.type]);
  const source = useLiveValues(widget.path ? [widget.path] : [])[widget.path ?? ''];
  const set = (key: string, v: unknown) => onChange({ ...widget, config: { ...widget.config, [key]: v } });

  const pick = (path: string) => {
    if (!target) return;
    if (target.kind === 'main') onChange({ ...widget, path });
    else if (target.kind === 'field') set(target.key, path);
    else if (target.kind === 'list') {
      const list = Array.isArray(widget.config[target.key]) ? (widget.config[target.key] as string[]) : [];
      if (!list.includes(path)) set(target.key, [...list, path]);
    } else {
      const rows = (widget.config[target.key] as PairRow[] | undefined) ?? [];
      set(target.key, rows.map((r, j) => (j === target.row ? { ...r, [target.side]: path } : r)));
    }
  };

  const changeType = (type: WidgetType) => {
    const next = WIDGETS[type].defaults();
    onChange({ ...widget, type, config: next.config, path: WIDGETS[type].usesPath ? (widget.path ?? next.path) : null, label: widget.label ?? next.label });
  };

  const siText = (() => {
    if (!widget.path || !source || source.ageMs === null) return null;
    const d = describePath(widget.path, source.value);
    const raw = typeof source.value === 'number' ? `${Number(source.value.toFixed(3))} ${d.siUnit}` : String(source.value);
    return `Source value ${raw}, shown as ${fmtInline(widget.path, source.value, prefs)}`;
  })();

  return (
    <div className="stack widget-settings" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="panel-title">Widget settings</h2>
        <button type="button" className="link-button link-button--danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <FormField label="Type">
        {(id) => (
          <select id={id} className="select" value={widget.type} onChange={(e) => changeType(e.target.value as WidgetType)}>
            {WIDGET_TYPES.map((t) => (
              <option key={t} value={t}>
                {WIDGETS[t].title}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label="Label" hint="Blank uses the path's name">
        {(id) => <input id={id} className="input" value={widget.label ?? ''} onChange={(e) => onChange({ ...widget, label: e.target.value === '' ? null : e.target.value })} />}
      </FormField>
      {def.usesPath ? (
        <div className="field">
          <span className="field__label">Signal K path</span>
          <PathChip path={widget.path} picking={target?.kind === 'main'} onPick={() => setTarget({ kind: 'main' })} />
          {siText ? <span className="field__hint">{siText}</span> : null}
        </div>
      ) : null}
      {def.settings.map((f) => (
        <SettingInput key={f.key} field={f} widget={widget} set={set} target={target} setTarget={setTarget} />
      ))}
      {def.thresholds && widget.path ? <ThresholdFields path={widget.path} label={widget.label ?? describePath(widget.path).label} /> : null}
      <div className="panel-divider stack" style={{ gap: 8 }}>
        <h2 className="panel-title panel-title--sm">Path browser</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }} role="status">
          {target ? `Picking for ${targetText(target, def.settings)}.` : 'Choose a path setting above, then pick a path here.'}
        </p>
        <PathBrowser selected={target?.kind === 'main' ? widget.path : null} onSelect={pick} />
      </div>
    </div>
  );
}
