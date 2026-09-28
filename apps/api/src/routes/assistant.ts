import type { FastifyPluginAsync } from 'fastify';
import { assistantLanguage, type Core } from '@agentry/core';
import type { AcceptAssistantProposalRequest, StartAssistantRunRequest } from '@agentry/shared';

/**
 * The project assistant: read-only runs through the CLI that propose a team, resources and work
 * items, and the person's decision on each proposal. Nothing is written until a proposal is
 * accepted, and then through the service that owns it. Validation lives in core.
 */
export const assistantRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.post<{ Params: { id: string }; Body: StartAssistantRunRequest }>('/projects/:id/assistant/runs', async (req, reply) => {
    // The chat's title is written in the language the person reads Agentry in, which the web sends
    const run = await core.assistant.start(req.params.id, req.body ?? {}, assistantLanguage(req.headers['accept-language']));
    return reply.code(201).send(run);
  });

  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>('/projects/:id/assistant/runs', (req) => {
    core.assistantProjectExists(req.params.id);
    return core.assistant.runs(req.params.id, req.query.kind);
  });

  app.get<{ Params: { runId: string } }>('/assistant/runs/:runId', (req) => core.assistant.run(req.params.runId));

  app.post<{ Params: { runId: string } }>('/assistant/runs/:runId/stop', (req) => core.assistant.stop(req.params.runId));

  app.post<{ Params: { proposalId: string }; Body: AcceptAssistantProposalRequest }>('/assistant/proposals/:proposalId/accept', (req) =>
    core.assistant.accept(req.params.proposalId, req.body ?? {}),
  );

  app.post<{ Params: { proposalId: string } }>('/assistant/proposals/:proposalId/discard', (req) => core.assistant.discard(req.params.proposalId));

  app.post<{ Params: { proposalId: string } }>('/assistant/proposals/:proposalId/restore', (req) => core.assistant.restore(req.params.proposalId));
};
