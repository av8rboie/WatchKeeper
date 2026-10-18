import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { expandCatalog } from '@watchkeeper/shared';
import { buildApp } from '../../src/app.js';
import { EventHub } from '../../src/api/events.js';
import { ManualClock } from '../../src/clock.js';
import { loadConfig, SUPERVISOR_INGRESS_PROXY } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { FakeHaClient } from '../../src/ha/client.js';
import { LiveStore } from '../../src/signalk/store.js';
import { TimeSource } from '../../src/signalk/time.js';
import { T0 } from './fixtures.js';

export async function makeApp(clock = new ManualClock(T0)) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dh-app-'));
  const db = openDb(':memory:');
  const store = new LiveStore(clock);
  const ha = new FakeHaClient();
  const config = loadConfig({ DATA_DIR: dataDir });
  const app = await buildApp({
    db,
    config,
    clock,
    store,
    hub: new EventHub(store, () => clock.now()),
    signalk: null,
    time: new TimeSource(store, clock),
    ha,
    catalogPaths: () => expandCatalog().map((d) => d.path),
  });
  await app.ready();
  return { app, db, store, clock, ha, users: app.ctx.users };
}

export interface HaUser {
  id: string;
  name: string;
}

export const SKIPPER: HaUser = { id: 'ha-skipper', name: 'Skipper' };
export const CREW: HaUser = { id: 'ha-crew', name: 'Crew' };
export const GUEST: HaUser = { id: 'ha-guest', name: 'Helm phone' };

/** A request as HA ingress delivers it: from the Supervisor's proxy, with user headers. */
export function ingress(app: FastifyInstance, user: HaUser | null, opts: InjectOptions & { cookie?: string }) {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (user) {
    headers['x-remote-user-id'] = user.id;
    headers['x-remote-user-name'] = user.name.toLowerCase();
    headers['x-remote-user-display-name'] = user.name;
  }
  if (opts.cookie) headers.cookie = opts.cookie;
  return app.inject({ ...opts, headers, remoteAddress: SUPERVISOR_INGRESS_PROXY });
}

/** Skipper, crew with helm PIN 2222, and an unmapped guest. */
export async function seedUsers(app: FastifyInstance): Promise<void> {
  const { users } = app.ctx;
  for (const u of [SKIPPER, CREW, GUEST]) users.seen(u.id, u.name);
  await users.setMapping(SKIPPER.id, 'skipper', '1111');
  await users.setMapping(CREW.id, 'crew', '2222');
}
