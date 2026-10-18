import type { FastifyInstance } from 'fastify';
import { SnoozeSchema, ThresholdInputSchema } from '@watchkeeper/shared';
import type { AppContext } from '../app.js';

export function registerAlarmRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { thresholds, alarms } = ctx;

  // Thresholds: everyone sees them (tiles color by them); only the skipper changes them.
  api.get('/thresholds', { config: { minRole: 'guest' } }, async () => thresholds.list());

  api.post('/thresholds', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const t = thresholds.create(ThresholdInputSchema.parse(req.body));
    alarms.reload();
    return reply.code(201).send(t);
  });

  api.put<{ Params: { id: string } }>('/thresholds/:id', { config: { minRole: 'skipper' } }, async (req, reply) => {
    const t = thresholds.update(req.params.id, ThresholdInputSchema.parse(req.body));
    if (!t) return reply.code(404).send({ error: 'not_found', message: 'No such threshold.' });
    alarms.reload();
    return t;
  });

  api.delete<{ Params: { id: string } }>('/thresholds/:id', { config: { minRole: 'skipper' } }, async (req, reply) => {
    if (!thresholds.remove(req.params.id)) return reply.code(404).send({ error: 'not_found', message: 'No such threshold.' });
    alarms.reload();
    return { ok: true };
  });

  // Alarms. Silencing is a write: crew and up (a guest helm device elevates with a PIN).
  api.get('/alarms/active', { config: { minRole: 'guest' } }, async () => alarms.list());

  api.post<{ Params: { id: string } }>('/alarms/:id/ack', { config: { minRole: 'crew' } }, async (req, reply) => {
    return alarms.ack(req.params.id, req.user!.recordId) ?? reply.code(404).send({ error: 'not_found', message: 'No such active alarm.' });
  });

  api.post<{ Params: { id: string } }>('/alarms/:id/snooze', { config: { minRole: 'crew' } }, async (req, reply) => {
    const { minutes } = SnoozeSchema.parse(req.body);
    return alarms.snooze(req.params.id, minutes, req.user!.recordId) ?? reply.code(404).send({ error: 'not_found', message: 'No such active alarm.' });
  });
}
