// HA hot backups: the live database and its WAL are excluded from the backup;
// backup_pre runs `data-hub-snapshot`, which writes a consistent copy with
// SQLite's online backup API. On startup, if the live database is missing
// and a snapshot exists, restore from it. That is how an HA restore brings
// the database back.

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write a consistent copy of `dbFile` to `snapshotFile` while logging continues. */
export async function takeSnapshot(dbFile: string, snapshotFile: string): Promise<void> {
  mkdirSync(dirname(snapshotFile), { recursive: true });
  const tmp = `${snapshotFile}.tmp`;
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    await db.backup(tmp);
  } finally {
    db.close();
  }
  // Atomic replace, so a crash mid-backup never leaves a half-written snapshot.
  renameSync(tmp, snapshotFile);
}

/** Restore the snapshot if the live database is missing. Returns true if it did. */
export function restoreIfMissing(dbFile: string, snapshotFile: string): boolean {
  if (existsSync(dbFile) || !existsSync(snapshotFile)) return false;
  mkdirSync(dirname(dbFile), { recursive: true });
  copyFileSync(snapshotFile, dbFile);
  return true;
}

export function snapshotTime(snapshotFile: string): string | null {
  return existsSync(snapshotFile) ? statSync(snapshotFile).mtime.toISOString() : null;
}
