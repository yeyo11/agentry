import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { LoginSession, SetupState, SignOutResult } from '@agentry/shared';

const notFound = (id: string): Error => Object.assign(new Error(`sign-in ${id} not found`), { statusCode: 404 });

/**
 * The first setup (docs/setup.md): what is done and what is not, and the sign-ins that do the rest.
 * A key travels in the body of `POST /setup/logins` only, is never answered back and never logged;
 * a device sign-in answers at once and `login.updated` follows it on the event feed. Every write is
 * refused in read-only mode and to a chat's token (`security.ts`).
 */
export const setupRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/setup', (): Promise<SetupState> => core.setupState());

  app.post('/setup/seen', (): Promise<SetupState> => core.markSetupSeen());

  app.post<{ Body: unknown }>('/setup/logins', async (req, reply): Promise<LoginSession> => {
    const session = await core.logins.start(req.body);
    void reply.status(201);
    return session;
  });

  app.get<{ Params: { id: string } }>('/setup/logins/:id', (req): LoginSession => {
    const session = core.logins.get(req.params.id);
    if (!session) throw notFound(req.params.id);
    return session;
  });

  app.delete<{ Params: { id: string } }>('/setup/logins/:id', (req): LoginSession => {
    const session = core.logins.cancel(req.params.id);
    if (!session) throw notFound(req.params.id);
    return session;
  });

  app.delete<{ Params: { tool: string }; Querystring: { host?: string } }>('/setup/credentials/:tool', (req): Promise<SignOutResult> =>
    core.logins.signOut(req.params.tool, req.query.host),
  );
};
