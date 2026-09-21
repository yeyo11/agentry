import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/**
 * The optional supervisor: its settings, and what a person does with a hint it proposed for a worker.
 * A proposal is acted on from where its worker is followed, the chat or the task of its graph, and
 * sending it goes through the hint route of that place.
 */
export const supervisorRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/settings/supervisor', () => core.supervisor.config);
  app.put<{ Body: unknown }>('/settings/supervisor', (req) => core.supervisor.configure(req.body));

  app.post<{ Params: { id: string; proposalId: string } }>('/chats/:id/supervisor/:proposalId/send', (req) =>
    core.supervisor.send(req.params.proposalId, { chatId: req.params.id }),
  );
  app.post<{ Params: { id: string; proposalId: string } }>('/chats/:id/supervisor/:proposalId/dismiss', (req) =>
    core.supervisor.dismiss(req.params.proposalId, { chatId: req.params.id }),
  );
  app.post<{ Params: { id: string; taskId: string; proposalId: string } }>('/orchestrations/:id/tasks/:taskId/supervisor/:proposalId/send', (req) =>
    core.supervisor.send(req.params.proposalId, { orchestrationId: req.params.id, taskId: req.params.taskId }),
  );
  app.post<{ Params: { id: string; taskId: string; proposalId: string } }>('/orchestrations/:id/tasks/:taskId/supervisor/:proposalId/dismiss', (req) =>
    core.supervisor.dismiss(req.params.proposalId, { orchestrationId: req.params.id, taskId: req.params.taskId }),
  );
};
