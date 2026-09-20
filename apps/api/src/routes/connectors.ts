import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/** The claude.ai connectors the CLI reports. Read-only: authorising one is up to a person. */
export const connectorRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Querystring: { refresh?: string } }>('/connectors', (req) => core.connectors.overview(req.query.refresh === 'true'));
};
