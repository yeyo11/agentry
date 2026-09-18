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

  app.get<{ Params: { id: string } }>('/orchestrations/:id', (req) => {
    const orch = core.orchestrator.get(req.params.id);
    if (!orch) throw new Error('orchestration not found');
    return orch;
  });

  app.post<{ Params: { id: string } }>('/orchestrations/:id/stop', (req) => core.orchestrator.stop(req.params.id));
};
