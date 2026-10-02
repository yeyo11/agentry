import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Core } from '@agentry/core';
import type { CodeHostId } from '@agentry/shared';

/** A delivery larger than this is refused with 413; the pacer's polling covers what it would have said. */
export const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;

/**
 * The receivers a code host delivers to. They are the one place in the API that skips the bearer
 * token (`security.ts`): the host cannot send one, and what stands in for it is the signature,
 * checked over the raw bytes before anything is parsed. A delivery never changes a change request;
 * it only moves the next read of the ones it names to now.
 */
export const webhookRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // Scoped to this plugin: the signature is over the exact bytes the host sent, so the body stays a
  // Buffer here, while every other route keeps Fastify's JSON parser. Any content type is read the
  // same way, because the verdict does not depend on what the sender called it.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));

  const receiver = (host: CodeHostId) => async (req: { params: unknown; headers: Record<string, string | string[] | undefined>; body: unknown }, reply: FastifyReply) => {
    const { registrationId } = req.params as { registrationId: string };
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    switch (core.webhookReceiver.handle(host, registrationId, req.headers, raw)) {
      case 'unauthorized':
        // No detail: the same bytes for an unknown hook, a removed one and a wrong signature
        return reply.status(401).send();
      case 'rate-limited':
        return reply.header('Retry-After', '60').status(429).send();
      default:
        // A replay is answered like the first delivery, so the host does not retry it
        return reply.status(204).send();
    }
  };

  app.post('/webhooks/github/:registrationId', receiver('github'));
  app.post('/webhooks/gitlab/:registrationId', receiver('gitlab'));
};
