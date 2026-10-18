import type { FastifyInstance } from 'fastify';
import {
  DASHBOARD_EXPORT_FORMAT,
  DashboardExportSchema,
  DashboardInputSchema,
  DEFAULT_INSTANCE_IDS,
  PutLayoutsSchema,
  type Dashboard,
  type DashboardExport,
  type InstanceIds,
} from '@watchkeeper/shared';
import type { AppContext } from '../app.js';
import { getSetting } from '../db/index.js';
import { starterDashboards } from '../dashboards/starter.js';

const notFound = { error: 'not_found', message: 'No such dashboard.' };

export function toExport(d: Dashboard): DashboardExport {
  return {
    format: DASHBOARD_EXPORT_FORMAT,
    version: 1,
    dashboard: { name: d.name, layouts: d.layouts, widgets: d.widgets },
  };
}

/** Guests read dashboards; only the skipper edits them. Every write tells other clients. */
export function registerDashboardRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { dashboards, hub } = ctx;
  const changed = (id: string) => hub.broadcast('dashboard.updated', { id });

  api.get('/dashboards', { config: { minRole: 'guest' } }, async () => dashboards.list());

  api.post('/dashboards', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const d = dashboards.create(DashboardInputSchema.parse(req.body));
    changed(d.id);
    return reply.code(201).send(d);
  });

  // Starter dashboards from what Signal K is publishing right now.
  api.post('/dashboards/starter', { config: { minRole: 'skipper' } }, async (_req, reply) => {
    const now = ctx.clock.now();
    const publishing = new Set(ctx.store.paths().filter((p) => !ctx.store.read(p, now).stale));
    const ids = getSetting<InstanceIds>(ctx.db, 'instanceIds', DEFAULT_INSTANCE_IDS);
    const created = starterDashboards(publishing, ids).map((input) => dashboards.create(input));
    for (const d of created) changed(d.id);
    return reply.code(201).send(dashboards.list());
  });

  api.post('/dashboards/import', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const body = DashboardExportSchema.parse(req.body);
    const d = dashboards.create(body.dashboard);
    changed(d.id);
    return reply.code(201).send(d);
  });

  api.get<{ Params: { id: string } }>('/dashboards/:id', { config: { minRole: 'guest' } }, async (req, reply) => {
    return dashboards.get(req.params.id) ?? reply.code(404).send(notFound);
  });

  api.put<{ Params: { id: string } }>('/dashboards/:id', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const d = dashboards.replace(req.params.id, DashboardInputSchema.parse(req.body));
    if (!d) return reply.code(404).send(notFound);
    changed(d.id);
    return d;
  });

  api.put<{ Params: { id: string } }>('/dashboards/:id/layouts', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const d = dashboards.setLayouts(req.params.id, PutLayoutsSchema.parse(req.body).layouts);
    if (!d) return reply.code(404).send(notFound);
    changed(d.id);
    return d;
  });

  api.delete<{ Params: { id: string } }>('/dashboards/:id', { config: { minRole: 'skipper' } }, async (req, reply) => {
    if (!dashboards.remove(req.params.id)) return reply.code(404).send(notFound);
    changed(req.params.id);
    return { ok: true };
  });

  api.get<{ Params: { id: string } }>('/dashboards/:id/export', { config: { minRole: 'guest' } }, async (req, reply) => {
    const d = dashboards.get(req.params.id);
    if (!d) return reply.code(404).send(notFound);
    const file = `${d.name.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase() || 'dashboard'}.dashboard.json`;
    return reply.header('content-disposition', `attachment; filename="${file}"`).send(toExport(d));
  });
}
