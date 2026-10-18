import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFRawStream, type PDFPage } from 'pdf-lib';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_UNIT_PREFS, KNOT_MPS, type LogEntry } from '@watchkeeper/shared';
import { BoatModel, DEAD } from '@watchkeeper/sim';
import { ManualClock } from '../src/clock.js';
import { DerivedEngine } from '../src/derived/engine.js';
import { PDF_COLUMNS, passageCsv, passageGpx, passagePdf } from '../src/log/export.js';
import { LogScheduler } from '../src/log/scheduler.js';
import { EventTriggers } from '../src/log/triggers.js';
import { Recorder } from '../src/recorder/recorder.js';
import { TimeSource } from '../src/signalk/time.js';
import { CREW, GUEST, ingress, makeApp, seedUsers, SKIPPER } from './helpers/app.js';
import { T0 } from './helpers/fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

type App = Awaited<ReturnType<typeof makeApp>>;

/** The pieces the runtime starts, driven by hand on the test clock. */
function rig(t: App) {
  const { db, store, clock } = t;
  const { logbook, hub } = t.app.ctx;
  const time = new TimeSource(store, clock);
  return {
    scheduler: new LogScheduler({ db, logbook, store, clock, time, alarms: t.app.ctx.alarms }),
    triggers: new EventTriggers({ db, store, clock, time, hub, logbook }),
    derived: new DerivedEngine(db, store, clock),
    recorder: new Recorder(db, store, clock),
  };
}

/** GPS time as Signal K would report it, matching the test clock. */
const gps = (t: App) => t.store.update('navigation.datetime', new Date(t.clock.now()).toISOString());

const all = (t: App) => t.app.ctx.logbook.list({ limit: 500 }).reverse();

/** Text drawn on a pdf-lib page: inflate the content streams and decode the hex strings. */
function pageText(page: PDFPage): string {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => page.doc.context.lookup(r)) : [contents];
  let out = '';
  for (const s of streams) {
    if (!(s instanceof PDFRawStream)) continue;
    const raw = Buffer.from(s.getContents());
    let body: string;
    try {
      body = inflateSync(raw).toString('latin1');
    } catch {
      body = raw.toString('latin1');
    }
    for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out += Buffer.from(m[1]!, 'hex').toString('latin1') + '\n';
  }
  return out;
}

describe('logbook: 6-hour accelerated replay', () => {
  let t: App;
  let entries: LogEntry[];
  let engineTransitions = 0;
  const suggestions: { kind: string; reason: string }[] = [];

  beforeAll(async () => {
    t = await makeApp(new ManualClock(T0));
    const r = rig(t);
    // Mixed scenario from 12:00 UTC: anchored, motor out on 100°, sail on 142° for 4 h, motor in, anchor.
    const model = new BoatModel({ start: T0, scenario: 'mixed', seed: 1 });
    const feed = () => {
      for (const [p, v] of Object.entries(model.values())) t.store.update(p, v, model.t);
    };
    const step = () => {
      model.step();
      t.clock.set(model.t);
      feed();
      r.recorder.tick();
      r.derived.tick();
      r.triggers.tick();
      r.scheduler.tick();
    };
    feed();
    for (let i = 0; i < 60; i++) step();
    t.app.ctx.logbook.startPassage({ name: 'Replay passage', fromPlace: 'Norfolk', toPlace: 'Bermuda' }, null);

    const broadcast = t.app.ctx.hub.broadcast.bind(t.app.ctx.hub);
    t.app.ctx.hub.broadcast = (type, payload) => {
      if (type.startsWith('passage.suggest')) suggestions.push(payload as { kind: string; reason: string });
      broadcast(type, payload);
    };

    // Ground truth: engine state changes that held 30 s, straight from the model.
    const last: Record<string, string> = {};
    const pending: Record<string, { v: string; since: number } | undefined> = {};
    const until = T0 + 6 * HOUR + MIN;
    while (model.t < until) {
      // The water temperature sensor dies at 14:30.
      if (model.t === T0 + 2.5 * HOUR) model.overrides.set('environment.water.temperature', DEAD);
      step();
      for (const id of ['port', 'starboard']) {
        const v = model.values()[`propulsion.${id}.state`] as string;
        last[id] ??= v;
        if (v === last[id]) pending[id] = undefined;
        else if (pending[id]?.v !== v) pending[id] = { v, since: model.t };
        if (pending[id] && model.t - pending[id].since >= 30_000) {
          last[id] = v;
          pending[id] = undefined;
          engineTransitions++;
        }
      }
    }
    entries = all(t);
  }, 120_000);

  it('writes exactly 6 hourly entries, at :00 UTC, no duplicates', () => {
    const hourly = entries.filter((e) => e.kind === 'hourly');
    expect(hourly.map((e) => e.ts.slice(11))).toEqual(['13:00:00.000Z', '14:00:00.000Z', '15:00:00.000Z', '16:00:00.000Z', '17:00:00.000Z', '18:00:00.000Z']);
    for (const e of hourly) expect(e.snapshot.clockSource).toBe('gps');
  });

  it('writes the expected event entries once each', () => {
    const events = entries.filter((e) => e.kind === 'event');
    const types = events.map((e) => e.eventType);
    // Both engines start at 12:20 and 16:45 and stop at 12:45 and 17:05.
    expect(engineTransitions).toBe(8);
    expect(types.filter((x) => x === 'engine_start')).toHaveLength(4);
    expect(types.filter((x) => x === 'engine_stop')).toHaveLength(4);
    // 100° to 142° when the sails go up. Nothing else turns more than 30°.
    const course = events.filter((e) => e.eventType === 'course_change');
    expect(course).toHaveLength(1);
    expect(course[0]!.remarks).toMatch(/^Course change (09\d|10\d)°T to 1[34]\d°T$/);
    expect(types[0]).toBe('passage_start');
    const keys = events.map((e) => `${e.eventType}@${e.ts}: ${e.remarks}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Every event entry carries a full snapshot.
    for (const e of events) expect(e.snapshot).toHaveProperty('sog');
  });

  it('a dead sensor records null, never the last value', () => {
    const water = entries.filter((e) => e.kind === 'hourly').map((e) => e.snapshot.waterTemp);
    expect(typeof water[0]).toBe('number'); // 13:00
    expect(typeof water[1]).toBe('number'); // 14:00
    expect(water.slice(2)).toEqual([null, null, null, null]); // 15:00 on
  });

  it('distance this hour adds up to distance since departure', () => {
    const hourly = entries.filter((e) => e.kind === 'hourly');
    const sum = hourly.reduce((a, e) => a + (e.snapshot.distanceHour as number), 0);
    expect(sum).toBeGreaterThan(0);
    expect(hourly.at(-1)!.snapshot.distancePassage as number).toBeCloseTo(sum, 0);
  });

  it('suggests ending the passage when the anchor goes down, once', () => {
    expect(suggestions).toEqual([expect.objectContaining({ kind: 'end', reason: 'Anchor down' })]);
  });

  it('exports: PDF page with every column, CSV in user units, GPX of 1-minute positions', async () => {
    const p = t.app.ctx.logbook.activePassage()!;
    const list = t.app.ctx.logbook.passageEntries(p.id);
    const pdf = await PDFDocument.load(await passagePdf(p, list, DEFAULT_UNIT_PREFS));
    expect(pdf.getPageCount()).toBe(1); // 12:01 to 18:01, one UTC day
    const text = pageText(pdf.getPage(0));
    for (const col of PDF_COLUMNS) expect(text).toContain(col.toUpperCase());
    expect(text).toContain('Replay passage');

    const csv = passageCsv(list, DEFAULT_UNIT_PREFS).replace(/^﻿/, '').trim().split('\r\n');
    expect(csv).toHaveLength(list.length + 1);
    const header = csv[0]!.split(',');
    expect(header).toContain('sog (kn)');
    expect(header).toContain('pressure (hPa)');
    const sogCol = header.indexOf('sog (kn)');
    const sailing = list.find((e) => e.kind === 'hourly' && e.ts.startsWith('2026-10-18T14'))!;
    const row = csv[list.indexOf(sailing) + 1]!.split(',');
    expect(Number(row[sogCol])).toBeCloseTo((sailing.snapshot.sog as number) / KNOT_MPS, 1);

    const points = t.app.ctx.logbook.trackPoints(Date.parse(p.startedAt), t.clock.now());
    expect(points.length).toBeGreaterThan(350); // about 360 minutes
    const gpx = passageGpx(p, points);
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1"')).toBe(true);
    expect(gpx.match(/<trkpt /g)).toHaveLength(points.length);
    expect(gpx.match(/<trkseg>/g)!.length).toBe(gpx.match(/<\/trkseg>/g)!.length);
  });
});

describe('logbook: restart across the top of the hour', () => {
  it('writes one system entry and back-fills nothing', async () => {
    const t = await makeApp(new ManualClock(T0 + 50 * MIN)); // 12:50
    t.app.ctx.logbook.startPassage({ name: 'Overnight' }, null);
    const a = rig(t);
    gps(t);
    a.scheduler.tick();
    a.scheduler.stop(); // down at 12:50

    t.clock.set(T0 + 4 * HOUR + 10 * MIN); // back at 16:10
    const b = rig(t);
    gps(t);
    b.scheduler.tick();
    let entries = all(t);
    expect(entries.filter((e) => e.kind === 'hourly')).toHaveLength(0);
    const system = entries.filter((e) => e.kind === 'system');
    expect(system).toHaveLength(1);
    expect(system[0]!.remarks).toBe('No entries 13:00 to 16:00 UTC: data hub offline');

    // Running again: the next top of the hour is logged as usual.
    for (let m = 0; m < 51; m++) {
      t.clock.advance(MIN);
      gps(t);
      b.scheduler.tick();
    }
    entries = all(t);
    expect(entries.filter((e) => e.kind === 'hourly').map((e) => e.ts.slice(11, 16))).toEqual(['17:00']);
    expect(entries.filter((e) => e.kind === 'system')).toHaveLength(1);
  });

  it('a gap over one boundary names that hour', async () => {
    const t = await makeApp(new ManualClock(T0 + 59 * MIN));
    t.app.ctx.logbook.startPassage({ name: 'Short' }, null);
    const a = rig(t);
    gps(t);
    a.scheduler.tick();
    a.scheduler.stop();
    t.clock.set(T0 + 61 * MIN);
    gps(t);
    rig(t).scheduler.tick();
    expect(all(t).filter((e) => e.kind === 'system').map((e) => e.remarks)).toEqual(['No entry at 13:00 UTC: data hub offline']);
  });

  it('without a passage or anchor there is nothing to miss', async () => {
    const t = await makeApp(new ManualClock(T0 + 50 * MIN));
    const a = rig(t);
    gps(t);
    a.scheduler.tick();
    a.scheduler.stop();
    t.clock.set(T0 + 3 * HOUR);
    gps(t);
    rig(t).scheduler.tick();
    expect(all(t)).toHaveLength(0);
  });

  it('at anchor with no passage, every 4 hours', async () => {
    const t = await makeApp(new ManualClock(T0 + 30 * MIN));
    t.store.update('navigation.anchor.position', { latitude: 32.3, longitude: -64.8 });
    const s = rig(t).scheduler;
    for (let m = 0; m < 5 * 60; m++) {
      t.clock.advance(MIN);
      gps(t);
      s.tick();
    }
    // 12:30 to 17:30: only 16:00 is on the 4-hour grid.
    expect(all(t).map((e) => `${e.kind} ${e.ts.slice(11, 16)}`)).toEqual(['hourly 16:00']);
  });
});

describe('logbook: append-only', () => {
  let t: App;
  beforeEach(async () => {
    t = await makeApp();
    await seedUsers(t.app);
  });

  it('direct SQL cannot change a snapshot, delete an entry, re-sign or touch an amendment', async () => {
    const res = await ingress(t.app, CREW, { method: 'POST', url: '/api/v1/log', payload: { remarks: 'Reef in' } });
    const id = res.json().id as string;
    const db = t.db;
    expect(() => db.prepare("UPDATE log_entry SET snapshot = '{}' WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE log_entry SET remarks = 'x' WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE log_entry SET kind = 'system' WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => db.prepare('UPDATE log_entry SET passage_id = NULL WHERE id = ?').run(id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM log_entry WHERE id = ?').run(id)).toThrow(/cannot be deleted/);
    await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/log/${id}/sign` });
    expect(() => db.prepare("UPDATE log_entry SET signed_at = '2030-01-01' WHERE id = ?").run(id)).toThrow(/already signed/);
    await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/log/${id}/amend`, payload: { field: 'remarks', newValue: 'Reef out', reason: 'Wrong button' } });
    expect(() => db.prepare("UPDATE log_amendment SET new_value = 'x'").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare('DELETE FROM log_amendment').run()).toThrow(/cannot be deleted/);
  });

  it('only one passage at a time', async () => {
    t.app.ctx.logbook.startPassage({ name: 'One' }, null);
    expect(() => t.db.prepare("INSERT INTO passage (id, name, started_at) VALUES ('p2', 'Two', '2026-10-18T12:00:00Z')").run()).toThrow(/UNIQUE/);
    const res = await ingress(t.app, CREW, { method: 'POST', url: '/api/v1/passages', payload: { name: 'Two' } });
    expect(res.statusCode).toBe(409);
  });
});

describe('logbook API: sign and amend', () => {
  let t: App;
  beforeEach(async () => {
    t = await makeApp();
    await seedUsers(t.app);
    t.store.update('navigation.speedOverGround', 7.4 * KNOT_MPS);
  });

  it('an amendment shows the original and new values with the reason', async () => {
    await ingress(t.app, CREW, { method: 'POST', url: '/api/v1/passages', payload: { name: 'Norfolk to Bermuda', fromPlace: 'Norfolk', toPlace: 'Bermuda' } });
    const created = await ingress(t.app, CREW, {
      method: 'POST',
      url: '/api/v1/log',
      payload: { eventType: 'reef_in', remarks: 'First reef in', crewFields: { seaState: '1–2 m', sailPlan: '1 reef, full jib' } },
    });
    expect(created.statusCode).toBe(201);
    const e = created.json() as LogEntry;
    expect(e.snapshot.sog).toBeCloseTo(7.4 * KNOT_MPS, 6);
    expect(e.signedAt).toBeNull();

    const signed = await ingress(t.app, SKIPPER, { method: 'POST', url: `/api/v1/log/${e.id}/sign` });
    expect(signed.json().signedByName).toBe('Skipper');
    expect((await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/log/${e.id}/sign` })).statusCode).toBe(409);

    const noReason = await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/log/${e.id}/amend`, payload: { field: 'remarks', newValue: 'x', reason: ' ' } });
    expect(noReason.statusCode).toBe(400);

    const a1 = await ingress(t.app, CREW, {
      method: 'POST',
      url: `/api/v1/log/${e.id}/amend`,
      payload: { field: 'crew.seaState', newValue: '2–3 m', reason: 'Underestimated' },
    });
    expect(a1.statusCode).toBe(200);
    const a2 = await ingress(t.app, CREW, {
      method: 'POST',
      url: `/api/v1/log/${e.id}/amend`,
      payload: { field: 'snapshot.sog', newValue: '6.9 kn', reason: 'GPS glitch' },
    });
    expect(a2.json().current['snapshot.sog']).toBe('6.9 kn');
    const after = (await ingress(t.app, CREW, { method: 'GET', url: `/api/v1/log/${e.id}` })).json() as LogEntry;
    expect(after.amendments).toEqual([
      expect.objectContaining({ field: 'crew.seaState', oldValue: '1–2 m', newValue: '2–3 m', reason: 'Underestimated', userName: 'Crew' }),
      expect.objectContaining({ field: 'snapshot.sog', oldValue: '7.4 kn', newValue: '6.9 kn', reason: 'GPS glitch' }),
    ]);
    // The entry as written never changes.
    expect(after.crewFields.seaState).toBe('1–2 m');
    expect(after.snapshot.sog).toBeCloseTo(7.4 * KNOT_MPS, 6);
    expect(after.current['crew.seaState']).toBe('2–3 m');
  });

  it('crew fields carry forward and are marked as carried', async () => {
    t.app.ctx.logbook.startPassage({ name: 'P' }, null);
    await ingress(t.app, CREW, { method: 'POST', url: '/api/v1/log', payload: { crewFields: { seaState: '< 1 m', sky: 'Clear' } } });
    t.clock.advance(HOUR);
    const hourly = t.app.ctx.logbook.write({ kind: 'hourly', ts: t.clock.now() })!;
    expect(hourly.crewFields).toEqual({ seaState: '< 1 m', sky: 'Clear' });
    expect(hourly.carried.sort()).toEqual(['seaState', 'sky']);
    const next = await ingress(t.app, CREW, { method: 'POST', url: '/api/v1/log', payload: { crewFields: { sky: 'Overcast' } } });
    expect(next.json().carried).toEqual(['seaState']);
  });

  it('guests cannot read or write the log', async () => {
    expect((await ingress(t.app, GUEST, { method: 'GET', url: '/api/v1/log' })).statusCode).toBe(403);
    expect((await ingress(t.app, GUEST, { method: 'POST', url: '/api/v1/log', payload: {} })).statusCode).toBe(403);
    expect((await ingress(t.app, GUEST, { method: 'GET', url: '/api/v1/passages' })).statusCode).toBe(403);
  });

  it('filters: unsigned and events', async () => {
    t.app.ctx.logbook.startPassage({ name: 'P' }, null);
    const m = await ingress(t.app, CREW, { method: 'POST', url: '/api/v1/log', payload: { remarks: 'x' } });
    await ingress(t.app, CREW, { method: 'POST', url: `/api/v1/log/${m.json().id}/sign` });
    t.app.ctx.logbook.write({ kind: 'hourly', ts: T0 + HOUR });
    const unsigned = (await ingress(t.app, CREW, { method: 'GET', url: '/api/v1/log?unsigned=true' })).json() as LogEntry[];
    expect(unsigned.map((e) => e.kind).sort()).toEqual(['event', 'hourly']); // passage_start and the hourly
    const events = (await ingress(t.app, CREW, { method: 'GET', url: '/api/v1/log?kind=events' })).json() as LogEntry[];
    expect(events.map((e) => e.kind).sort()).toEqual(['event', 'manual']);
  });

  it('passage export endpoints answer with downloads', async () => {
    const p = (await ingress(t.app, CREW, { method: 'POST', url: '/api/v1/passages', payload: { name: 'Norfolk to Bermuda' } })).json();
    for (const ext of ['pdf', 'csv', 'gpx']) {
      const res = await ingress(t.app, CREW, { method: 'GET', url: `/api/v1/passages/${p.id}/export.${ext}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(new RegExp(`attachment; filename=".*Norfolk-to-Bermuda\\.${ext}"`));
    }
    expect((await ingress(t.app, CREW, { method: 'GET', url: '/api/v1/export/full.json' })).statusCode).toBe(403);
    const backup = await ingress(t.app, SKIPPER, { method: 'GET', url: '/api/v1/export/full.json' });
    expect(backup.json().format).toBe('data-hub-backup');
    expect(JSON.stringify(backup.json())).not.toContain('pin_hash');
  });

  it('PDF: a passage across midnight gets one page per UTC day', async () => {
    t.clock.set(Date.UTC(2026, 9, 18, 22, 30));
    t.app.ctx.logbook.startPassage({ name: 'Night' }, null);
    for (let h = 23; h <= 26; h++) t.app.ctx.logbook.write({ kind: 'hourly', ts: Date.UTC(2026, 9, 18, h) });
    const p = t.app.ctx.logbook.activePassage()!;
    const pdf = await PDFDocument.load(await passagePdf(p, t.app.ctx.logbook.passageEntries(p.id), DEFAULT_UNIT_PREFS));
    expect(pdf.getPageCount()).toBe(2);
    for (const page of pdf.getPages()) for (const col of PDF_COLUMNS) expect(pageText(page)).toContain(col.toUpperCase());
  });
});

describe('clock drift', () => {
  it('raises a warning when GPS and host time differ by more than 5 s', async () => {
    const t = await makeApp();
    const r = rig(t);
    t.store.update('navigation.datetime', new Date(T0 + 9_000).toISOString());
    r.scheduler.tick();
    expect(t.app.ctx.alarms.list()).toEqual([expect.objectContaining({ id: 'clockDrift', source: 'system', state: 'warn' })]);
    t.clock.advance(61_000);
    t.store.update('navigation.datetime', new Date(t.clock.now() + 1_000).toISOString());
    r.scheduler.tick();
    expect(t.app.ctx.alarms.list()).toEqual([]);
  });
});
