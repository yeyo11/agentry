import type { FastifyPluginAsync } from 'fastify';
import { basename } from 'node:path';
import type { Core } from '@agentry/core';
import type { CreateProjectRequest } from '@agentry/shared';

export const sessionRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/projects', () => core.projects());

  app.post<{ Body: CreateProjectRequest }>('/projects', async (req, reply) => {
    const path = await core.workspace.create(req.body?.name ?? '', req.body?.gitUrl || undefined);
    const project = (await core.projects()).find((p) => p.path === path);
    return reply.status(201).send(project ?? { path, name: basename(path) });
  });

  app.get<{ Params: { id: string } }>('/projects/:id/sessions', (req) => core.sessionsWithLive(req.params.id));

  app.get<{ Querystring: { limit?: string } }>('/sessions', async (req) => {
    const sessions = await core.sessionsWithLive();
    const limit = Number(req.query.limit);
    return Number.isFinite(limit) && limit > 0 ? sessions.slice(0, limit) : sessions;
  });

  app.delete<{ Params: { id: string } }>('/sessions/:id', async (req) => {
    await core.deleteSession(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { sidechains?: string } }>('/sessions/:id', async (req) => {
    const detail = await core.sessions.getSession(req.params.id, { includeSidechains: req.query.sidechains === '1' });
    if (!detail) throw new Error('session not found');
    return detail;
  });
};
