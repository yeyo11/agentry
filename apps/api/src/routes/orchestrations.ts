import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { OrchestrationSpec, PlanRequest } from '@agentry/shared';

export const orchestrationRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/orchestrations', () => core.orchestrator.list());

  app.post<{ Body: OrchestrationSpec }>('/orchestrations', async (req, reply) =>
    reply.status(201).send(core.orchestrator.create(req.body ?? ({} as OrchestrationSpec))),
  );

  // Runs a planner agent with structured output; can take a couple of minutes.
  app.post<{ Body: PlanRequest }>('/orchestrations/plan', (req) => core.orchestrator.plan(req.body ?? ({} as PlanRequest)));

  // Starts the planner and returns its run at once, so the UI can stream the work instead of
  // holding a request open for minutes. The draft is recorded when it finishes either way.
  app.post<{ Body: PlanRequest }>('/orchestrations/plan/start', async (req, reply) =>
    reply.status(201).send(core.orchestrator.startPlanAndRecord(req.body ?? ({} as PlanRequest))),
  );

  // Plans that were generated and never launched — a plan is expensive, losing one should not
  // mean paying for it twice.
  app.get<{ Querystring: { limit?: string } }>('/orchestrations/plans', (req) => {
    const limit = Number(req.query.limit);
    return core.orchestrator.drafts(Number.isFinite(limit) ? limit : undefined);
  });

  app.get<{ Params: { runId: string } }>('/orchestrations/plans/:runId', (req) => core.orchestrator.draft(req.params.runId));

  app.get<{ Params: { id: string } }>('/orchestrations/:id', (req) => {
    const orch = core.orchestrator.get(req.params.id);
    if (!orch) throw new Error('orchestration not found');
    return orch;
  });

  app.post<{ Params: { id: string } }>('/orchestrations/:id/stop', (req) => core.orchestrator.stop(req.params.id));

  // Workers die with the process, so a restart leaves the graph stopped. This picks it up from
  // where it was instead of starting the whole thing over.
  app.post<{ Params: { id: string } }>('/orchestrations/:id/resume', (req) => core.orchestrator.resume(req.params.id));

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/orchestrations/:id/worktrees/prune', (req) => ({
    results: core.orchestrator.pruneWorktrees(req.params.id, { force: req.body?.force === true }),
  }));
};
