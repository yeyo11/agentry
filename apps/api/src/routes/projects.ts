import type { FastifyPluginAsync } from 'fastify';
import { basename } from 'node:path';
import type { Core } from '@agentry/core';
import type { CreateProjectRequest } from '@agentry/shared';

export const projectRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/projects', () => core.projects());

  app.post<{ Body: CreateProjectRequest }>('/projects', async (req, reply) => {
    const path = await core.workspace.create(req.body?.name ?? '', req.body?.gitUrl || undefined);
    const project = (await core.projects()).find((p) => p.path === path);
    return reply.status(201).send(project ?? { path, name: basename(path) });
  });

  // Everything Claude Code keeps about a project: transcripts, tasks, file history, config entry.
  // The CLI owns that layout, so `claude project purge` does the deleting.
  app.delete<{ Params: { id: string } }>('/projects/:id/state', async (req) => {
    const project = (await core.projects()).find((p) => p.id === req.params.id);
    if (!project) throw new Error('project not found');
    return core.purgeProject(project.path);
  });
};
