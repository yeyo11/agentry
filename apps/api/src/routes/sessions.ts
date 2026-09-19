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

  app.get<{ Params: { id: string }; Querystring: { sidechains?: string; limit?: string; before?: string } }>('/sessions/:id', async (req) => {
    const detail = await core.sessions.getSession(req.params.id, {
      includeSidechains: req.query.sidechains === '1',
      ...(req.query.limit !== undefined ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.before !== undefined ? { before: Number(req.query.before) } : {}),
    });
    if (!detail) throw new Error('session not found');
    // The list reported this session live while its own page did not: both now read the same
    // liveness, so opening a running session never shows it as idle.
    const summary = (await core.sessionsWithLive()).find((s) => s.id === detail.summary.id);
    return summary?.live ? { ...detail, summary: { ...detail.summary, live: summary.live } } : detail;
  });

  // Background agents this session spawned, from its files on disk — works whether it was started
  // from Agentry or from a terminal.
  app.get<{ Params: { id: string } }>('/sessions/:id/subagents', async (req) =>
    core.sessions.subagents(req.params.id, await core.isSessionLive(req.params.id)),
  );

  // Shell commands the session sent to the background, and what each one printed.
  app.get<{ Params: { id: string } }>('/sessions/:id/tasks', async (req) =>
    core.sessions.backgroundTasks(req.params.id, await core.isSessionLive(req.params.id)),
  );

  app.get<{ Params: { id: string; taskId: string }; Querystring: { offset?: string } }>('/sessions/:id/tasks/:taskId/output', (req) =>
    core.sessions.taskOutput(req.params.id, req.params.taskId, { offset: count(req.query.offset, 'offset') }),
  );

  // A subagent's whole conversation, from the transcript the CLI keeps for it beside the session's.
  app.get<{ Params: { id: string; agentId: string }; Querystring: { after?: string } }>('/sessions/:id/subagents/:agentId', async (req) => {
    const detail = await core.sessions.agentTranscript(req.params.id, req.params.agentId, {
      after: count(req.query.after, 'after'),
      live: await core.isSessionLive(req.params.id),
    });
    if (!detail) throw new Error('subagent not found');
    return detail;
  });

  // The same for an agent a workflow launched, which the CLI files under the workflow's run id.
  app.get<{ Params: { id: string; runId: string; agentId: string }; Querystring: { after?: string } }>(
    '/sessions/:id/workflows/:runId/agents/:agentId',
    async (req) => {
      const detail = await core.sessions.agentTranscript(req.params.id, req.params.agentId, {
        runId: req.params.runId,
        after: count(req.query.after, 'after'),
        live: await core.isSessionLive(req.params.id),
      });
      if (!detail) throw new Error('workflow agent not found');
      return detail;
    },
  );
};

/** An optional non-negative integer query parameter. */
function count(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}
