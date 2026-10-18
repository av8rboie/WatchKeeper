import type { FastifyInstance } from 'fastify';
import { SystemStatusSchema, type SystemStatus } from '@watchkeeper/shared';
import type { AppContext } from '../app.js';
import { iso } from '../clock.js';
import { getSetting } from '../db/index.js';
import { BROWSER_TOKEN, DEVICE_TOKEN, readToken } from '../signalk/deviceAuth.js';
import { clockStatus, diskStatus } from '../system/status.js';

export async function systemStatus(ctx: AppContext): Promise<SystemStatus> {
  const now = ctx.clock.now();
  const gps = ctx.store.read('navigation.position', now);
  const passage = ctx.db.prepare('SELECT name FROM passage WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get() as
    | { name: string }
    | undefined;
  const sk = ctx.signalk;
  return SystemStatusSchema.parse({
    signalk: {
      connected: sk?.connected ?? false,
      url: ctx.config.signalkUrl,
      since: sk?.connectedSince ? iso(sk.connectedSince) : null,
      authorized: readToken(ctx.config.configDir, DEVICE_TOKEN) !== null || readToken(ctx.config.configDir, BROWSER_TOKEN) !== null,
    },
    gps: { fix: !gps.stale, ageMs: gps.ageMs },
    clock: await clockStatus(),
    disk: diskStatus(ctx.config.dataDir),
    lastBackup: getSetting<string | null>(ctx.db, 'lastBackupAt', null),
    passage: { active: passage !== undefined, name: passage?.name ?? null },
    serverTime: iso(now),
    version: ctx.config.version,
  });
}

export function registerSystemRoutes(api: FastifyInstance, ctx: AppContext): void {
  api.get('/system/status', { config: { minRole: 'guest' } }, async () => systemStatus(ctx));
}
