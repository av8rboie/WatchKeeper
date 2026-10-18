// The widget registry. Adding a widget is one file plus an entry here.

import type { WidgetType } from '@watchkeeper/shared';
import { battery } from './battery';
import { clock } from './clock';
import { depth } from './depth';
import { gauge } from './gauge';
import { heading } from './heading';
import { link } from './link';
import { numeric } from './numeric';
import { position } from './position';
import { tank } from './tank';
import { text } from './text';
import { trend } from './trend';
import { twin } from './twin';
import type { WidgetDef } from './types';
import { wind } from './wind';

export const WIDGETS: Record<WidgetType, WidgetDef> = {
  numeric,
  gauge,
  wind,
  heading,
  depth,
  trend,
  twin,
  battery,
  tank,
  position,
  text,
  clock,
  link,
};

export type { SettingField, WidgetDef } from './types';
