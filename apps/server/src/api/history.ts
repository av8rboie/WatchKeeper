import type { FastifyInstance } from 'fastify';
import { describePath, HistoryQuerySchema, POSITION_LAT_SUFFIX, POSITION_LON_SUFFIX, type HistorySeries } from '@watchkeeper/shared';
import type { AppContext } from '../app.js';
import type { DB } from '../db/index.js';
import { RETENTION } from '../recorder/recorder.js';

type Resolution = HistorySeries['resolution'];

const TIER: Record<Resolution, { table: string; stepMs: number; columns: string }> = {
  '1s': { table: 'sample_1s', stepMs: 1000, columns: 'value AS a, value AS lo, value AS hi' },
  '1m': { table: 'sample_1m', stepMs: 60_000, columns: 'avg AS a, min AS lo, max AS hi' },
  '10m': { table: 'sample_10m', stepMs: 600_000, columns: 'avg AS a, min AS lo, max AS hi' },
};

/** The recorded path behind a history column (positions are stored as .latitude/.longitude). */
function sourcePath(col: string): string {
  if (col.endsWith(POSITION_LAT_SUFFIX)) return col.slice(0, -POSITION_LAT_SUFFIX.length);
  if (col.endsWith(POSITION_LON_SUFFIX)) return col.slice(0, -POSITION_LON_SUFFIX.length);
  return col;
}

/**
 * The finest tier that still holds data back to `from`: 1 s for fast paths
 * within the last 24 h, otherwise 1 min within 90 days, otherwise 10 min.
 */
export function pickTier(col: string, from: number, now: number): Resolution {
  const fast = describePath(sourcePath(col)).rateClass === 'fast';
  if (fast && from >= now - RETENTION.sample1sMs) return '1s';
  if (from >= now - RETENTION.sample1mMs) return '1m';
  return '10m';
}

/** Rows bucketed so at most `maxPoints` come back, keeping min and max across each bucket. */
export function querySeries(db: DB, col: string, from: number, to: number, maxPoints: number, now: number): HistorySeries {
  let resolution = pickTier(col, from, now);
  // No 1 s rows for the range (a gap, or recorded before the path was fast): use 1 min.
  if (resolution === '1s' && !db.prepare('SELECT 1 FROM sample_1s WHERE path = ? AND ts BETWEEN ? AND ? LIMIT 1').get(col, from, to)) {
    resolution = '1m';
  }
  const tier = TIER[resolution];
  const bucket = Math.max(tier.stepMs, Math.ceil((to - from) / maxPoints / tier.stepMs) * tier.stepMs);
  const rows = db
    .prepare(
      // better-sqlite3 binds JS numbers as REAL: cast so the division truncates.
      `SELECT (ts / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) AS t, AVG(a) AS a, MIN(lo) AS lo, MAX(hi) AS hi
       FROM (SELECT ts, ${tier.columns} FROM ${tier.table} WHERE path = @col AND ts BETWEEN @from AND @to)
       GROUP BY t ORDER BY t`,
    )
    .all({ bucket, col, from, to }) as { t: number; a: number | null; lo: number | null; hi: number | null }[];
  return { path: col, resolution, points: rows.map((r) => [r.t, r.a, r.lo, r.hi]) };
}

export function registerHistoryRoutes(api: FastifyInstance, ctx: AppContext): void {
  api.get('/history', { config: { minRole: 'guest' } }, async (req, reply) => {
    const q = HistoryQuerySchema.parse(req.query);
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (!(to > from)) return reply.code(400).send({ error: 'invalid_request', message: '`to` must be after `from`.' });
    const paths = [...new Set(q.paths.split(',').map((p) => p.trim()).filter(Boolean))].slice(0, 8);
    const now = ctx.clock.now();
    return paths.map((p) => querySeries(ctx.db, p, from, to, q.maxPoints, now));
  });
}
