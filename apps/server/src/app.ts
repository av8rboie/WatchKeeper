import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { roleAtLeast, type Role } from '@watchkeeper/shared';
import { registerAuthRoutes } from './api/auth.js';
import type { EventHub } from './api/events.js';
import { registerPathRoutes } from './api/paths.js';
import { registerSystemRoutes } from './api/system.js';
import { Sessions, Users, type SessionUser } from './auth/users.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import type { SignalKClient } from './signalk/client.js';
import type { LiveStore } from './signalk/store.js';

/** Minimum role for a route. `public` needs no session. */
export type MinRole = Role | 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    minRole?: MinRole;
  }
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export const SESSION_COOKIE = 'dh_session';
export const API_PREFIX = '/api/v1';

export interface AppDeps {
  db: DB;
  config: Config;
  clock: Clock;
  store: LiveStore;
  hub: EventHub;
  signalk: SignalKClient | null;
  /** Concrete catalog paths for this boat (instance ids applied). */
  catalogPaths: () => string[];
  /** Signal K REST snapshot of vessels/self, for paths outside the catalog. */
  fetchSelf?: () => Promise<unknown>;
}

export interface RouteInfo {
  method: string;
  url: string;
  minRole: MinRole;
}

export interface AppContext extends AppDeps {
  users: Users;
  sessions: Sessions;
  /** Every API route and its minimum role. The role tests walk this list. */
  routes: RouteInfo[];
  setSessionCookie(reply: FastifyReply, token: string, expiresAt: number): void;
}

export async function buildApp(deps: AppDeps, opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  const users = new Users(deps.db, deps.clock);
  const sessions = new Sessions(deps.db, deps.clock);

  const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: number) => {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: deps.config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      expires: new Date(expiresAt),
    });
  };
  const ctx: AppContext = { ...deps, users, sessions, routes: [], setSessionCookie };
  app.decorate('ctx', ctx);

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

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const minRole = req.routeOptions.config?.minRole;
    if (minRole === undefined) return;
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const s = sessions.resolve(token);
      if (s) {
        req.user = users.get(s.userId);
        if (s.slid) setSessionCookie(reply, token, s.expiresAt);
      }
    }
    if (minRole === 'public') return;
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    if (!roleAtLeast(req.user.role, minRole)) return reply.code(403).send({ error: 'forbidden' });
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
      registerAuthRoutes(api, ctx);
      registerPathRoutes(api, ctx);
      registerSystemRoutes(api, ctx);
      api.get('/events', { websocket: true, config: { minRole: 'guest' } }, (socket) => deps.hub.add(socket));
    },
    { prefix: API_PREFIX },
  );

  const dist = deps.config.webDist;
  if (dist && existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
