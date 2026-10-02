import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import { projectExportFilename, projectToJson, projectToMarkdown, WorkItemError } from '@agentry/core';
import type { CreateProjectRequest, ImportProjectRequest, ProjectTrackerSettings, TrackerImportRequest, TrackerImportResult, TrackerIssuesPage, UpdateProjectRequest } from '@agentry/shared';

/** The directories the person imported. Nothing here discovers a project: it is added by hand. */
export const projectRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/projects', () => core.projects());

  // What a first start offers instead of an empty screen. Registered before `/projects/:id`, which
  // would otherwise take "candidates" for an id.
  app.get('/projects/candidates', () => core.projectCandidates());

  // Also before `/projects/:id`, for the same reason
  app.get('/projects/templates', () => core.projectTemplates());

  app.post<{ Body: ImportProjectRequest }>('/projects/import', async (req, reply) =>
    reply.status(201).send(await core.importProject({ ...req.body, path: req.body?.path ?? '' })),
  );

  // A new directory in the workspace, imported straight away: creating a project means wanting it.
  app.post<{ Body: CreateProjectRequest }>('/projects', async (req, reply) =>
    reply.status(201).send(await core.createProject({ ...req.body, name: req.body?.name ?? '' })),
  );

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>('/projects/:id', (req) => core.updateProject(req.params.id, req.body ?? {}));

  app.get<{ Params: { id: string } }>('/projects/:id/settings', (req) => core.projectSettings(req.params.id));

  // Whether the project can open pull and merge requests, and where `origin` points
  app.get<{ Params: { id: string } }>('/projects/:id/code-host', async (req) => {
    const host = await core.projectCodeHost(req.params.id);
    if (!host) throw Object.assign(new Error(`project ${req.params.id} not found`), { statusCode: 404 });
    return host;
  });

  // Validated in core, whole: a document is replaced, never merged
  app.put<{ Params: { id: string }; Body: unknown }>('/projects/:id/settings', (req) => core.saveProjectSettings(req.params.id, req.body));

  // A project's tracker lives in its settings document; null when it has none
  app.get<{ Params: { id: string } }>('/projects/:id/tracker', async (req): Promise<ProjectTrackerSettings | null> => (await core.projectSettings(req.params.id)).tracker ?? null);

  // Validated with the whole document, where the tracker is checked; a null body clears it. Only the
  // tracker changes: the rest is written back as it was read
  app.put<{ Params: { id: string }; Body: ProjectTrackerSettings | null }>('/projects/:id/tracker', async (req): Promise<ProjectTrackerSettings | null> => {
    const { tracker: _before, ...rest } = await core.projectSettings(req.params.id);
    const body = req.body ?? null;
    const saved = await core.saveProjectSettings(req.params.id, body === null ? rest : { ...rest, tracker: body });
    return saved.tracker ?? null;
  });

  // The tracker's own query, one page; readable with the Board module off, as the board is
  app.get<{ Params: { id: string }; Querystring: { query?: string; page?: string } }>('/projects/:id/tracker/issues', async (req): Promise<TrackerIssuesPage> => {
    await core.workItemProject(req.params.id, 'read');
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isInteger(page) || page < 1) throw new WorkItemError('page must be a whole number from 1', 400);
    return core.trackerImport.list(req.params.id, req.query.query === undefined || req.query.query === '' ? null : req.query.query, page);
  });

  app.post<{ Params: { id: string }; Body: TrackerImportRequest }>('/projects/:id/tracker/import', async (req): Promise<TrackerImportResult> => {
    await core.workItemProject(req.params.id, 'write');
    const keys = req.body?.keys;
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) throw new WorkItemError('keys must be a list of issue keys', 400);
    return core.trackerImport.importIssues(req.params.id, keys);
  });

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
