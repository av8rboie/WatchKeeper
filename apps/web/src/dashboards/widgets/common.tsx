// Shared pieces for widgets: unit-aware formatting, tile states from staleness
// and thresholds, and the tile shell every widget renders into.

import type { ReactNode } from 'react';
import {
  converterFor,
  DEFAULT_UNIT_PREFS,
  describePath,
  formatValue,
  thresholdLevel,
  type Threshold,
  type UnitPrefs,
  type Widget,
} from '@watchkeeper/shared';
import { useMe } from '../../api/client';
import type { LiveReading } from '../../live/socket';
import { formatAge, type TileState } from '../../shell/components';
import { useThresholds } from '../api';

export interface WidgetProps {
  widget: Widget;
}

export function usePrefs(): UnitPrefs {
  return useMe().data?.unitPrefs ?? DEFAULT_UNIT_PREFS;
}

export function useThresholdFor(path: string | null | undefined): Threshold | null {
  const list = useThresholds().data;
  return (path && list?.find((t) => t.path === path && t.enabled)) || null;
}

export interface Shown {
  text: string;
  unit: string;
  side?: 'PORT' | 'STBD' | null;
}

/** A path's value in the user's units. */
export function fmt(path: string, value: unknown, prefs: UnitPrefs, decimals?: number): Shown {
  return formatValue(describePath(path, value).quantity, value, prefs, decimals);
}

/** "7.1 kn", "146°T", "13.2 V": value and unit as one string. */
export function fmtInline(path: string, value: unknown, prefs: UnitPrefs, decimals?: number): string {
  const f = fmt(path, value, prefs, decimals);
  const unit = f.unit && !f.unit.startsWith('°') ? ` ${f.unit}` : f.unit;
  return `${f.text}${unit}${f.side ? ` ${f.side}` : ''}`;
}

/** Missing (never seen), stale, or the threshold band of a fresh numeric value. */
export function tileState(r: LiveReading | undefined, threshold?: Threshold | null): TileState {
  if (!r || r.ageMs === null) return 'missing';
  if (r.stale) return 'stale';
  if (threshold && typeof r.value === 'number') {
    const level = thresholdLevel(threshold, r.value);
    if (level !== 'normal') return level;
  }
  return 'normal';
}

/** Why a derived value has nothing to show: it only exists in some conditions. */
const DERIVED_WHEN: Record<string, string> = {
  'dataHub.electrical.timeToEmpty': 'Only while discharging',
  'dataHub.fuel.range': 'Only while burning fuel and moving',
  'dataHub.environment.pressureTendency': 'Needs 3 h of barometer history',
  'dataHub.navigation.run24h': 'Starts after the first hour recorded',
  'dataHub.environment.current.setTrue': 'Needs COG, SOG, heading and STW',
  'dataHub.environment.current.drift': 'Needs COG, SOG, heading and STW',
};

export function staleText(r: LiveReading | undefined, path?: string | null): string {
  const when = path ? DERIVED_WHEN[path] : undefined;
  if (!r || r.ageMs === null) return when ?? 'No data';
  return when ? `${when} · last ${formatAge(r.ageMs)} ago` : `Stale · no update ${formatAge(r.ageMs)}`;
}

/** Short labels for sub lines; anything else uses the catalog label. */
const SHORT: Record<string, string> = {
  'navigation.speedThroughWater': 'STW',
  'navigation.speedOverGround': 'SOG',
  'navigation.courseOverGroundTrue': 'COG',
  'navigation.headingTrue': 'HDG',
  'steering.autopilot.state': 'AP',
  'dataHub.fuel.range': 'Range at this burn:',
};

/** A 3 h fall past this (Pa) is the logbook's pressure-drop trigger; shown as a warning. */
const PRESSURE_DROP_PA = -200;

/** One secondary value under the main one, e.g. "STW 7.1 kn". Nothing while it has no data. */
export function subText(path: string, r: LiveReading | undefined, prefs: UnitPrefs): { text: string; tone?: 'warn' } | null {
  if (!r || r.ageMs === null || r.stale) return null;
  if (path === 'dataHub.environment.pressureTendency' && typeof r.value === 'number') {
    const c = converterFor('pressure', prefs);
    const amount = c.toDisplay(Math.abs(r.value)).toFixed(prefs.pressure === 'inHg' ? 2 : 1);
    if (Math.abs(r.value) < 50) return { text: 'Steady over 3 h' };
    return { text: `${r.value < 0 ? 'Falling' : 'Rising'} ${amount} in 3 h`, tone: r.value <= PRESSURE_DROP_PA ? 'warn' : undefined };
  }
  const label = SHORT[path] ?? describePath(path).label;
  return { text: `${label} ${fmtInline(path, r.value, prefs)}` };
}

export function WidgetTile(props: { label: string; state: TileState; children: ReactNode; className?: string }) {
  return (
    <div className={`tile widget tile--${props.state} ${props.className ?? ''}`} data-state={props.state}>
      <div className="label widget__label">{props.label}</div>
      {props.children}
    </div>
  );
}

/** The big number with its unit, as on every tile. */
export function BigValue({ shown, size }: { shown: Shown; size?: 'md' | 'lg' }) {
  return (
    <div className="tile__value">
      <span className={`tile__num ${size === 'md' ? 'tile__num--md' : ''}`}>{shown.text}</span>
      {shown.unit ? <span className="tile__unit">{shown.unit}</span> : null}
      {shown.side ? <span className={`tile__side tile__side--${shown.side.toLowerCase()}`}>{shown.side}</span> : null}
    </div>
  );
}

export function cfg<T>(widget: Widget, key: string, fallback: T): T {
  const v = widget.config?.[key];
  return v === undefined || v === null ? fallback : (v as T);
}
