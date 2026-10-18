import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_UNIT_PREFS, UnitPrefsSchema, type Role, type UnitPrefs, type UserMapping } from '@watchkeeper/shared';
import { iso, type Clock } from '../clock.js';
import type { DB } from '../db/index.js';

export const MAX_BAD_PINS = 5;
export const LOCKOUT_MS = 5 * 60_000;
/** A PIN elevation on a shared helm device lasts 12 hours. */
export const ELEVATION_TTL_MS = 12 * 3600_000;
/** Update last_seen at most this often per user. */
const SEEN_THROTTLE_MS = 60_000;

/** The skipper's unit preferences: the units for text the backend writes (alarm messages, log remarks). */
export function skipperPrefs(db: DB): UnitPrefs {
  const row = db.prepare("SELECT unit_prefs FROM user WHERE role = 'skipper' AND mapped = 1 ORDER BY created_at LIMIT 1").get() as
    | { unit_prefs: string }
    | undefined;
  const parsed = row ? UnitPrefsSchema.safeParse({ ...DEFAULT_UNIT_PREFS, ...(JSON.parse(row.unit_prefs) as object) }) : null;
  return parsed?.success ? parsed.data : DEFAULT_UNIT_PREFS;
}

export interface UserRecord {
  id: string;
  name: string;
  role: Role;
  mapped: boolean;
  hasPin: boolean;
  unitPrefs: UnitPrefs;
  lastSeen: string | null;
}

interface UserRow {
  id: string;
  name: string;
  role: Role;
  pin_hash: string;
  unit_prefs: string;
  mapped: number;
  last_seen: string | null;
  failed_pins: number;
  locked_until: string | null;
}

function toRecord(r: UserRow): UserRecord {
  return {
    id: r.id,
    name: r.name,
    role: r.mapped ? r.role : 'guest',
    mapped: r.mapped === 1,
    hasPin: r.pin_hash !== '',
    unitPrefs: UnitPrefsSchema.parse({ ...DEFAULT_UNIT_PREFS, ...(JSON.parse(r.unit_prefs) as object) }),
    lastSeen: r.last_seen,
  };
}

export const hashPin = (pin: string) => argon2.hash(pin, { type: argon2.argon2id });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * HA users seen through ingress, with the roles the skipper mapped. Unmapped
 * users are guests.
 */
export class Users {
  private readonly seenAt = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  /** Record an HA user from the ingress headers; creates them as an unmapped guest. */
  seen(id: string, name: string): UserRecord {
    const now = this.clock.now();
    const last = this.seenAt.get(id);
    if (last === undefined || now - last > SEEN_THROTTLE_MS) {
      this.db
        .prepare(
          `INSERT INTO user (id, name, role, pin_hash, created_at, last_seen) VALUES (?, ?, 'guest', '', ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
        )
        .run(id, name, iso(now), iso(now));
      this.seenAt.set(id, now);
    }
    return this.get(id)!;
  }

  get(id: string): UserRecord | null {
    const r = this.db.prepare('SELECT * FROM user WHERE id = ?').get(id) as UserRow | undefined;
    return r ? toRecord(r) : null;
  }

  list(): UserMapping[] {
    const rows = this.db.prepare('SELECT * FROM user ORDER BY mapped DESC, name').all() as UserRow[];
    return rows.map((r) => {
      const u = toRecord(r);
      return { id: u.id, name: u.name, role: u.role, mapped: u.mapped, hasPin: u.hasPin, lastSeen: u.lastSeen };
    });
  }

  skipperCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM user WHERE mapped = 1 AND role = 'skipper'").get() as { n: number }).n;
  }

  /** Users whose PIN can elevate a guest device: mapped crew or skipper with a PIN. */
  pinUsers(): { id: string; name: string }[] {
    return this.db
      .prepare("SELECT id, name FROM user WHERE mapped = 1 AND role IN ('crew','skipper') AND pin_hash != '' ORDER BY name")
      .all() as { id: string; name: string }[];
  }

  async setMapping(id: string, role: Role, pin: string | null | undefined): Promise<boolean> {
    const changes = this.db.prepare('UPDATE user SET role = ?, mapped = 1 WHERE id = ?').run(role, id).changes;
    if (changes === 0) return false;
    if (pin === null) this.db.prepare("UPDATE user SET pin_hash = '' WHERE id = ?").run(id);
    else if (pin !== undefined) this.db.prepare('UPDATE user SET pin_hash = ? WHERE id = ?').run(await hashPin(pin), id);
    return true;
  }

  setUnitPrefs(id: string, prefs: UnitPrefs): void {
    this.db.prepare('UPDATE user SET unit_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), id);
  }

  /** Check a helm PIN, applying the 5-strikes lockout. */
  async verifyPin(
    id: string,
    pin: string,
  ): Promise<{ ok: true; user: UserRecord } | { ok: false; reason: 'unknown' | 'bad-pin' | 'locked'; retryAfterMs?: number }> {
    const r = this.db.prepare('SELECT * FROM user WHERE id = ?').get(id) as UserRow | undefined;
    if (!r || r.pin_hash === '' || !r.mapped || r.role === 'guest') return { ok: false, reason: 'unknown' };
    const now = this.clock.now();
    if (r.locked_until && Date.parse(r.locked_until) > now) {
      return { ok: false, reason: 'locked', retryAfterMs: Date.parse(r.locked_until) - now };
    }
    if (await argon2.verify(r.pin_hash, pin)) {
      this.db.prepare('UPDATE user SET failed_pins = 0, locked_until = NULL WHERE id = ?').run(id);
      return { ok: true, user: toRecord(r) };
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

/** PIN elevations: a cookie on one device, bound to the HA user who entered the PIN. */
export class Elevations {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  create(userId: string, haUserId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const expiresAt = now + ELEVATION_TTL_MS;
    this.db
      .prepare('INSERT INTO session (id, user_id, ha_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, haUserId, iso(now), iso(expiresAt));
    return { token, expiresAt };
  }

  /** The acting user for this token, if it is unexpired and was made by this HA user. */
  resolve(token: string, haUserId: string): { userId: string; expiresAt: number } | null {
    const id = sha256(token);
    const row = this.db.prepare('SELECT user_id, ha_user_id, expires_at FROM session WHERE id = ?').get(id) as
      | { user_id: string; ha_user_id: string; expires_at: string }
      | undefined;
    if (!row) return null;
    const expiresAt = Date.parse(row.expires_at);
    if (expiresAt <= this.clock.now()) {
      this.db.prepare('DELETE FROM session WHERE id = ?').run(id);
      return null;
    }
    if (row.ha_user_id !== haUserId) return null;
    return { userId: row.user_id, expiresAt };
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM session WHERE id = ?').run(sha256(token));
  }
}
