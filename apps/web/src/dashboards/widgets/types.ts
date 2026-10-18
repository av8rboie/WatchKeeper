import type { ComponentType } from 'react';
import type { Widget, WidgetType } from '@watchkeeper/shared';

/**
 * A setting in the edit panel. Numbers bound to a path (`unitOf`) are edited
 * in the user's units and stored in SI, like everything else.
 */
export type SettingField =
  | { key: string; label: string; kind: 'number'; min?: number; max?: number; step?: number; unitOf?: 'path' | string; hint?: string }
  | { key: string; label: string; kind: 'text'; placeholder?: string; hint?: string }
  | { key: string; label: string; kind: 'select'; options: { value: string; label: string }[] }
  | { key: string; label: string; kind: 'path'; hint?: string }
  | { key: string; label: string; kind: 'paths'; max: number; hint?: string }
  | { key: string; label: string; kind: 'pairs'; hint?: string };

export interface WidgetDef {
  type: WidgetType;
  /** Name in the widget type picker. */
  title: string;
  Component: ComponentType<{ widget: Widget }>;
  /** Whether the widget binds to one main path (picked with the path browser). */
  usesPath: boolean;
  /** Label, path and config for a new widget of this type. */
  defaults: () => Pick<Widget, 'label' | 'path' | 'config'>;
  settings: SettingField[];
  /** Whether the edit panel offers warn/alarm limits (thresholds on the main path). */
  thresholds?: boolean;
}
