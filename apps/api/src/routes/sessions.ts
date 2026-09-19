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

  // Everything Claude Code keeps about a project: transcripts, tasks, file history, config entry.
  // The CLI owns that layout, so `claude project purge` does the deleting.
  app.delete<{ Params: { id: string } }>('/projects/:id/state', async (req) => {
    const project = (await core.projects()).find((p) => p.id === req.params.id);
    if (!project) throw new Error('project not found');
    return core.purgeProject(project.path);
  });

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
    // The list reported this session live while its own page did not: both now read the same
    // liveness, so opening a running session never shows it as idle.
    const summary = (await core.sessionsWithLive()).find((s) => s.id === detail.summary.id);
    return summary?.live ? { ...detail, summary: { ...detail.summary, live: summary.live } } : detail;
  });

  // Background agents this session spawned, from its files on disk — works whether it was started
  // from Agentry or from a terminal.
  app.get<{ Params: { id: string } }>('/sessions/:id/subagents', (req) => core.sessions.subagents(req.params.id));
};
