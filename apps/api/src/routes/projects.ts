import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import { projectExportFilename, projectToJson, projectToMarkdown } from '@agentry/core';
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

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>('/projects/:id', (req) =>
    core.renameProject(req.params.id, req.body?.name ?? ''),
  );

  // Streamed a chat at a time: a project can hold hundreds of chats, and a transcript alone can run
  // to tens of megabytes
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/projects/:id/export', async (req, reply) => {
    const format = req.query.format ?? 'markdown';
    if (format !== 'markdown' && format !== 'json') throw new Error('format must be markdown or json');
    const source = await core.projectExport(req.params.id);
    void reply.header('content-disposition', `attachment; filename="${projectExportFilename(source.project, format)}"`);
    if (format === 'json') return reply.type('application/json; charset=utf-8').send(Readable.from(projectToJson(source)));
    return reply.type('text/markdown; charset=utf-8').send(Readable.from(projectToMarkdown(source)));
  });

  // Harmless: Agentry forgets the directory and leaves everything else where it is
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req) => {
    await core.removeProject(req.params.id);
    return { ok: true };
  });

  // Everything Claude Code keeps about a project: transcripts, tasks, file history, config entry.
  // The CLI owns that layout, so `claude project purge` does the deleting. Irreversible.
  app.delete<{ Params: { id: string } }>('/projects/:id/state', (req) => core.purgeProject(req.params.id));
};
