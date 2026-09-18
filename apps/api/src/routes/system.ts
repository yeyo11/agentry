import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { SetCredentialsRequest } from '@agentry/shared';

export const systemRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/health', async () => {
    const system = await core.system();
    return { ok: system.cli.installed && system.auth.loggedIn, cli: system.cli.installed, loggedIn: system.auth.loggedIn };
  });

  app.get<{ Querystring: { refresh?: string } }>('/system', (req) => core.system(req.query.refresh === '1'));

  app.get('/overview', () => core.overview());

  // Account credentials. The token itself is never returned by any endpoint.
  app.get('/auth', async () => (await core.system(true)).auth);
  app.put<{ Body: SetCredentialsRequest }>('/auth/credentials', async (req) => (await core.setCredentials(req.body ?? {})).auth);
  app.delete('/auth/credentials', async () => (await core.clearCredentials()).auth);
  app.post('/auth/verify', () => core.verifyAuth());

  app.get('/active', () => core.activeCliSessions());

  // Terminal output of a background session, which the CLI keeps and the transcripts do not.
  app.get<{ Params: { id: string } }>('/active/:id/logs', async (req) => ({ logs: await core.backgroundLogs(req.params.id) }));

  // Stops it through the CLI so the conversation stays resumable, instead of signalling a pid.
  app.post<{ Params: { id: string } }>('/active/:id/stop', (req) => core.stopBackgroundSession(req.params.id));
};
