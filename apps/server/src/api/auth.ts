import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MeSchema, PinElevateSchema, PinUserSchema, PutUsersSchema, UnitPrefsSchema, UserMappingSchema, type Me } from '@watchkeeper/shared';
import { z } from 'zod';
import { ELEVATION_COOKIE, type AppContext } from '../app.js';

function me(req: FastifyRequest): Me {
  const u = req.user!;
  return MeSchema.parse({ id: u.haId, name: u.name, role: u.role, roleSource: u.roleSource, actingAs: u.actingAs, unitPrefs: u.unitPrefs });
}

export function registerAuthRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { users, elevations } = ctx;

  api.get('/auth/me', { config: { minRole: 'guest' } }, async (req) => me(req));

  api.put('/auth/me/units', { config: { minRole: 'crew' } }, async (req) => {
    const prefs = UnitPrefsSchema.parse(req.body);
    users.setUnitPrefs(req.user!.haId, prefs);
    return MeSchema.parse({ ...me(req), unitPrefs: prefs });
  });

  // Shared helm devices: a guest HA user elevates to crew for 12 h with a
  // crew member's PIN. Entries made while elevated are recorded as that crew member.
  api.get('/auth/pin-users', { config: { minRole: 'guest' } }, async () => z.array(PinUserSchema).parse(users.pinUsers()));

  api.post('/auth/pin', { config: { minRole: 'guest' } }, async (req, reply) => {
    const body = PinElevateSchema.parse(req.body);
    const result = await users.verifyPin(body.userId, body.pin);
    if (!result.ok) {
      if (result.reason === 'locked') {
        reply.header('retry-after', Math.ceil((result.retryAfterMs ?? 0) / 1000));
        return reply.code(423).send({ error: 'locked', message: 'Too many wrong PINs. Try again in 5 minutes.' });
      }
      return reply.code(401).send({ error: 'bad_credentials' });
    }
    const e = elevations.create(result.user.id, req.user!.haId);
    reply.setCookie(ELEVATION_COOKIE, e.token, { httpOnly: true, sameSite: 'strict', path: '/', expires: new Date(e.expiresAt) });
    return MeSchema.parse({
      ...me(req),
      role: req.user!.role === 'guest' ? 'crew' : req.user!.role,
      roleSource: req.user!.role === 'guest' ? 'pin' : req.user!.roleSource,
      actingAs: { id: result.user.id, name: result.user.name, until: new Date(e.expiresAt).toISOString() },
    });
  });

  api.delete('/auth/pin', { config: { minRole: 'crew' } }, async (req, reply) => {
    const token = req.cookies[ELEVATION_COOKIE];
    if (token) elevations.revoke(token);
    reply.clearCookie(ELEVATION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Role mapping: the skipper assigns HA users to roles. Unmapped users are guests.
  api.get('/users', { config: { minRole: 'skipper' } }, async () => z.array(UserMappingSchema).parse(users.list()));

  api.put('/users', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const body = PutUsersSchema.parse(req.body);
    const current = new Map(users.list().map((u) => [u.id, u]));
    for (const u of body.users) {
      if (!current.has(u.id)) return reply.code(404).send({ error: 'not_found', message: `Unknown user ${u.id}` });
    }
    const skippersAfter = [...current.values()].filter((u) => {
      const change = body.users.find((c) => c.id === u.id);
      return (change ? change.role : u.role) === 'skipper';
    }).length;
    if (skippersAfter === 0) return reply.code(409).send({ error: 'conflict', message: 'The boat needs at least one skipper.' });
    for (const u of body.users) await users.setMapping(u.id, u.role, u.pin);
    return z.array(UserMappingSchema).parse(users.list());
  });

  // First run: the first HA user to open Data Hub claims the skipper role.
  // Closed once a skipper exists.
  api.get('/setup/status', { config: { minRole: 'guest' } }, async () => ({ needsSetup: users.skipperCount() === 0 }));

  api.post('/setup/claim', { config: { minRole: 'guest' } }, async (req, reply) => {
    if (users.skipperCount() > 0) return reply.code(403).send({ error: 'forbidden', message: 'This boat already has a skipper.' });
    await users.setMapping(req.user!.haId, 'skipper', undefined);
    return MeSchema.parse({ ...me(req), role: 'skipper', roleSource: 'mapped', actingAs: null });
  });
}
