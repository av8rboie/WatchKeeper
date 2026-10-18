import type { FastifyInstance } from 'fastify';
import {
  CreateUserSchema,
  LoginRequestSchema,
  MeSchema,
  SetupSkipperSchema,
  UnitPrefsSchema,
  UpdateUserSchema,
  UserPublicSchema,
} from '@watchkeeper/shared';
import { z } from 'zod';
import { SESSION_COOKIE, type AppContext } from '../app.js';
import { BROWSER_TOKEN, readToken } from '../signalk/deviceAuth.js';

const IdParam = z.object({ id: z.string().min(1) });

export function registerAuthRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { users, sessions } = ctx;

  api.post('/auth/login', { config: { minRole: 'public' } }, async (req, reply) => {
    const body = LoginRequestSchema.parse(req.body);
    const result = await users.verifyPin(body.userId, body.pin);
    if (!result.ok) {
      if (result.reason === 'locked') {
        reply.header('retry-after', Math.ceil((result.retryAfterMs ?? 0) / 1000));
        return reply.code(423).send({ error: 'locked', message: 'Too many wrong PINs. Try again in 5 minutes.' });
      }
      return reply.code(401).send({ error: 'bad_credentials' });
    }
    const s = sessions.create(result.user.id);
    ctx.setSessionCookie(reply, s.token, s.expiresAt);
    return MeSchema.parse(result.user);
  });

  api.post('/auth/logout', { config: { minRole: 'public' } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) sessions.revoke(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  api.get('/auth/me', { config: { minRole: 'guest' } }, async (req) => MeSchema.parse(req.user));

  api.put('/auth/me/units', { config: { minRole: 'crew' } }, async (req) => {
    const prefs = UnitPrefsSchema.parse(req.body);
    users.setUnitPrefs(req.user!.id, prefs);
    return MeSchema.parse(users.get(req.user!.id));
  });

  api.get('/auth/signalk-token', { config: { minRole: 'guest' } }, async () => ({
    token: readToken(ctx.config.configDir, BROWSER_TOKEN),
  }));

  // Login picker: names and roles only, never PINs.
  api.get('/users', { config: { minRole: 'public' } }, async () => z.array(UserPublicSchema).parse(users.list()));

  api.post('/users', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const body = CreateUserSchema.parse(req.body);
    const u = await users.create(body.name, body.role, body.pin);
    return reply.code(201).send(UserPublicSchema.parse(u));
  });

  api.put('/users/:id', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const u = await users.update(id, UpdateUserSchema.parse(req.body));
    if (!u) return reply.code(404).send({ error: 'not_found' });
    return UserPublicSchema.parse(u);
  });

  api.delete('/users/:id', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (id === req.user!.id) return reply.code(409).send({ error: 'conflict', message: 'You cannot delete yourself.' });
    if (!users.remove(id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // First run: create the skipper account. Closed once any user exists.
  api.get('/setup/status', { config: { minRole: 'public' } }, async () => ({ needsSetup: users.count() === 0 }));

  api.post('/setup/skipper', { config: { minRole: 'public' } }, async (req, reply) => {
    if (users.count() > 0) return reply.code(403).send({ error: 'forbidden', message: 'Setup is already complete.' });
    const body = SetupSkipperSchema.parse(req.body);
    const u = await users.create(body.name, 'skipper', body.pin);
    const s = sessions.create(u.id);
    ctx.setSessionCookie(reply, s.token, s.expiresAt);
    return reply.code(201).send(MeSchema.parse(u));
  });
}
