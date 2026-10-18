import { ulid } from 'ulid';
import {
  completeLayouts,
  DashboardInputSchema,
  DashboardSchema,
  type Dashboard,
  type DashboardInput,
  type DashboardSummary,
  type LayoutItem,
  type Layouts,
  type Widget,
} from '@watchkeeper/shared';
import { iso, type Clock } from '../clock.js';
import type { DB } from '../db/index.js';

interface DashboardRow {
  id: string;
  name: string;
  sort: number;
  layouts: string;
  updated_at: string;
}

interface WidgetRow {
  id: string;
  type: string;
  label: string | null;
  path: string | null;
  config: string;
}

type WidgetInput = Omit<Widget, 'id'> & { id?: string };

/**
 * Dashboards and their widgets. Every write stores complete layouts for all
 * three breakpoints, so a widget missing from one is placed at the bottom
 * once, on save, and never moves on its own after that.
 */
export class Dashboards {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  list(): DashboardSummary[] {
    const rows = this.db.prepare('SELECT id, name, sort, updated_at FROM dashboard ORDER BY sort, name').all() as DashboardRow[];
    return rows.map((r) => ({ id: r.id, name: r.name, sort: r.sort, updatedAt: r.updated_at }));
  }

  get(id: string): Dashboard | null {
    const row = this.db.prepare('SELECT * FROM dashboard WHERE id = ?').get(id) as DashboardRow | undefined;
    if (!row) return null;
    const widgets = (this.db.prepare('SELECT id, type, label, path, config FROM widget WHERE dashboard_id = ? ORDER BY sort').all(id) as WidgetRow[]).map(
      (w): Widget => ({ id: w.id, type: w.type as Widget['type'], label: w.label, path: w.path, config: JSON.parse(w.config) as Record<string, unknown> }),
    );
    return DashboardSchema.parse({ id: row.id, name: row.name, sort: row.sort, layouts: JSON.parse(row.layouts) as Layouts, widgets, updatedAt: row.updated_at });
  }

  /** A new dashboard. Widgets always get fresh ids (an import may carry ids already in use). */
  create(input: DashboardInput): Dashboard {
    const data = DashboardInputSchema.parse(input);
    const id = ulid(this.clock.now());
    const sort = data.sort ?? ((this.db.prepare('SELECT MAX(sort) AS m FROM dashboard').get() as { m: number | null }).m ?? -1) + 1;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO dashboard (id, name, sort, layouts, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, data.name, sort, '{}', iso(this.clock.now()));
      this.writeWidgets(id, data.widgets, data.layouts, true);
    })();
    return this.get(id)!;
  }

  /** Replace name, order and widgets. Widget ids are kept, and so are layouts unless given. */
  replace(id: string, input: DashboardInput): Dashboard | null {
    const existing = this.get(id);
    if (!existing) return null;
    const data = DashboardInputSchema.parse(input);
    this.db.transaction(() => {
      this.db.prepare('UPDATE dashboard SET name = ?, sort = ? WHERE id = ?').run(data.name, data.sort ?? existing.sort, id);
      this.db.prepare('DELETE FROM widget WHERE dashboard_id = ?').run(id);
      this.writeWidgets(id, data.widgets, data.layouts ?? existing.layouts, false);
    })();
    return this.get(id);
  }

  /** Replace only the given breakpoints' layouts; the others stay exactly as they were. */
  setLayouts(id: string, layouts: Partial<Layouts>): Dashboard | null {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = completeLayouts({ ...existing.layouts, ...layouts }, existing.widgets);
    this.db.prepare('UPDATE dashboard SET layouts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), iso(this.clock.now()), id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM dashboard WHERE id = ?').run(id).changes > 0;
  }

  private writeWidgets(dashboardId: string, widgets: WidgetInput[], layouts: Partial<Layouts> | undefined, freshIds: boolean): void {
    const insert = this.db.prepare('INSERT INTO widget (id, dashboard_id, type, label, path, config, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const taken = this.db.prepare('SELECT 1 FROM widget WHERE id = ?');
    const now = this.clock.now();
    const rename = new Map<string, string>();
    const saved = widgets.map((w, i) => {
      let id = w.id;
      if (freshIds || !id || rename.has(id) || taken.get(id)) {
        id = ulid(now);
        if (w.id && !rename.has(w.id)) rename.set(w.id, id);
      } else {
        rename.set(id, id);
      }
      insert.run(id, dashboardId, w.type, w.label ?? null, w.path ?? null, JSON.stringify(w.config ?? {}), i);
      return { id, type: w.type };
    });
    // Layout items follow their widget to its new id; items for unknown ids are dropped by completeLayouts.
    const remap = (items: LayoutItem[] | undefined) => (items ?? []).map((l) => ({ ...l, i: rename.get(l.i) ?? l.i }));
    const complete = completeLayouts({ phone: remap(layouts?.phone), tablet: remap(layouts?.tablet), desktop: remap(layouts?.desktop) }, saved);
    this.db.prepare('UPDATE dashboard SET layouts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(complete), iso(now), dashboardId);
  }
}
