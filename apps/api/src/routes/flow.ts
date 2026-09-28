import type { FastifyPluginAsync } from 'fastify';
import { parseFlowRunQuery, type Core } from '@agentry/core';

/**
 * What a project's flow by column is doing and has done: its runs going and queued, the team's
 * activity a page at a time, and every run of one item. The flow is switched and configured through
 * the project's settings, and a run starts when a card enters a column; the one thing a person asks
 * of it here is to retry a run that failed.
 */
export const flowRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string } }>('/projects/:id/flow', (req) => core.projectFlow(req.params.id));

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/projects/:id/flow/runs', (req) =>
    core.projectFlowRuns(req.params.id, parseFlowRunQuery(req.query)),
  );

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId/runs', (req) => core.workItemRuns(req.params.itemId));

  app.post<{ Params: { runId: string } }>('/flow-runs/:runId/retry', async (req, reply) => {
    const run = await core.retryFlowRun(req.params.runId);
    return reply.code(201).send(run);
  });
};
