import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/** Claude Code's per-project file memory (<configDir>/projects/<directory>/memory/*.md), addressed by project id. */
export const memoryRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/memory', () => core.memoryOverview());

  app.get<{ Params: { project: string } }>('/memory/:project', async (req) =>
    core.memoryFiles(req.params.project),
  );

  app.put<{ Params: { project: string; name: string }; Body: { content?: unknown } }>('/memory/:project/:name', async (req) =>
    core.saveMemory(req.params.project, req.params.name, req.body?.content),
  );

  app.delete<{ Params: { project: string; name: string } }>('/memory/:project/:name', async (req) => {
    await core.removeMemory(req.params.project, req.params.name);
    return { ok: true };
  });
};
