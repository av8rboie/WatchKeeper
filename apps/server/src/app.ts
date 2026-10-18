import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { roleAtLeast, type Role, type UnitPrefs } from '@watchkeeper/shared';
import { AlarmEngine } from './alarms/engine.js';
import { Thresholds } from './alarms/thresholds.js';
import { registerAlarmRoutes } from './api/alarms.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerDashboardRoutes } from './api/dashboards.js';
import type { EventHub } from './api/events.js';
import { registerHistoryRoutes } from './api/history.js';
import { registerPathRoutes } from './api/paths.js';
import { registerSystemRoutes } from './api/system.js';
import { Dashboards } from './dashboards/store.js';
import { Elevations, Users } from './auth/users.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import type { HaClient } from './ha/client.js';
import type { SignalKClient } from './signalk/client.js';
import type { LiveStore } from './signalk/store.js';
import type { TimeSource } from './signalk/time.js';

/** Minimum role for a route. `public` needs no HA user (only the health check). */
export type MinRole = Role | 'public';

/** Who is making the request, after ingress headers and any PIN elevation. */
export interface RequestUser {
  /** HA user id from ingress. */
  haId: string;
  name: string;
  role: Role;
  roleSource: 'mapped' | 'unmapped' | 'pin';
  /** The crew member acting on a guest device, when elevated by PIN. */
  actingAs: { id: string; name: string; until: string } | null;
  /** The user id recorded on log entries and records: the acting crew member if elevated. */
  recordId: string;
  unitPrefs: UnitPrefs;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    minRole?: MinRole;
  }
  interface FastifyRequest {
    user: RequestUser | null;
  }
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export const ELEVATION_COOKIE = 'dh_elevation';
export const API_PREFIX = '/api/v1';
export const HEALTH_PATH = `${API_PREFIX}/health`;

export interface AppDeps {
  db: DB;
  config: Config;
  clock: Clock;
  store: LiveStore;
  hub: EventHub;
  signalk: SignalKClient | null;
  time: TimeSource;
  ha: HaClient;
  /** Concrete catalog paths for this boat (instance ids applied). */
  catalogPaths: () => string[];
  /** Signal K REST snapshot of vessels/self, for paths outside the catalog. */
  fetchSelf?: () => Promise<unknown>;
  /** Current state of the Signal K device access request. */
  accessState?: () => string;
}

export interface RouteInfo {
  method: string;
  url: string;
  minRole: MinRole;
}

export interface AppContext extends AppDeps {
  users: Users;
  elevations: Elevations;
  dashboards: Dashboards;
  thresholds: Thresholds;
  alarms: AlarmEngine;
  /** Every API route and its minimum role. The role tests walk this list. */
  routes: RouteInfo[];
}

/** IPv4-mapped IPv6 addresses (::ffff:172.30.32.2) compare as plain IPv4. */
const normalizeAddress = (a: string | undefined) => (a ?? '').replace(/^::ffff:/, '');

/** The ingress base path from HA, restricted to safe characters. */
function ingressBase(req: FastifyRequest): string {
  const raw = req.headers['x-ingress-path'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && /^\/[A-Za-z0-9/_-]*$/.test(v) ? v.replace(/\/$/, '') : '';
}

export async function buildApp(deps: AppDeps, opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  // No per-request logging: the watchdog polls /health, and every log line costs CPU on the boat.
  const app = Fastify({ logger: opts.logger ?? false, logController: new LogController({ disableRequestLogging: true }) });
  const users = new Users(deps.db, deps.clock);
  const elevations = new Elevations(deps.db, deps.clock);
  const thresholds = new Thresholds(deps.db, deps.clock);
  const alarms = new AlarmEngine({
    db: deps.db,
    store: deps.store,
    clock: deps.clock,
    time: deps.time,
    hub: deps.hub,
    thresholds,
    ha: deps.ha,
    sendToSignalK: deps.signalk ? (values) => deps.signalk!.send(values) : undefined,
    log: { warn: (msg) => app.log.warn(msg) },
  });
  const ctx: AppContext = { ...deps, users, elevations, dashboards: new Dashboards(deps.db, deps.clock), thresholds, alarms, routes: [] };
  app.decorate('ctx', ctx);
  const trusted = new Set(deps.config.trustedProxies.map(normalizeAddress));

  await app.register(cookie);
  await app.register(websocket);
  app.decorateRequest('user', null);

  // Every API route must declare who may call it.
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(API_PREFIX)) return;
    const minRole = route.config?.minRole;
    if (minRole === undefined) throw new Error(`Route ${String(route.method)} ${route.url} has no minRole`);
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') ctx.routes.push({ method, url: route.url, minRole });
    }
  });

  // Ingress only: anything not from the Supervisor's proxy is rejected, except
  // the health check the watchdog calls.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === HEALTH_PATH) return;
    if (!trusted.has(normalizeAddress(req.socket.remoteAddress))) {
      return reply.code(403).send({ error: 'forbidden', message: 'Data Hub is only reachable through Home Assistant ingress.' });
    }
  });

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const minRole = req.routeOptions.config?.minRole;
    if (minRole === undefined || minRole === 'public') return;
    const header = (h: string) => {
      const v = req.headers[h];
      return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
    };
    const haId = header('x-remote-user-id');
    if (!haId) return reply.code(401).send({ error: 'unauthorized', message: 'No Home Assistant user on the request.' });
    const name = header('x-remote-user-display-name') ?? header('x-remote-user-name') ?? haId;
    const me = users.seen(haId, name);

    let role: Role = me.role;
    let roleSource: RequestUser['roleSource'] = me.mapped ? 'mapped' : 'unmapped';
    let actingAs: RequestUser['actingAs'] = null;
    let recordId = me.id;
    const token = req.cookies[ELEVATION_COOKIE];
    if (token && role === 'guest') {
      const e = elevations.resolve(token, haId);
      const acting = e ? users.get(e.userId) : null;
      if (e && acting && acting.mapped && roleAtLeast(acting.role, 'crew')) {
        // A PIN elevates a guest device to crew, never beyond.
        role = 'crew';
        roleSource = 'pin';
        actingAs = { id: acting.id, name: acting.name, until: new Date(e.expiresAt).toISOString() };
        recordId = acting.id;
      }
    }
    req.user = { haId, name: me.name, role, roleSource, actingAs, recordId, unitPrefs: me.unitPrefs };
    if (!roleAtLeast(role, minRole)) return reply.code(403).send({ error: 'forbidden' });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'request_error', message: (err as Error).message });
  });

  await app.register(
    async (api) => {
      // HA watchdog: process up and database writable. Signal K being down is not a failure.
      api.get('/health', { config: { minRole: 'public' } }, async (_req, reply) => {
        try {
          deps.db.prepare('BEGIN IMMEDIATE').run();
          deps.db.prepare('ROLLBACK').run();
          return { ok: true };
        } catch (e) {
          return reply.code(503).send({ ok: false, error: (e as Error).message });
        }
      });
      registerAuthRoutes(api, ctx);
      registerPathRoutes(api, ctx);
      registerSystemRoutes(api, ctx);
      registerDashboardRoutes(api, ctx);
      registerAlarmRoutes(api, ctx);
      registerHistoryRoutes(api, ctx);
      api.get('/events', { websocket: true, config: { minRole: 'guest' } }, (socket) => deps.hub.add(socket));
    },
    { prefix: API_PREFIX },
  );

  // The web app. Ingress mounts it under a path HA chooses; index.html gets a
  // <base> for that path so every relative URL resolves under it.
  const dist = deps.config.webDist;
  if (dist && existsSync(join(dist, 'index.html'))) {
    const template = readFileSync(join(dist, 'index.html'), 'utf8');
    const renderIndex = (req: FastifyRequest, reply: FastifyReply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(template.replace('<head>', `<head><base href="${ingressBase(req)}/">`));
    await app.register(fastifyStatic, { root: join(dist, 'assets'), prefix: '/assets/', immutable: true, maxAge: '365d' });
    app.get('/', renderIndex);
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return renderIndex(req, reply);
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
