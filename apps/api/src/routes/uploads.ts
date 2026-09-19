import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/** The largest file accepted, plus room; the store enforces the per-kind limits. */
const BODY_LIMIT = 51 * 1024 * 1024;

/** Types that are safe to show inline in the browser. Anything else is downloaded, never rendered. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

export const uploadRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // The file is the body, as is. Multipart would mean another dependency for one field.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) =>
    done(null, body),
  );

  app.post<{ Querystring: { name?: string }; Body: Buffer }>('/uploads', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new Error('send the file as the request body with Content-Type: application/octet-stream');
    return reply.status(201).send(core.uploads.save(req.query.name ?? 'file', req.body));
  });

  app.get<{ Params: { id: string } }>('/uploads/:id', (req) => core.uploads.get(req.params.id));

  app.get<{ Params: { id: string } }>('/uploads/:id/content', (req, reply) => {
    const { attachment, bytes } = core.uploads.read(req.params.id);
    const inline = INLINE.has(attachment.mediaType);
    return reply
      .header('content-type', inline ? attachment.mediaType : 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(bytes);
  });
};
