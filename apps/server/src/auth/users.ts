import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { DEFAULT_UNIT_PREFS, UnitPrefsSchema, type Role, type UnitPrefs } from '@watchkeeper/shared';
import { iso, type Clock } from '../clock.js';
import type { DB } from '../db/index.js';

export const MAX_BAD_PINS = 5;
export const LOCKOUT_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Extend a session's expiry at most once a day. */
const SLIDE_AFTER_MS = 24 * 3600_000;

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  unitPrefs: UnitPrefs;
}

interface UserRow {
  id: string;
  name: string;
  role: Role;
  pin_hash: string;
  unit_prefs: string;
  failed_pins: number;
  locked_until: string | null;
}

function toSessionUser(r: Pick<UserRow, 'id' | 'name' | 'role' | 'unit_prefs'>): SessionUser {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    unitPrefs: UnitPrefsSchema.parse({ ...DEFAULT_UNIT_PREFS, ...(JSON.parse(r.unit_prefs) as object) }),
  };
}

export const hashPin = (pin: string) => argon2.hash(pin, { type: argon2.argon2id });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class Users {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n;
  }

  list(): { id: string; name: string; role: Role }[] {
    return this.db.prepare('SELECT id, name, role FROM user ORDER BY role DESC, name').all() as { id: string; name: string; role: Role }[];
  }

  get(id: string): SessionUser | null {
    const r = this.db.prepare('SELECT id, name, role, unit_prefs FROM user WHERE id = ?').get(id) as UserRow | undefined;
    return r ? toSessionUser(r) : null;
  }

  async create(name: string, role: Role, pin: string): Promise<SessionUser> {
    const id = ulid();
    this.db
      .prepare('INSERT INTO user (id, name, role, pin_hash, unit_prefs, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, role, await hashPin(pin), '{}', iso(this.clock.now()));
    return this.get(id)!;
  }

  async update(id: string, patch: { name?: string; role?: Role; pin?: string }): Promise<SessionUser | null> {
    if (patch.name !== undefined) this.db.prepare('UPDATE user SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.role !== undefined) this.db.prepare('UPDATE user SET role = ? WHERE id = ?').run(patch.role, id);
    if (patch.pin !== undefined) this.db.prepare('UPDATE user SET pin_hash = ? WHERE id = ?').run(await hashPin(patch.pin), id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM user WHERE id = ?').run(id).changes > 0;
  }

  setUnitPrefs(id: string, prefs: UnitPrefs): void {
    this.db.prepare('UPDATE user SET unit_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), id);
  }

  /** Check a PIN, applying the 5-strikes lockout. */
  async verifyPin(
    id: string,
    pin: string,
  ): Promise<{ ok: true; user: SessionUser } | { ok: false; reason: 'unknown' | 'bad-pin' | 'locked'; retryAfterMs?: number }> {
    const r = this.db.prepare('SELECT * FROM user WHERE id = ?').get(id) as UserRow | undefined;
    if (!r) return { ok: false, reason: 'unknown' };
    const now = this.clock.now();
    if (r.locked_until && Date.parse(r.locked_until) > now) {
      return { ok: false, reason: 'locked', retryAfterMs: Date.parse(r.locked_until) - now };
    }
    if (await argon2.verify(r.pin_hash, pin)) {
      this.db.prepare('UPDATE user SET failed_pins = 0, locked_until = NULL WHERE id = ?').run(id);
      return { ok: true, user: toSessionUser(r) };
    }
    const failed = r.failed_pins + 1;
    if (failed >= MAX_BAD_PINS) {
      this.db.prepare('UPDATE user SET failed_pins = 0, locked_until = ? WHERE id = ?').run(iso(now + LOCKOUT_MS), id);
      return { ok: false, reason: 'locked', retryAfterMs: LOCKOUT_MS };
    }
    this.db.prepare('UPDATE user SET failed_pins = ? WHERE id = ?').run(failed, id);
    return { ok: false, reason: 'bad-pin' };
  }
}

export class Sessions {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  create(userId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db
      .prepare('INSERT INTO session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, iso(now), iso(expiresAt));
    return { token, expiresAt };
  }

  /** Resolve a token to its user, sliding the expiry forward. */
  resolve(token: string): { userId: string; expiresAt: number; slid: boolean } | null {
    const id = sha256(token);
    const row = this.db.prepare('SELECT user_id, expires_at FROM session WHERE id = ?').get(id) as
      | { user_id: string; expires_at: string }
      | undefined;
    if (!row) return null;
    const now = this.clock.now();
    const expiresAt = Date.parse(row.expires_at);
    if (expiresAt <= now) {
      this.db.prepare('DELETE FROM session WHERE id = ?').run(id);
      return null;
    }
    if (now + SESSION_TTL_MS - expiresAt > SLIDE_AFTER_MS) {
      const next = now + SESSION_TTL_MS;
      this.db.prepare('UPDATE session SET expires_at = ? WHERE id = ?').run(iso(next), id);
      return { userId: row.user_id, expiresAt: next, slid: true };
    }
    return { userId: row.user_id, expiresAt, slid: false };
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM session WHERE id = ?').run(sha256(token));
  }

  purgeExpired(): void {
    this.db.prepare('DELETE FROM session WHERE expires_at <= ?').run(iso(this.clock.now()));
  }
}
