import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/**
 * Web Push: the key a browser subscribes with, the installs registered to be woken, and one test
 * notification so a person can prove it works without waiting for a chat to stop.
 *
 * Guarded like every other route — these are `fetch` calls and carry the `Authorization` header, so
 * `security.ts` needs no exception for them.
 */
export const pushRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/push/key', () => core.push.keyInfo());

  app.get('/push/subscriptions', () => core.push.list());

  app.post<{ Body: unknown }>('/push/subscriptions', (req, reply) => {
    const summary = core.push.register(req.body);
    return reply.status(201).send(summary);
  });

  app.delete<{ Body: unknown }>('/push/subscriptions', (req) => core.push.remove(req.body));

  app.post<{ Body: unknown }>('/push/test', (req) => core.push.test(req.body));
};
