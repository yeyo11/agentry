import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/**
 * What a project's flow by column is doing now: its runs going and queued. Read-only: the flow is
 * switched and configured through the project's settings, and a run starts only when a card enters
 * a column.
 */
export const flowRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string } }>('/projects/:id/flow', (req) => core.projectFlow(req.params.id));
};
