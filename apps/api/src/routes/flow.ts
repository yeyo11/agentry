import type { FastifyPluginAsync } from 'fastify';
import { parseFlowRunQuery, type Core } from '@agentry/core';

/**
 * What a project's flow by column is doing and has done: its runs going and queued, the team's
 * activity a page at a time, and every run of one item. Read-only: the flow is switched and
 * configured through the project's settings, and a run starts only when a card enters a column.
 */
export const flowRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string } }>('/projects/:id/flow', (req) => core.projectFlow(req.params.id));

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/projects/:id/flow/runs', (req) =>
    core.projectFlowRuns(req.params.id, parseFlowRunQuery(req.query)),
  );

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId/runs', (req) => core.workItemRuns(req.params.itemId));
};
