import {
  CREW_FIELD_KEYS,
  CrewFieldsSchema,
  DEFAULT_INSTANCE_IDS,
  DEFAULT_UNIT_PREFS,
  formatSnapshotValue,
  PassageInputSchema,
  type AmendInput,
  type Amendment,
  type CrewFields,
  type InstanceIds,
  type LogEntry,
  type LogKind,
  type ManualEntryInput,
  type Passage,
  type PassageInput,
  type PassageSummary,
  type Snapshot,
  type UnitPrefs,
} from '@watchkeeper/shared';
import { ulid } from 'ulid';
import type { EventHub } from '../api/events.js';
import { iso, type Clock } from '../clock.js';
import { getSetting, type DB } from '../db/index.js';
import { DERIVED } from '../derived/engine.js';
import type { LiveStore } from '../signalk/store.js';
import type { TimeSource } from '../signalk/time.js';
import { buildSnapshot } from './snapshot.js';

const DAY = 86_400_000;
const TRACK_MAX_POINTS = 600;

export class LogError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

interface PassageRow {
  id: string;
  name: string;
  from_place: string | null;
  to_place: string | null;
  skipper_id: string | null;
  crew: string;
  started_at: string;
  ended_at: string | null;
  start_distance_m: number | null;
}

interface EntryRow {
  id: string;
  passage_id: string | null;
  ts: string;
  kind: LogKind;
  event_type: string | null;
  snapshot: string;
  crew_fields: string;
  remarks: string | null;
  created_by: string | null;
  signed_by: string | null;
  signed_at: string | null;
}

export interface WriteOptions {
  kind: LogKind;
  eventType?: string | null;
  remarks?: string | null;
  createdBy?: string | null;
  /** Crew fields entered for this entry; the rest carry forward. */
  crewFields?: CrewFields;
  /** Entry time; defaults to the time source (GPS when fresh). */
  ts?: number;
  /** Extra values to record beside the standard snapshot (e.g. an alarm's path). */
  extra?: Snapshot;
}

export interface LogQuery {
  passageId?: string;
  kind?: LogKind | 'events';
  unsigned?: boolean;
  before?: string;
  limit: number;
}

export interface LogbookDeps {
  db: DB;
  store: LiveStore;
  clock: Clock;
  time: TimeSource;
  hub: EventHub;
}

const toPassage = (r: PassageRow): Passage => ({
  id: r.id,
  name: r.name,
  fromPlace: r.from_place,
  toPlace: r.to_place,
  skipperId: r.skipper_id,
  crew: JSON.parse(r.crew) as string[],
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

/** UTC day number of `t`, counting the passage's start date as day 1. */
export function passageDay(startedAt: string, t: number): number {
  const start = Date.parse(startedAt);
  return Math.floor(t / DAY) - Math.floor(start / DAY) + 1;
}

/**
 * Passages and the append-only log. Entries are inserted once and never
 * updated except for signing; corrections are amendment rows (the database
 * triggers enforce this too).
 */
export class Logbook {
  constructor(private readonly deps: LogbookDeps) {}

  private get db(): DB {
    return this.deps.db;
  }

  private ids(): InstanceIds {
    return getSetting<InstanceIds>(this.db, 'instanceIds', DEFAULT_INSTANCE_IDS);
  }

  // Passages

  activePassage(): Passage | null {
    const r = this.activeRow();
    return r ? toPassage(r) : null;
  }

  private activeRow(): PassageRow | undefined {
    return this.db.prepare('SELECT * FROM passage WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get() as PassageRow | undefined;
  }

  listPassages(): Passage[] {
    return (this.db.prepare('SELECT * FROM passage ORDER BY started_at DESC').all() as PassageRow[]).map(toPassage);
  }

  getPassage(id: string): Passage | null {
    const r = this.passageRow(id);
    return r ? toPassage(r) : null;
  }

  private passageRow(id: string): PassageRow | undefined {
    return this.db.prepare('SELECT * FROM passage WHERE id = ?').get(id) as PassageRow | undefined;
  }

  startPassage(input: PassageInput, userId: string | null): Passage {
    const p = PassageInputSchema.parse(input);
    if (this.activeRow()) throw new LogError('A passage is already under way. End it first.', 409);
    const now = this.deps.time.read().now;
    const id = ulid(now);
    const total = this.deps.store.fresh(DERIVED.distanceRun);
    this.db
      .prepare(
        `INSERT INTO passage (id, name, from_place, to_place, skipper_id, crew, started_at, ended_at, start_distance_m)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, p.name, p.fromPlace, p.toPlace, userId, JSON.stringify(p.crew), iso(now), typeof total === 'number' ? total : null);
    this.write({ kind: 'event', eventType: 'passage_start', remarks: `Passage started: ${p.name}`, createdBy: userId, ts: now });
    const passage = this.getPassage(id)!;
    this.deps.hub.broadcast('passage.started', passage);
    return passage;
  }

  updatePassage(id: string, input: PassageInput): Passage {
    const p = PassageInputSchema.parse(input);
    const res = this.db
      .prepare('UPDATE passage SET name = ?, from_place = ?, to_place = ?, crew = ? WHERE id = ?')
      .run(p.name, p.fromPlace, p.toPlace, JSON.stringify(p.crew), id);
    if (res.changes === 0) throw new LogError('No such passage', 404);
    return this.getPassage(id)!;
  }

  endPassage(id: string, userId: string | null): Passage {
    const row = this.passageRow(id);
    if (!row) throw new LogError('No such passage', 404);
    if (row.ended_at) throw new LogError('This passage has already ended.', 409);
    const now = this.deps.time.read().now;
    // The closing entry still belongs to the passage, so write it first.
    this.write({ kind: 'event', eventType: 'passage_end', remarks: `Passage ended: ${row.name}`, createdBy: userId, ts: now });
    this.db.prepare('UPDATE passage SET ended_at = ? WHERE id = ?').run(iso(Math.max(now, Date.parse(row.started_at))), id);
    const passage = this.getPassage(id)!;
    this.deps.hub.broadcast('passage.ended', passage);
    return passage;
  }

  // Writing entries

  /**
   * Write one entry with a snapshot of current values, attached to the active
   * passage. Returns null when an hourly entry for that hour already exists.
   */
  write(o: WriteOptions): LogEntry | null {
    const time = this.deps.time.read();
    const ts = o.ts ?? time.now;
    const passage = this.activeRow();
    const snapshot: Snapshot = {
      ...buildSnapshot(this.deps.store, this.deps.clock.now(), this.ids(), time, {
        hourStart: this.hourStartDistance(passage),
        passageStart: passage?.start_distance_m ?? null,
      }),
      ...o.extra,
    };
    const { values, carried } = this.crewFieldsFor(passage?.id ?? null, o.crewFields ?? {});
    const id = ulid(ts);
    try {
      this.db
        .prepare(
          `INSERT INTO log_entry (id, passage_id, ts, kind, event_type, snapshot, crew_fields, remarks, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          passage?.id ?? null,
          iso(ts),
          o.kind,
          o.eventType ?? null,
          JSON.stringify(snapshot),
          JSON.stringify(carried.length > 0 ? { ...values, _carried: carried } : values),
          o.remarks ?? null,
          o.createdBy ?? null,
        );
    } catch (e) {
      if (o.kind === 'hourly' && /UNIQUE/.test((e as Error).message)) return null;
      throw e;
    }
    this.deps.hub.broadcast('log.created', { id, kind: o.kind, passageId: passage?.id ?? null });
    return this.get(id);
  }

  manual(input: ManualEntryInput & { crewFields: CrewFields }, userId: string | null): LogEntry {
    return this.write({
      kind: 'manual',
      eventType: input.eventType ?? null,
      remarks: input.remarks ?? null,
      crewFields: input.crewFields,
      createdBy: userId,
    })!;
  }

  /** "Distance this hour" counts from the last hourly entry of this passage, or from its start. */
  private hourStartDistance(passage: PassageRow | undefined): number | null {
    if (!passage) return null;
    const last = this.db
      .prepare(
        `SELECT json_extract(snapshot, '$.distanceTotal') AS d FROM log_entry
         WHERE passage_id = ? AND kind = 'hourly' AND json_extract(snapshot, '$.distanceTotal') IS NOT NULL
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(passage.id) as { d: number } | undefined;
    return last?.d ?? passage.start_distance_m;
  }

  /** Fields entered now, plus the rest carried forward from the latest entry of the passage. */
  private crewFieldsFor(passageId: string | null, entered: CrewFields): { values: CrewFields; carried: string[] } {
    const clean = CrewFieldsSchema.parse(entered);
    const values: CrewFields = {};
    for (const k of CREW_FIELD_KEYS) if (clean[k]) values[k] = clean[k];
    if (!passageId) return { values, carried: [] };
    const prev = this.db
      .prepare("SELECT id FROM log_entry WHERE passage_id = ? AND crew_fields != '{}' ORDER BY ts DESC, rowid DESC LIMIT 1")
      .get(passageId) as { id: string } | undefined;
    const carried: string[] = [];
    if (prev) {
      const before = this.get(prev.id)!;
      for (const k of CREW_FIELD_KEYS) {
        const v = before.current[`crew.${k}`];
        if (values[k] === undefined && v) {
          values[k] = v;
          carried.push(k);
        }
      }
    }
    return { values, carried };
  }

  // Reading

  get(id: string): LogEntry | null {
    const r = this.db.prepare('SELECT * FROM log_entry WHERE id = ?').get(id) as EntryRow | undefined;
    return r ? this.hydrate([r])[0]! : null;
  }

  list(q: LogQuery): LogEntry[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: q.limit };
    if (q.passageId) {
      where.push('passage_id = @passageId');
      params.passageId = q.passageId;
    }
    if (q.kind === 'events') where.push("kind IN ('event','manual','anchor','checklist','system')");
    else if (q.kind) {
      where.push('kind = @kind');
      params.kind = q.kind;
    }
    if (q.unsigned) where.push('signed_at IS NULL');
    if (q.before) {
      where.push('ts < @before');
      params.before = q.before;
    }
    const rows = this.db
      .prepare(`SELECT * FROM log_entry ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, rowid DESC LIMIT @limit`)
      .all(params) as EntryRow[];
    return this.hydrate(rows);
  }

  /** Entries of a passage in time order, for export. */
  passageEntries(passageId: string): LogEntry[] {
    const rows = this.db.prepare('SELECT * FROM log_entry WHERE passage_id = ? ORDER BY ts, rowid').all(passageId) as EntryRow[];
    return this.hydrate(rows);
  }

  unsignedCount(passageId: string | null): number {
    const r = passageId
      ? (this.db.prepare('SELECT count(*) AS n FROM log_entry WHERE passage_id = ? AND signed_at IS NULL').get(passageId) as { n: number })
      : (this.db.prepare('SELECT count(*) AS n FROM log_entry WHERE signed_at IS NULL').get() as { n: number });
    return r.n;
  }

  private hydrate(rows: EntryRow[]): LogEntry[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const names = new Map(
      (this.db.prepare('SELECT id, name FROM user').all() as { id: string; name: string }[]).map((u) => [u.id, u.name]),
    );
    const amendRows = this.db
      .prepare(`SELECT * FROM log_amendment WHERE log_entry_id IN (${marks}) ORDER BY ts, rowid`)
      .all(...ids) as { id: string; log_entry_id: string; field: string; old_value: string | null; new_value: string | null; reason: string; user_id: string; ts: string }[];
    const attachRows = this.db
      .prepare(`SELECT id, owner_id, mime, caption FROM attachment WHERE owner_type = 'log_entry' AND owner_id IN (${marks}) ORDER BY created_at`)
      .all(...ids) as { id: string; owner_id: string; mime: string; caption: string | null }[];

    return rows.map((r) => {
      const crewRaw = JSON.parse(r.crew_fields) as CrewFields & { _carried?: string[] };
      const { _carried, ...crew } = crewRaw;
      const amendments: Amendment[] = amendRows
        .filter((a) => a.log_entry_id === r.id)
        .map((a) => ({
          id: a.id,
          field: a.field,
          oldValue: a.old_value,
          newValue: a.new_value,
          reason: a.reason,
          userId: a.user_id,
          userName: names.get(a.user_id) ?? null,
          ts: a.ts,
        }));
      const current: Record<string, string | null> = { remarks: r.remarks };
      for (const k of CREW_FIELD_KEYS) current[`crew.${k}`] = crew[k] ?? null;
      for (const a of amendments) current[a.field] = a.newValue;
      return {
        id: r.id,
        passageId: r.passage_id,
        ts: r.ts,
        kind: r.kind,
        eventType: r.event_type,
        snapshot: JSON.parse(r.snapshot) as Snapshot,
        crewFields: crew,
        carried: _carried ?? [],
        remarks: r.remarks,
        createdBy: r.created_by,
        createdByName: r.created_by ? (names.get(r.created_by) ?? null) : null,
        signedBy: r.signed_by,
        signedByName: r.signed_by ? (names.get(r.signed_by) ?? null) : null,
        signedAt: r.signed_at,
        amendments,
        current,
        attachments: attachRows.filter((a) => a.owner_id === r.id).map((a) => ({ id: a.id, mime: a.mime, caption: a.caption })),
      };
    });
  }

  // Signing and amending

  sign(id: string, userId: string): LogEntry {
    const res = this.db
      .prepare('UPDATE log_entry SET signed_by = ?, signed_at = ? WHERE id = ? AND signed_at IS NULL')
      .run(userId, iso(this.deps.time.read().now), id);
    if (res.changes === 0) throw this.get(id) ? new LogError('This entry is already signed.', 409) : new LogError('No such entry', 404);
    this.deps.hub.broadcast('log.signed', { id });
    return this.get(id)!;
  }

  /** Record a correction. The entry itself never changes; the amendment carries old value, new value and reason. */
  amend(id: string, a: AmendInput, userId: string, prefs: UnitPrefs = DEFAULT_UNIT_PREFS): LogEntry {
    const entry = this.get(id);
    if (!entry) throw new LogError('No such entry', 404);
    let oldValue: string | null;
    if (a.field in entry.current) oldValue = entry.current[a.field] ?? null;
    else if (a.field.startsWith('snapshot.')) {
      const key = a.field.slice('snapshot.'.length);
      if (!(key in entry.snapshot)) throw new LogError(`This entry has no ${key} value`, 400);
      oldValue = formatSnapshotValue(key, entry.snapshot[key], prefs);
    } else oldValue = null;
    const newValue = a.newValue?.trim() ? a.newValue.trim() : null;
    if (newValue === oldValue) throw new LogError('The new value is the same as the current one.', 400);
    this.db
      .prepare('INSERT INTO log_amendment (id, log_entry_id, field, old_value, new_value, reason, user_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ulid(), id, a.field, oldValue, newValue, a.reason.trim(), userId, iso(this.deps.time.read().now));
    this.deps.hub.broadcast('log.amended', { id });
    return this.get(id)!;
  }

  // Summary

  summary(id: string): PassageSummary {
    const row = this.passageRow(id);
    if (!row) throw new LogError('No such passage', 404);
    const passage = toPassage(row);
    const start = Date.parse(row.started_at);
    const end = row.ended_at ? Date.parse(row.ended_at) : this.deps.time.read().now;
    const entries = this.passageEntries(id);

    let distanceM: number | null = null;
    if (!row.ended_at) {
      const total = this.deps.store.fresh(DERIVED.distanceRun);
      if (typeof total === 'number' && row.start_distance_m !== null) distanceM = Math.max(0, total - row.start_distance_m);
    }
    if (distanceM === null) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const d = entries[i]!.snapshot.distancePassage;
        if (typeof d === 'number') {
          distanceM = d;
          break;
        }
      }
    }
    const elapsedS = (end - start) / 1000;
    const avgSogMps = distanceM !== null && elapsedS > 60 ? distanceM / elapsedS : null;

    // Engine time: last minus first engine-hours reading for each engine.
    let engineS: number | null = null;
    for (const eid of this.ids().propulsion) {
      const key = `engine.${eid}.hours`;
      const readings = entries.map((e) => e.snapshot[key]).filter((v): v is number => typeof v === 'number');
      if (!row.ended_at) {
        const live = this.deps.store.fresh(`propulsion.${eid}.runTime`);
        if (typeof live === 'number') readings.push(live);
      }
      if (readings.length >= 2) engineS = (engineS ?? 0) + Math.max(0, readings[readings.length - 1]! - readings[0]!);
    }

    return {
      passage,
      day: passageDay(row.started_at, end),
      distanceM,
      avgSogMps,
      engineS,
      entries: entries.length,
      unsigned: entries.filter((e) => e.signedAt === null).length,
      track: this.trackPoints(start, end, TRACK_MAX_POINTS).map((p) => [p.lat, p.lon]),
    };
  }

  /** 1-minute positions between two times (epoch ms), thinned evenly to at most maxPoints. */
  trackPoints(from: number, to: number, maxPoints = Infinity): { ts: number; lat: number; lon: number }[] {
    const rows = this.db
      .prepare(
        `SELECT la.ts AS ts, la.avg AS lat, lo.avg AS lon FROM sample_1m la
         JOIN sample_1m lo ON lo.path = 'navigation.position.longitude' AND lo.ts = la.ts
         WHERE la.path = 'navigation.position.latitude' AND la.ts BETWEEN ? AND ?
           AND la.avg IS NOT NULL AND lo.avg IS NOT NULL
         ORDER BY la.ts`,
      )
      .all(from, to) as { ts: number; lat: number; lon: number }[];
    const step = Math.max(1, Math.ceil(rows.length / maxPoints));
    return step === 1 ? rows : rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  }
}
