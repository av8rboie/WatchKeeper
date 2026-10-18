import type { FastifyInstance } from 'fastify';
import { DerivedSettingsSchema, SystemStatusSchema, type DerivedSettings, type SystemStatus } from '@watchkeeper/shared';
import type { AppContext } from '../app.js';
import { iso } from '../clock.js';
import { getSetting, setSetting } from '../db/index.js';
import { DEFAULT_DERIVED_SETTINGS } from '../derived/engine.js';
import { snapshotTime } from '../db/snapshot.js';
import { DEVICE_TOKEN, readToken } from '../signalk/deviceAuth.js';
import { cpuTemperature, DEFAULT_CPU_TEMP_ENTITY, diskStatus } from '../system/status.js';

export async function systemStatus(ctx: AppContext): Promise<SystemStatus> {
  const now = ctx.clock.now();
  const gps = ctx.store.read('navigation.position', now);
  const time = ctx.time.read();
  const passage = ctx.db.prepare('SELECT name FROM passage WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get() as
    | { name: string }
    | undefined;
  const sk = ctx.signalk;
  const access = ctx.accessState?.() ?? 'unknown';
  return SystemStatusSchema.parse({
    signalk: {
      connected: sk?.connected ?? false,
      url: ctx.config.signalkUrl,
      since: sk?.connectedSince ? iso(sk.connectedSince) : null,
      authorized: readToken(ctx.config.dataDir, DEVICE_TOKEN) !== null,
      accessRequest: ['approved', 'pending', 'denied', 'not-required', 'error'].includes(access) ? access : 'unknown',
    },
    gps: { fix: !gps.stale, ageMs: gps.ageMs },
    time: { source: time.source, now: iso(time.now), driftMs: time.driftMs },
    cpuTempC: await cpuTemperature(ctx.ha, getSetting(ctx.db, 'cpuTempEntity', DEFAULT_CPU_TEMP_ENTITY)),
    disk: diskStatus(ctx.config.dataDir),
    lastSnapshot: snapshotTime(ctx.config.snapshotFile),
    passage: { active: passage !== undefined, name: passage?.name ?? null },
    version: ctx.config.version,
  });
}

export function registerSystemRoutes(api: FastifyInstance, ctx: AppContext): void {
  api.get('/system/status', { config: { minRole: 'guest' } }, async () => systemStatus(ctx));

  // Battery capacity and floor for time to empty: placeholders until the skipper confirms them.
  const derived = () => DerivedSettingsSchema.parse({ ...DEFAULT_DERIVED_SETTINGS, ...getSetting<Partial<DerivedSettings>>(ctx.db, 'derived', {}) });
  api.get('/settings/derived', { config: { minRole: 'guest' } }, async () => derived());
  api.put('/settings/derived', { config: { minRole: 'skipper' } }, async (req) => {
    setSetting(ctx.db, 'derived', DerivedSettingsSchema.parse(req.body));
    return derived();
  });
}
