import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { SetAuthTokenRequest, UpdateAuthConfigRequest } from '@agentry/shared';

/**
 * The guard's own configuration, and the trail it leaves. The token is never returned here: it
 * exists once, in the answer to `POST /security/token`, and only its hash is kept.
 */
export const securityRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/security/auth', () => core.security.config);
  app.put<{ Body: UpdateAuthConfigRequest }>('/security/auth', (req) => core.security.update(req.body ?? {}));
  app.post<{ Body: SetAuthTokenRequest }>('/security/token', (req) => core.security.setToken(req.body ?? {}));
  app.delete('/security/token', () => core.security.clearToken());

  app.get<{ Querystring: { limit?: string; from?: string; path?: string } }>('/audit', (req) =>
    core.db.auditPage({
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.from ? { from: Number(req.query.from) } : {}),
      ...(req.query.path ? { path: req.query.path } : {}),
    }),
  );
};
