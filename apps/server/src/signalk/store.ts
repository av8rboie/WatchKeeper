import { EventEmitter } from 'node:events';
import { describePath, effectiveStaleMs, type PathDef } from '@watchkeeper/shared';
import type { Clock } from '../clock.js';

interface Entry {
  value: unknown;
  updatedAt: number;
  /** Set on disconnect; cleared by the next update for this path. */
  forcedStale: boolean;
}

export interface Reading {
  /** Last value received, even if stale. Display only; never store it when stale. */
  value: unknown;
  updatedAt: number | null;
  ageMs: number | null;
  stale: boolean;
}

/**
 * Latest value per Signal K path plus the staleness tracker. A value is stale
 * once its age exceeds the path's effective timeout (the larger of the catalog
 * value and three times its period), when it has never been seen, or while the
 * Signal K connection is down.
 */
export class LiveStore extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private readonly defs = new Map<string, PathDef>();

  constructor(private readonly clock: Clock) {
    super();
  }

  def(path: string, sample?: unknown): PathDef {
    let d = this.defs.get(path);
    if (!d) {
      d = describePath(path, sample);
      this.defs.set(path, d);
    }
    return d;
  }

  update(path: string, value: unknown, at = this.clock.now()): void {
    this.def(path, value);
    this.entries.set(path, { value, updatedAt: at, forcedStale: false });
    this.emit('update', path, value, at);
  }

  markAllStale(): void {
    for (const e of this.entries.values()) e.forcedStale = true;
    this.emit('allStale');
  }

  read(path: string, now = this.clock.now()): Reading {
    const e = this.entries.get(path);
    if (!e) return { value: null, updatedAt: null, ageMs: null, stale: true };
    const ageMs = Math.max(0, now - e.updatedAt);
    const timeout = effectiveStaleMs(this.def(path));
    const stale = e.forcedStale || (timeout !== null && ageMs > timeout);
    return { value: e.value, updatedAt: e.updatedAt, ageMs, stale };
  }

  /** The value if fresh, otherwise null. This is what gets stored. */
  fresh(path: string, now = this.clock.now()): unknown {
    const r = this.read(path, now);
    return r.stale ? null : r.value;
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }
}
