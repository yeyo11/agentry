import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { CreateProjectRequest, ImportProjectRequest, UpdateProjectRequest } from '@agentry/shared';

/** The directories the person imported. Nothing here discovers a project: it is added by hand. */
export const projectRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/projects', () => core.projects());

  // What a first start offers instead of an empty screen. Registered before `/projects/:id`, which
  // would otherwise take "candidates" for an id.
  app.get('/projects/candidates', () => core.projectCandidates());

  app.post<{ Body: ImportProjectRequest }>('/projects/import', async (req, reply) =>
    reply.status(201).send(await core.importProject({ path: req.body?.path ?? '', ...(req.body?.name ? { name: req.body.name } : {}) })),
  );

  // A new directory in the workspace, imported straight away: creating a project means wanting it.
  app.post<{ Body: CreateProjectRequest }>('/projects', async (req, reply) => {
    const path = await core.workspace.create(req.body?.name ?? '', req.body?.gitUrl || undefined);
    return reply.status(201).send(await core.importProject({ path }));
  });

  // Chats whose directory is under no project
  app.get('/projects/loose/sessions', () => core.sessionsWithLive(null));

  app.get<{ Params: { id: string } }>('/projects/:id/sessions', (req) => core.sessionsWithLive(req.params.id));

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>('/projects/:id', (req) =>
    core.renameProject(req.params.id, req.body?.name ?? ''),
  );

  // Harmless: Agentry forgets the directory and leaves everything else where it is
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req) => {
    await core.removeProject(req.params.id);
    return { ok: true };
  });

  // Everything Claude Code keeps about a project: transcripts, tasks, file history, config entry.
  // The CLI owns that layout, so `claude project purge` does the deleting. Irreversible.
  app.delete<{ Params: { id: string } }>('/projects/:id/state', (req) => core.purgeProject(req.params.id));
};
