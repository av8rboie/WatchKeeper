// Writing log entries. Entries are append-only (enforced by triggers); this
// module only inserts. M3 adds the full snapshot builder and the hourly
// scheduler on top.

import { ulid } from 'ulid';
import { iso } from '../clock.js';
import type { DB } from '../db/index.js';

export type LogKind = 'hourly' | 'event' | 'manual' | 'anchor' | 'checklist' | 'system';

export interface NewLogEntry {
  /** Entry time, epoch ms: GPS time when fresh (see TimeSource). */
  ts: number;
  kind: LogKind;
  eventType?: string | null;
  /** Raw SI values; null for stale or missing. */
  snapshot: Record<string, unknown>;
  remarks?: string | null;
  createdBy?: string | null;
}

/** Insert one entry, attached to the active passage if there is one. Written immediately, not buffered. */
export function writeLogEntry(db: DB, e: NewLogEntry): string {
  const id = ulid(e.ts);
  const passage = db.prepare('SELECT id FROM passage WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get() as { id: string } | undefined;
  db.prepare(
    `INSERT INTO log_entry (id, passage_id, ts, kind, event_type, snapshot, crew_fields, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
  ).run(id, passage?.id ?? null, iso(e.ts), e.kind, e.eventType ?? null, JSON.stringify(e.snapshot), e.remarks ?? null, e.createdBy ?? null);
  return id;
}
