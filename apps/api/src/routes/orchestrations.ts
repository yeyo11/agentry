import type { FastifyPluginAsync } from 'fastify';
import { parseChangeScope, parseDiffContext, summarizeOrchestration, type Core, type DiffOptions } from '@agentry/core';
import type {
  LaunchOrchestrationTemplateRequest,
  OrchestrationSpec,
  PlanRequest,
  RelaunchOrchestrationRequest,
  ResumeOrchestrationRequest,
  SaveOrchestrationTemplateRequest,
  SaveOrchestrationWorkflowRequest,
  TaskHintRequest,
  UpdateOrchestrationTemplateRequest,
  VerifyOrchestrationRequest,
} from '@agentry/shared';

/** The file a diff is asked for: required, since a whole-branch diff is not what the panel opens. */
/** The file a diff is asked for: one path, which a repeated parameter would make a list of. */
export const pathOf = (path: unknown): string => {
  if (Array.isArray(path)) throw new Error('path is given more than once');
  if (typeof path !== 'string' || !path) throw new Error('path is required');
  return path;
};

/** The part of a branch's work a summary or a diff is about: all of it, one commit, or what is not committed. */
export interface ScopeQuery {
  commit?: string;
  uncommitted?: string;
}

export interface DiffQuery extends ScopeQuery {
  path?: string;
  context?: string;
}

export const diffOptions = (query: DiffQuery): DiffOptions => ({ ...parseChangeScope(query), context: parseDiffContext(query.context) });

export const orchestrationRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/orchestrations', () => core.orchestrator.list().map((o) => summarizeOrchestration(core.orchestrator.view(o))));

  // Through core rather than the orchestrator: a node that names a work item is checked and linked
  app.post<{ Body: OrchestrationSpec }>('/orchestrations', async (req, reply) =>
    reply.status(201).send(await core.launchOrchestration(req.body ?? ({} as OrchestrationSpec))),
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

  // Saved graphs. Static segments win over `:id`, so these sit beside `plans` without colliding.
  app.get('/orchestrations/templates', () => core.orchestrator.templates.list());

  app.post<{ Body: SaveOrchestrationTemplateRequest }>('/orchestrations/templates', (req, reply) =>
    reply.status(201).send(core.orchestrator.saveTemplate(req.body ?? ({} as SaveOrchestrationTemplateRequest))),
  );

  app.get<{ Params: { templateId: string } }>('/orchestrations/templates/:templateId', (req) => {
    const template = core.orchestrator.templates.get(req.params.templateId);
    if (!template) throw new Error('template not found');
    return template;
  });

  app.patch<{ Params: { templateId: string }; Body: UpdateOrchestrationTemplateRequest }>('/orchestrations/templates/:templateId', (req) =>
    core.orchestrator.templates.update(req.params.templateId, req.body ?? {}),
  );

  app.delete<{ Params: { templateId: string } }>('/orchestrations/templates/:templateId', (req) => {
    core.orchestrator.templates.remove(req.params.templateId);
    return { ok: true };
  });

  app.post<{ Params: { templateId: string }; Body: LaunchOrchestrationTemplateRequest }>('/orchestrations/templates/:templateId/launch', (req, reply) =>
    reply.status(201).send(core.orchestrator.launchTemplate(req.params.templateId, req.body ?? {})),
  );

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

  // A finished graph's task, run again with what depends on it
  app.post<{ Params: { id: string; taskId: string } }>('/orchestrations/:id/tasks/:taskId/rerun', (req) =>
    core.orchestrator.rerunTask(req.params.id, req.params.taskId),
  );

  app.post<{ Params: { id: string; taskId: string } }>('/orchestrations/:id/tasks/:taskId/skip', (req) =>
    core.orchestrator.skipTask(req.params.id, req.params.taskId),
  );

  app.post<{ Params: { id: string; taskId: string }; Body: TaskHintRequest }>('/orchestrations/:id/tasks/:taskId/hint', (req) =>
    core.orchestrator.hintTask(req.params.id, req.params.taskId, req.body?.text ?? ''),
  );

  // The same graph with corrections, as a new orchestration that records where it came from. Through
  // core, as a launch is: its nodes still name their work items, and are checked the same way
  app.post<{ Params: { id: string }; Body: RelaunchOrchestrationRequest }>('/orchestrations/:id/relaunch', async (req, reply) =>
    reply.status(201).send(await core.relaunchOrchestration(req.params.id, req.body ?? {})),
  );

  // What a worker actually did on disk, from git and from its transcript rather than from what it says
  app.get<{ Params: { id: string; taskId: string }; Querystring: ScopeQuery }>('/orchestrations/:id/tasks/:taskId/changes', (req) =>
    core.changes.taskChanges(req.params.id, req.params.taskId, parseChangeScope(req.query)),
  );

  app.get<{ Params: { id: string; taskId: string }; Querystring: DiffQuery }>('/orchestrations/:id/tasks/:taskId/changes/diff', (req) =>
    core.changes.taskDiff(req.params.id, req.params.taskId, pathOf(req.query.path), diffOptions(req.query)),
  );

  app.get<{ Params: { id: string; taskId: string } }>('/orchestrations/:id/tasks/:taskId/changes/steps', (req) =>
    core.changes.taskSteps(req.params.id, req.params.taskId),
  );

  app.get<{ Params: { id: string; taskId: string } }>('/orchestrations/:id/tasks/:taskId/checklist', (req) =>
    core.changes.taskChecklist(req.params.id, req.params.taskId),
  );

  app.get<{ Params: { id: string }; Querystring: ScopeQuery }>('/orchestrations/:id/integration/changes', (req) =>
    core.changes.integrationChanges(req.params.id, parseChangeScope(req.query)),
  );

  app.get<{ Params: { id: string }; Querystring: DiffQuery }>('/orchestrations/:id/integration/changes/diff', (req) =>
    core.changes.integrationDiff(req.params.id, pathOf(req.query.path), diffOptions(req.query)),
  );

  app.delete<{ Params: { id: string } }>('/orchestrations/:id', (req) => {
    core.orchestrator.remove(req.params.id);
    return { ok: true };
  });

  // Merges the task branches into the graph's integration branch again: after resolving by hand, or
  // for a graph that finished before orchestrations integrated their own work.
  app.post<{ Params: { id: string } }>('/orchestrations/:id/integrate', (req) => core.orchestrator.retryIntegration(req.params.id));

  // Runs the graph's checks on the integration branch: by hand, or again after a change to it
  app.post<{ Params: { id: string }; Body: VerifyOrchestrationRequest }>('/orchestrations/:id/verify', (req) =>
    core.orchestrator.verify(req.params.id, req.body ?? {}),
  );

  // The one step that leaves the machine, so it only ever happens on request
  app.post<{ Params: { id: string } }>('/orchestrations/:id/pull-request', async (req) => await core.orchestrator.pullRequest(req.params.id));

  // The workflow script the graph runs as, or would: generated from the graph, never hand-written
  app.get<{ Params: { id: string } }>('/orchestrations/:id/workflow', (req) => core.orchestrator.workflowScript(req.params.id));

  app.post<{ Params: { id: string }; Body: SaveOrchestrationWorkflowRequest }>('/orchestrations/:id/workflow/save', (req, reply) =>
    reply.status(201).send(core.orchestrator.saveWorkflow(req.params.id, req.body ?? {})),
  );

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/orchestrations/:id/worktrees/prune', (req) => ({
    results: core.orchestrator.pruneWorktrees(req.params.id, { force: req.body?.force === true }),
  }));
};
