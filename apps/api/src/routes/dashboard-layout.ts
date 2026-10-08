import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/**
 * The layout of each Home: `?project=<id>` for a project's, `?project=all` for All projects. The
 * writes change the person's settings, so a chat's token gets 403 in `security.ts`.
 */
export const dashboardLayoutRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const projectOf = (query: { project?: string }): string => {
    if (typeof query.project !== 'string' || query.project === '') throw new Error('project must be a project id or all');
    return query.project;
  };

  app.get<{ Querystring: { project?: string } }>('/dashboard/layout', (req) => core.dashboardLayouts.get(projectOf(req.query)));

  app.put<{ Querystring: { project?: string }; Body: unknown }>('/dashboard/layout', (req) => core.dashboardLayouts.set(projectOf(req.query), req.body));

  app.delete<{ Querystring: { project?: string } }>('/dashboard/layout', (req) => core.dashboardLayouts.reset(projectOf(req.query)));
};
