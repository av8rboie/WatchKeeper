import { ulid } from 'ulid';
import { iso } from '../clock.js';
import type { GapRecorder } from '../signalk/client.js';
import type { DB } from './index.js';

/** Records periods when the Signal K connection was down. */
export class ConnectionGaps implements GapRecorder {
  constructor(private readonly db: DB) {}

  open(atMs: number): void {
    this.db.prepare('INSERT INTO connection_gap (id, started_at, ended_at) VALUES (?, ?, NULL)').run(ulid(atMs), iso(atMs));
  }

  close(atMs: number): void {
    this.db.prepare('UPDATE connection_gap SET ended_at = ? WHERE ended_at IS NULL').run(iso(atMs));
  }

  list(): { id: string; started_at: string; ended_at: string | null }[] {
    return this.db.prepare('SELECT * FROM connection_gap ORDER BY started_at').all() as {
      id: string;
      started_at: string;
      ended_at: string | null;
    }[];
  }
}
