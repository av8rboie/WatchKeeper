import type { FastifyInstance } from 'fastify';
import { effectiveStaleMs, PathInfoSchema, type PathInfo } from '@watchkeeper/shared';
import { z } from 'zod';
import type { AppContext } from '../app.js';

interface Leaf {
  value: unknown;
  timestamp?: string;
}

const SKIP_KEYS = new Set(['meta', '$source', 'values', 'timestamp', 'pgn', 'sentence']);

/** Flatten a Signal K vessels/self tree into path -> leaf. */
export function flattenSignalK(node: unknown, prefix = '', out = new Map<string, Leaf>()): Map<string, Leaf> {
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;
  if ('value' in obj && prefix) {
    out.set(prefix, { value: obj.value, timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined });
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEYS.has(k)) continue;
    flattenSignalK(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]).catch(() => null);
}

export function registerPathRoutes(api: FastifyInstance, ctx: AppContext): void {
  // Catalog merged with everything Signal K publishes, with current value and age.
  api.get('/paths', { config: { minRole: 'guest' } }, async () => {
    const now = ctx.clock.now();
    const catalog = new Set(ctx.catalogPaths());
    const snapshot = ctx.fetchSelf ? await withTimeout(ctx.fetchSelf(), 1500) : null;
    const leaves = snapshot ? flattenSignalK(snapshot) : new Map<string, Leaf>();
    const all = new Set([...catalog, ...ctx.store.paths(), ...leaves.keys()]);

    const out: PathInfo[] = [];
    for (const path of [...all].sort()) {
      const leaf = leaves.get(path);
      const def = ctx.store.def(path, leaf?.value);
      const live = ctx.store.read(path, now);
      let { value, ageMs, stale } = live;
      if (live.updatedAt === null && leaf) {
        // Not subscribed by the backend: use the REST snapshot.
        value = leaf.value;
        ageMs = leaf.timestamp ? Math.max(0, now - Date.parse(leaf.timestamp)) : null;
        const timeout = effectiveStaleMs(def);
        stale = ageMs === null || (timeout !== null && ageMs > timeout);
      }
      out.push({
        path,
        label: def.label,
        siUnit: def.siUnit,
        quantity: def.quantity,
        rateClass: def.rateClass,
        staleMs: effectiveStaleMs(def),
        inCatalog: catalog.has(path),
        live: catalog.has(path),
        value: value ?? null,
        ageMs,
        stale,
      });
    }
    return z.array(PathInfoSchema).parse(out);
  });
}
