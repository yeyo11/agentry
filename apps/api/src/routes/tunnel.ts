import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/** The tunnel through localhost.run. A refusal (auth off, no port yet) is a `409` from the manager. */
export const tunnelRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/tunnel', () => core.tunnel.status());

  app.put<{ Body: unknown }>('/tunnel/settings', (req) => core.tunnel.updateSettings(req.body));

  app.post('/tunnel/start', () => core.tunnel.start());

  app.post('/tunnel/stop', () => core.tunnel.stop());
};
