import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { OrchestrationSpec, PlanRequest, ResumeOrchestrationRequest, SaveOrchestrationWorkflowRequest, TaskHintRequest } from '@agentry/shared';

export const orchestrationRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/orchestrations', () => core.orchestrator.list().map((o) => core.orchestrator.view(o)));

  app.post<{ Body: OrchestrationSpec }>('/orchestrations', async (req, reply) =>
    reply.status(201).send(core.orchestrator.create(req.body ?? ({} as OrchestrationSpec))),
  );

  // Runs a planner agent with structured output; can take a couple of minutes.
  app.post<{ Body: PlanRequest }>('/orchestrations/plan', (req) => core.orchestrator.plan(req.body ?? ({} as PlanRequest)));

  // Starts the planner and returns its chat at once, so the UI can stream the work instead of
  // holding a request open for minutes. The draft is recorded when it finishes either way.
  app.post<{ Body: PlanRequest }>('/orchestrations/plan/start', async (req, reply) => {
    const planner = core.orchestrator.startPlanAndRecord(req.body ?? ({} as PlanRequest));
    return reply.status(201).send(await core.chats.summaryOf(planner.id));
  });

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
    return core.orchestrator.view(orch);
  });

  app.post<{ Params: { id: string } }>('/orchestrations/:id/stop', (req) => core.orchestrator.stop(req.params.id));

  // Workers die with the process, so a restart leaves the graph stopped. This picks it up from
  // where it was instead of starting the whole thing over.
  app.post<{ Params: { id: string }; Body: ResumeOrchestrationRequest }>('/orchestrations/:id/resume', (req) =>
    core.orchestrator.resume(req.params.id, req.body ?? {}),
  );

  // What a person decides once a task has used its attempts: try it again, start it over, or give
  // its branch up. And the one thing a running worker takes from the board: a hint.
  app.post<{ Params: { id: string; taskId: string } }>('/orchestrations/:id/tasks/:taskId/retry', (req) =>
    core.orchestrator.retryTask(req.params.id, req.params.taskId),
  );

  app.post<{ Params: { id: string; taskId: string } }>('/orchestrations/:id/tasks/:taskId/retry-clean', (req) =>
    core.orchestrator.retryTaskClean(req.params.id, req.params.taskId),
  );

  app.post<{ Params: { id: string; taskId: string } }>('/orchestrations/:id/tasks/:taskId/skip', (req) =>
    core.orchestrator.skipTask(req.params.id, req.params.taskId),
  );

  app.post<{ Params: { id: string; taskId: string }; Body: TaskHintRequest }>('/orchestrations/:id/tasks/:taskId/hint', (req) =>
    core.orchestrator.hintTask(req.params.id, req.params.taskId, req.body?.text ?? ''),
  );

  app.delete<{ Params: { id: string } }>('/orchestrations/:id', (req) => {
    core.orchestrator.remove(req.params.id);
    return { ok: true };
  });

  // Merges the task branches into the graph's integration branch again: after resolving by hand, or
  // for a graph that finished before orchestrations integrated their own work.
  app.post<{ Params: { id: string } }>('/orchestrations/:id/integrate', (req) => core.orchestrator.retryIntegration(req.params.id));

  // The one step that leaves the machine, so it only ever happens on request
  app.post<{ Params: { id: string } }>('/orchestrations/:id/pull-request', (req) => core.orchestrator.pullRequest(req.params.id));

  // The workflow script the graph runs as, or would: generated from the graph, never hand-written
  app.get<{ Params: { id: string } }>('/orchestrations/:id/workflow', (req) => core.orchestrator.workflowScript(req.params.id));

  app.post<{ Params: { id: string }; Body: SaveOrchestrationWorkflowRequest }>('/orchestrations/:id/workflow/save', (req, reply) =>
    reply.status(201).send(core.orchestrator.saveWorkflow(req.params.id, req.body ?? {})),
  );

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/orchestrations/:id/worktrees/prune', (req) => ({
    results: core.orchestrator.pruneWorktrees(req.params.id, { force: req.body?.force === true }),
  }));
};
