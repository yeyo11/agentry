import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { AuditFilter, SetAuthTokenRequest, UpdateAuthConfigRequest } from '@agentry/shared';
import { count } from './chats.ts';

/**
 * The guard's own configuration, and the trail it leaves. The token is never returned here: it
 * exists once, in the answer to `POST /security/token`, and only its hash is kept.
 */
export const securityRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/security/auth', () => core.security.config);
  app.put<{ Body: UpdateAuthConfigRequest }>('/security/auth', (req) => core.security.update(req.body ?? {}));
  app.post<{ Body: SetAuthTokenRequest }>('/security/token', (req) => core.security.setToken(req.body ?? {}));
  app.delete('/security/token', () => core.security.clearToken());

  app.get<{ Querystring: AuditFilter & { limit?: string; from?: string } }>('/audit', (req) => {
    // Checked here: the store clamps a number but has nothing to say about `limit=soon`, which
    // would reach SQLite as NaN and come back as the engine complaining about a datatype
    const limit = count(req.query.limit, 'limit');
    const from = count(req.query.from, 'from');
    return core.db.auditPage({
      ...(limit !== undefined ? { limit } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(req.query.path ? { path: req.query.path } : {}),
      ...(req.query.method ? { method: req.query.method } : {}),
      ...(req.query.status ? { status: req.query.status } : {}),
    });
  });
};
