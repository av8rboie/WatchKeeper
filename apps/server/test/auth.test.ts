import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CREW, GUEST, ingress, makeApp, seedUsers, SKIPPER } from './helpers/app.js';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Write routes a guest may call: PIN elevation itself, and first-run skipper claim (closed once a skipper exists). */
const GUEST_WRITES = new Set(['POST /api/v1/auth/pin', 'POST /api/v1/setup/claim']);

describe('ingress', () => {
  it('rejects requests from any address other than the ingress proxy, even with user headers', async () => {
    const { app } = await makeApp();
    for (const remoteAddress of ['127.0.0.1', '172.30.32.1', '192.168.1.20', '::1']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        remoteAddress,
        headers: { 'x-remote-user-id': SKIPPER.id, 'x-remote-user-name': 'skipper' },
      });
      expect(res.statusCode, remoteAddress).toBe(403);
    }
  });

  it('accepts the proxy address in IPv4-mapped IPv6 form', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: '::ffff:172.30.32.2', headers: { 'x-remote-user-id': 'u1' } });
    expect(res.statusCode).toBe(200);
  });

  it('needs an HA user header', async () => {
    const { app } = await makeApp();
    expect((await ingress(app, null, { method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('the health check answers the watchdog from any address', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '172.30.33.5' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('an unseen HA user arrives as an unmapped guest', async () => {
    const { app } = await makeApp();
    const res = await ingress(app, { id: 'new-user', name: 'Visitor' }, { method: 'GET', url: '/api/v1/auth/me' });
    expect(res.json()).toMatchObject({ id: 'new-user', name: 'Visitor', role: 'guest', roleSource: 'unmapped', actingAs: null });
  });
});

describe('roles', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await makeApp());
    await seedUsers(app);
  });

  it('guest gets 403 on every write route', async () => {
    const writes = app.ctx.routes.filter((r) => WRITE.has(r.method) && !GUEST_WRITES.has(`${r.method} ${r.url}`));
    expect(writes.length).toBeGreaterThan(0);
    for (const r of writes) {
      const res = await ingress(app, GUEST, { method: r.method as 'POST', url: r.url.replace(/:(\w+)/g, 'x'), payload: {} });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });

  it('no write route is open to guests by declaration, except the two that must be', () => {
    for (const r of app.ctx.routes.filter((r) => WRITE.has(r.method))) {
      if (GUEST_WRITES.has(`${r.method} ${r.url}`)) continue;
      expect(['crew', 'skipper'], `${r.method} ${r.url}`).toContain(r.minRole);
    }
  });

  it('skipper claim is closed once a skipper exists', async () => {
    const res = await ingress(app, GUEST, { method: 'POST', url: '/api/v1/setup/claim' });
    expect(res.statusCode).toBe(403);
  });

  it('only the skipper maps roles, and the last skipper cannot be removed', async () => {
    expect((await ingress(app, CREW, { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(403);
    const list = await ingress(app, SKIPPER, { method: 'GET', url: '/api/v1/users' });
    expect(list.json().map((u: { id: string }) => u.id)).toEqual(expect.arrayContaining([SKIPPER.id, CREW.id, GUEST.id]));
    expect(list.body).not.toMatch(/argon|pin_hash/);

    const demote = await ingress(app, SKIPPER, { method: 'PUT', url: '/api/v1/users', payload: { users: [{ id: SKIPPER.id, role: 'crew' }] } });
    expect(demote.statusCode).toBe(409);

    const map = await ingress(app, SKIPPER, { method: 'PUT', url: '/api/v1/users', payload: { users: [{ id: GUEST.id, role: 'crew' }] } });
    expect(map.statusCode).toBe(200);
    expect((await ingress(app, GUEST, { method: 'GET', url: '/api/v1/auth/me' })).json()).toMatchObject({ role: 'crew', roleSource: 'mapped' });
    await ingress(app, SKIPPER, { method: 'PUT', url: '/api/v1/users', payload: { users: [{ id: GUEST.id, role: 'guest' }] } });
  });

  it('crew can save units for their HA user', async () => {
    const res = await ingress(app, CREW, { method: 'PUT', url: '/api/v1/auth/me/units', payload: { speed: 'km/h' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().unitPrefs).toMatchObject({ speed: 'km/h', depth: 'ft' });
  });
});

describe('first run', () => {
  it('the first HA user to claim becomes skipper', async () => {
    const { app } = await makeApp();
    expect((await ingress(app, SKIPPER, { method: 'GET', url: '/api/v1/setup/status' })).json()).toEqual({ needsSetup: true });
    const claim = await ingress(app, SKIPPER, { method: 'POST', url: '/api/v1/setup/claim' });
    expect(claim.json()).toMatchObject({ role: 'skipper' });
    expect((await ingress(app, CREW, { method: 'POST', url: '/api/v1/setup/claim' })).statusCode).toBe(403);
    expect((await ingress(app, CREW, { method: 'GET', url: '/api/v1/setup/status' })).json()).toEqual({ needsSetup: false });
  });
});

describe('helm PIN elevation', () => {
  const elevate = (app: FastifyInstance, pin: string, user = GUEST) =>
    ingress(app, user, { method: 'POST', url: '/api/v1/auth/pin', payload: { userId: CREW.id, pin } });

  it('a guest device elevates to crew with a crew member’s PIN, acting as them', async () => {
    const { app } = await makeApp();
    await seedUsers(app);
    const pinUsers = await ingress(app, GUEST, { method: 'GET', url: '/api/v1/auth/pin-users' });
    expect(pinUsers.json()).toEqual(expect.arrayContaining([{ id: CREW.id, name: 'Crew' }]));

    expect((await elevate(app, '0000')).statusCode).toBe(401);
    const ok = await elevate(app, '2222');
    expect(ok.statusCode).toBe(200);
    const c = ok.cookies.find((x) => x.name === 'dh_elevation')!;
    expect(c.httpOnly).toBe(true);
    const cookie = `dh_elevation=${c.value}`;

    const me = await ingress(app, GUEST, { method: 'GET', url: '/api/v1/auth/me', cookie });
    expect(me.json()).toMatchObject({ id: GUEST.id, role: 'crew', roleSource: 'pin', actingAs: { id: CREW.id, name: 'Crew' } });

    // The elevation belongs to the HA user who entered the PIN.
    const other = await ingress(app, { id: 'someone-else', name: 'Other' }, { method: 'GET', url: '/api/v1/auth/me', cookie });
    expect(other.json()).toMatchObject({ role: 'guest', actingAs: null });

    // Ending it returns the device to guest.
    expect((await ingress(app, GUEST, { method: 'DELETE', url: '/api/v1/auth/pin', cookie })).statusCode).toBe(200);
    expect((await ingress(app, GUEST, { method: 'GET', url: '/api/v1/auth/me', cookie })).json().role).toBe('guest');
  });

  it('expires after 12 hours', async () => {
    const { app, clock } = await makeApp();
    await seedUsers(app);
    const cookie = `dh_elevation=${(await elevate(app, '2222')).cookies.find((x) => x.name === 'dh_elevation')!.value}`;
    clock.advance(12 * 3600_000 - 1000);
    expect((await ingress(app, GUEST, { method: 'GET', url: '/api/v1/auth/me', cookie })).json().role).toBe('crew');
    clock.advance(2000);
    expect((await ingress(app, GUEST, { method: 'GET', url: '/api/v1/auth/me', cookie })).json().role).toBe('guest');
  });

  it('locks for 5 minutes after 5 bad PINs', async () => {
    const { app, clock } = await makeApp();
    await seedUsers(app);
    for (let i = 0; i < 4; i++) expect((await elevate(app, '0000')).statusCode).toBe(401);
    expect((await elevate(app, '0000')).statusCode).toBe(423);
    expect((await elevate(app, '2222')).statusCode).toBe(423);
    clock.advance(5 * 60_000 + 1);
    expect((await elevate(app, '2222')).statusCode).toBe(200);
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
