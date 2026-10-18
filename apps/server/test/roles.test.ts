import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { login, makeApp } from './helpers/app.js';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Write routes anyone may call: they establish or end a session, or run first-time setup. */
const PUBLIC_WRITES = new Set(['POST /api/v1/auth/login', 'POST /api/v1/auth/logout', 'POST /api/v1/setup/skipper']);

describe('roles', () => {
  let app: FastifyInstance;
  let guest: string;
  let crew: string;
  let skipper: string;
  let crewId: string;

  beforeAll(async () => {
    const ctx = await makeApp();
    app = ctx.app;
    const s = await ctx.users.create('Skipper', 'skipper', '1111');
    const c = await ctx.users.create('Crew', 'crew', '2222');
    const g = await ctx.users.create('Guest', 'guest', '3333');
    crewId = c.id;
    skipper = await login(app, s.id, '1111');
    crew = await login(app, c.id, '2222');
    guest = await login(app, g.id, '3333');
  });

  it('guest gets 403 on every write route', async () => {
    const writes = app.ctx.routes.filter((r) => WRITE.has(r.method) && !PUBLIC_WRITES.has(`${r.method} ${r.url}`));
    expect(writes.length).toBeGreaterThan(0);
    for (const r of writes) {
      const res = await app.inject({ method: r.method as 'POST', url: r.url.replace(/:(\w+)/g, 'x'), headers: { cookie: guest }, payload: {} });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });

  it('no write route is open to guests by declaration', () => {
    for (const r of app.ctx.routes.filter((r) => WRITE.has(r.method))) {
      if (PUBLIC_WRITES.has(`${r.method} ${r.url}`)) continue;
      expect(r.minRole, `${r.method} ${r.url}`).not.toBe('guest');
      expect(r.minRole, `${r.method} ${r.url}`).not.toBe('public');
    }
  });

  it('first-run setup is closed once a user exists', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/skipper', headers: { cookie: guest }, payload: { name: 'X', pin: '9999' } });
    expect(res.statusCode).toBe(403);
  });

  it('every non-public route needs a session', async () => {
    for (const r of app.ctx.routes.filter((r) => r.minRole !== 'public' && r.url !== '/api/v1/events')) {
      const res = await app.inject({ method: r.method as 'GET', url: r.url.replace(/:(\w+)/g, 'x') });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('guest can read, crew can set units, only skipper manages users', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/paths', headers: { cookie: guest } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/system/status', headers: { cookie: guest } })).statusCode).toBe(200);

    const units = await app.inject({ method: 'PUT', url: '/api/v1/auth/me/units', headers: { cookie: crew }, payload: { speed: 'km/h' } });
    expect(units.statusCode).toBe(200);
    expect(units.json().unitPrefs.speed).toBe('km/h');
    expect(units.json().unitPrefs.depth).toBe('ft');

    const addByCrew = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: crew }, payload: { name: 'New', role: 'crew', pin: '4444' } });
    expect(addByCrew.statusCode).toBe(403);
    const addBySkipper = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: skipper }, payload: { name: 'New', role: 'crew', pin: '4444' } });
    expect(addBySkipper.statusCode).toBe(201);
    const rename = await app.inject({ method: 'PUT', url: `/api/v1/users/${crewId}`, headers: { cookie: skipper }, payload: { name: 'Mate' } });
    expect(rename.json().name).toBe('Mate');
  });
});

describe('login', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie with a 30-day expiry', async () => {
    const { app, users, clock } = await makeApp();
    const u = await users.create('Skipper', 'skipper', '1111');
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { userId: u.id, pin: '1111' } });
    const c = res.cookies.find((x) => x.name === 'dh_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
    expect((c.expires as Date).getTime() - clock.now()).toBe(30 * 24 * 3600_000);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `dh_session=${c.value}` } });
    expect(me.json()).toMatchObject({ name: 'Skipper', role: 'skipper', unitPrefs: { speed: 'kn' } });
  });

  it('the user list never includes PINs', async () => {
    const { app, users } = await makeApp();
    await users.create('Skipper', 'skipper', '1111');
    const res = await app.inject({ method: 'GET', url: '/api/v1/users' });
    expect(res.body).not.toMatch(/pin|argon/i);
  });

  it('locks a user for 5 minutes after 5 bad PINs', async () => {
    const { app, users, clock } = await makeApp();
    const u = await users.create('Crew', 'crew', '2222');
    const attempt = (pin: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { userId: u.id, pin } });
    for (let i = 0; i < 4; i++) expect((await attempt('0000')).statusCode).toBe(401);
    expect((await attempt('0000')).statusCode).toBe(423);
    // Even the right PIN is refused while locked.
    expect((await attempt('2222')).statusCode).toBe(423);
    clock.advance(5 * 60_000 + 1);
    expect((await attempt('2222')).statusCode).toBe(200);
  });

  it('sessions slide forward on use and expire after 30 idle days', async () => {
    const { app, users, clock } = await makeApp();
    const u = await users.create('Crew', 'crew', '2222');
    const cookie = await login(app, u.id, '2222');
    clock.advance(20 * 24 * 3600_000);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(200);
    clock.advance(20 * 24 * 3600_000); // 40 days after login, 20 after last use
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(200);
    clock.advance(31 * 24 * 3600_000);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('database', () => {
  it('log entries cannot be updated or deleted', async () => {
    const { db } = await makeApp();
    db.prepare("INSERT INTO log_entry (id, ts, kind, snapshot) VALUES ('e1', '2026-10-18T12:00:00.000Z', 'hourly', '{}')").run();
    expect(() => db.prepare("UPDATE log_entry SET snapshot = '{\"x\":1}' WHERE id = 'e1'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM log_entry WHERE id = 'e1'").run()).toThrow(/cannot be deleted/);
  });
});
