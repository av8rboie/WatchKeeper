import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { AmendInputSchema, LogQuerySchema, ManualEntryInputSchema, PassageInputSchema, type Passage } from '@watchkeeper/shared';
import type { AppContext } from '../app.js';
import { iso } from '../clock.js';
import { fullBackup, passageCsv, passageGpx, passagePdf } from '../log/export.js';

const notFound = (what: string) => ({ error: 'not_found', message: `No such ${what}.` });

/** Photos only, already resized in the browser to 2048 px on the long edge. */
const ATTACHMENT_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

const fileName = (p: Passage, ext: string) =>
  `${p.startedAt.slice(0, 10)} ${p.name}`.replace(/[^A-Za-z0-9 _.-]+/g, '').trim().replace(/\s+/g, '-') + `.${ext}`;

function download(reply: FastifyReply, type: string, name: string, body: string | Buffer) {
  return reply.header('content-type', type).header('content-disposition', `attachment; filename="${name}"`).send(body);
}

/**
 * Passages, log entries, signing and amending, exports, attachments. Crew
 * and skipper read and write the log; guests see dashboards only.
 */
export async function registerLogbookRoutes(api: FastifyInstance, ctx: AppContext): Promise<void> {
  const { logbook } = ctx;
  await api.register(multipart, { limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1, fields: 4 } });

  // Passages

  api.get('/passages', { config: { minRole: 'crew' } }, async () => logbook.listPassages());

  api.post('/passages', { config: { minRole: 'crew' } }, async (req, reply) => {
    const p = logbook.startPassage(PassageInputSchema.parse(req.body), req.user!.recordId);
    return reply.code(201).send(p);
  });

  api.get('/passages/active', { config: { minRole: 'crew' } }, async () => {
    const p = logbook.activePassage();
    return { passage: p, summary: p ? logbook.summary(p.id) : null };
  });

  api.get('/passages/suggestion', { config: { minRole: 'crew' } }, async () => ({ suggestion: ctx.triggers?.currentSuggestion() ?? null }));

  api.delete('/passages/suggestion', { config: { minRole: 'crew' } }, async () => {
    ctx.triggers?.dismissSuggestion();
    return { suggestion: null };
  });

  api.get<{ Params: { id: string } }>('/passages/:id', { config: { minRole: 'crew' } }, async (req, reply) => {
    return logbook.getPassage(req.params.id) ?? reply.code(404).send(notFound('passage'));
  });

  api.put<{ Params: { id: string } }>('/passages/:id', { config: { minRole: 'crew' } }, async (req) => {
    return logbook.updatePassage(req.params.id, PassageInputSchema.parse(req.body));
  });

  api.post<{ Params: { id: string } }>('/passages/:id/end', { config: { minRole: 'crew' } }, async (req) => {
    return logbook.endPassage(req.params.id, req.user!.recordId);
  });

  api.get<{ Params: { id: string } }>('/passages/:id/summary', { config: { minRole: 'crew' } }, async (req) => logbook.summary(req.params.id));

  // Exports

  api.get<{ Params: { id: string } }>('/passages/:id/export.csv', { config: { minRole: 'crew' } }, async (req, reply) => {
    const p = logbook.getPassage(req.params.id);
    if (!p) return reply.code(404).send(notFound('passage'));
    return download(reply, 'text/csv; charset=utf-8', fileName(p, 'csv'), passageCsv(logbook.passageEntries(p.id), req.user!.unitPrefs));
  });

  api.get<{ Params: { id: string } }>('/passages/:id/export.gpx', { config: { minRole: 'crew' } }, async (req, reply) => {
    const p = logbook.getPassage(req.params.id);
    if (!p) return reply.code(404).send(notFound('passage'));
    const end = p.endedAt ? Date.parse(p.endedAt) : ctx.clock.now();
    return download(reply, 'application/gpx+xml', fileName(p, 'gpx'), passageGpx(p, logbook.trackPoints(Date.parse(p.startedAt), end)));
  });

  api.get<{ Params: { id: string } }>('/passages/:id/export.pdf', { config: { minRole: 'crew' } }, async (req, reply) => {
    const p = logbook.getPassage(req.params.id);
    if (!p) return reply.code(404).send(notFound('passage'));
    const pdf = await passagePdf(p, logbook.passageEntries(p.id), req.user!.unitPrefs);
    return download(reply, 'application/pdf', fileName(p, 'pdf'), Buffer.from(pdf));
  });

  api.get('/export/full.json', { config: { minRole: 'skipper' } }, async (_req, reply) => {
    const at = iso(ctx.time.read().now);
    return download(reply, 'application/json', `data-hub-backup-${at.slice(0, 10)}.json`, JSON.stringify(fullBackup(ctx.db, at)));
  });

  // Entries

  api.get('/log', { config: { minRole: 'crew' } }, async (req) => {
    const q = LogQuerySchema.parse(req.query);
    return logbook.list({ ...q, unsigned: q.unsigned === 'true' });
  });

  api.post('/log', { config: { minRole: 'crew' } }, async (req, reply) => {
    const input = ManualEntryInputSchema.parse(req.body);
    return reply.code(201).send(logbook.manual(input, req.user!.recordId));
  });

  api.get<{ Params: { id: string } }>('/log/:id', { config: { minRole: 'crew' } }, async (req, reply) => {
    return logbook.get(req.params.id) ?? reply.code(404).send(notFound('log entry'));
  });

  api.post<{ Params: { id: string } }>('/log/:id/sign', { config: { minRole: 'crew' } }, async (req) => logbook.sign(req.params.id, req.user!.recordId));

  api.post<{ Params: { id: string } }>('/log/:id/amend', { config: { minRole: 'crew' } }, async (req) => {
    return logbook.amend(req.params.id, AmendInputSchema.parse(req.body), req.user!.recordId, req.user!.unitPrefs);
  });

  // Attachments

  api.post('/attachments', { config: { minRole: 'crew' } }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'invalid_request', message: 'No file.' });
    const field = (name: string) => {
      const f = file.fields[name];
      const v = f && !Array.isArray(f) && 'value' in f ? f.value : undefined;
      return typeof v === 'string' ? v : undefined;
    };
    const ownerType = field('ownerType') ?? 'log_entry';
    const ownerId = field('ownerId');
    const ext = ATTACHMENT_TYPES[file.mimetype];
    if (!ext) return reply.code(415).send({ error: 'unsupported_media_type', message: 'Photos only (JPEG, PNG or WebP).' });
    if (ownerType !== 'log_entry' || !ownerId || !logbook.get(ownerId)) return reply.code(400).send({ error: 'invalid_request', message: 'Unknown log entry.' });
    const data = await file.toBuffer();
    const id = ulid();
    mkdirSync(ctx.config.filesDir, { recursive: true });
    const rel = `${id}.${ext}`;
    writeFileSync(join(ctx.config.filesDir, rel), data);
    const caption = field('caption')?.slice(0, 200) ?? null;
    ctx.db
      .prepare('INSERT INTO attachment (id, owner_type, owner_id, file_path, mime, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerType, ownerId, rel, file.mimetype, caption, iso(ctx.clock.now()));
    // Photos sit beside the entry; the entry itself is unchanged.
    ctx.hub.broadcast('log.amended', { id: ownerId });
    return reply.code(201).send({ id, mime: file.mimetype, caption });
  });

  api.get<{ Params: { id: string } }>('/attachments/:id', { config: { minRole: 'crew' } }, async (req, reply) => {
    const row = ctx.db.prepare('SELECT file_path, mime FROM attachment WHERE id = ?').get(req.params.id) as { file_path: string; mime: string } | undefined;
    if (!row) return reply.code(404).send(notFound('attachment'));
    return reply
      .header('content-type', row.mime)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(join(ctx.config.filesDir, row.file_path)));
  });
}
