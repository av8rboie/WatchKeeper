import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Open the database with the pragmas the spec requires and run any pending
 * numbered migrations. `synchronous = FULL` is set on the connection because
 * the log tables share it; the cost is negligible at our write rate.
 */
export function openDb(file: string, migrationsDir = process.env.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrationsDir);
  return db;
}

export function migrate(db: DB, dir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migration')
      .all()
      .map((r) => (r as { version: string }).version),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    })();
    ran.push(f);
  }
  return ran;
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}
