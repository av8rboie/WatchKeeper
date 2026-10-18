import type { FastifyInstance } from 'fastify';
import { expandCatalog } from '@watchkeeper/shared';
import { buildApp } from '../../src/app.js';
import { EventHub } from '../../src/api/events.js';
import { ManualClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { LiveStore } from '../../src/signalk/store.js';
import { T0 } from './fixtures.js';

export async function makeApp(clock = new ManualClock(T0)) {
  const db = openDb(':memory:');
  const store = new LiveStore(clock);
  const config = { ...loadConfig({ DATA_DIR: '.data/test', COOKIE_SECURE: 'false' }), configDir: '.data/test/config-none' };
  const app = await buildApp({
    db,
    config,
    clock,
    store,
    hub: new EventHub(),
    signalk: null,
    catalogPaths: () => expandCatalog().map((d) => d.path),
  });
  await app.ready();
  return { app, db, store, clock, users: app.ctx.users };
}

/** Log in and return the Cookie header value for later requests. */
export async function login(app: FastifyInstance, userId: string, pin: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { userId, pin } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const set = res.cookies.find((c) => c.name === 'dh_session');
  if (!set) throw new Error('no session cookie');
  return `dh_session=${set.value}`;
}
