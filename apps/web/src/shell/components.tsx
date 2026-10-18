// The shared component inventory from the build spec. Build once, reuse.

import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type TileState = 'normal' | 'warn' | 'alarm' | 'stale' | 'missing';

export function Tile(props: { label: string; value: string; unit?: string; sub?: ReactNode; state?: TileState; side?: ReactNode; className?: string }) {
  const state = props.state ?? 'normal';
  return (
    <div className={`tile tile--${state} ${props.className ?? ''}`} data-state={state}>
      <div className="label">{props.label}</div>
      <div className="tile__value">
        <span className="tile__num">{props.value}</span>
        {props.unit ? <span className="tile__unit">{props.unit}</span> : null}
        {props.side}
      </div>
      {props.sub ? <div className="tile__sub">{props.sub}</div> : null}
    </div>
  );
}

export type PillTone = 'neutral' | 'good' | 'warn' | 'alarm' | 'stale';

/** Status always carries a text label, never color alone. */
export function StatusPill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

export function SegmentedControl<T extends string>(props: { label: string; options: { value: T; label: string }[]; value: T; onChange(v: T): void }) {
  return (
    <div className="segmented" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 44 px icon-only button. `aria-label` is required by the type. */
export function IconButton({ 'aria-label': label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { 'aria-label': string }) {
  return <button type="button" aria-label={label} className={`icon-button ${className ?? ''}`} {...rest} />;
}

export function PrimaryButton({ cockpit, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { cockpit?: boolean }) {
  return <button type="button" className={`button button--primary ${cockpit ? 'button--cockpit' : ''} ${className ?? ''}`} {...rest} />;
}

export function Button({ danger, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return <button type="button" className={`button ${danger ? 'button--danger' : ''} ${className ?? ''}`} {...rest} />;
}

export function Card({ title, children, className, actions }: { title?: string; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {title || actions ? (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          {title ? <h2 className="card__title" style={{ margin: 0 }}>{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function FilterChips<T extends string>(props: { label: string; options: { value: T; label: string }[]; value: T; onChange(v: T): void }) {
  return (
    <div className="chips" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Label always visible, never placeholder-only. */
export function FormField(props: { label: string; hint?: string; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {props.label}
      </label>
      {props.children(id)}
      {props.hint ? <span className="field__hint">{props.hint}</span> : null}
      {props.error ? (
        <span className="field__error" role="alert">
          {props.error}
        </span>
      ) : null}
    </div>
  );
}

export function formatAge(ms: number | null): string {
  if (ms === null) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
