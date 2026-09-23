import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { SetCredentialsRequest } from '@agentry/shared';

export const systemRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // The only route reachable with no credential: it reports the last state observed and never goes
  // and measures, or a burst against it becomes a burst of `claude` processes. The authenticated
  // routes, which do measure, are what keeps that reading fresh.
  app.get('/health', () => {
    const system = core.systemKnown();
    const cli = system?.cli.installed ?? false;
    const loggedIn = system?.auth.loggedIn ?? false;
    return { ok: cli && loggedIn, cli, loggedIn };
  });

  app.get<{ Querystring: { refresh?: string } }>('/system', (req) => core.system(req.query.refresh === '1'));

  // Reading is free; the registry is only asked by the POST (and once a day by the server itself)
  app.get('/system/cli-version', () => core.cliVersionInfo());
  app.post('/system/cli-version/check', () => core.checkCliVersion());

  app.get('/overview', () => core.overview());

  // Account credentials. The token itself is never returned by any endpoint.
  app.get('/auth', async () => (await core.system(true)).auth);
  app.put<{ Body: SetCredentialsRequest }>('/auth/credentials', async (req) => (await core.setCredentials(req.body ?? {})).auth);
  app.delete('/auth/credentials', async () => (await core.clearCredentials()).auth);
  app.post('/auth/verify', () => core.verifyAuth());
};
