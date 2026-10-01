import type { FastifyPluginAsync } from 'fastify';
import type { Core, ChangeRequestFix } from '@agentry/core';
import type { ChangeRequest, ChangeRequestChecks, CheckLog, ChecksRerunRequest, OrchestrationPullRequest, WorkItemPullRequest } from '@agentry/shared';

/**
 * A change request's checks and their fixes. `:id` is the row id of either change request table
 * (a work item's or an orchestration's), which core resolves; every refusal arrives as an error
 * with a status and a `code` (the host's reason or the fix flow's). Writes are the person's: a
 * chat's token is refused in `security.ts`.
 */
export const changeRequestRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string } }>('/change-requests/:id', (req): Promise<ChangeRequest> => core.changeRequests.get(req.params.id));

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/change-requests/:id/checks',
    (req): Promise<ChangeRequestChecks> => core.changeRequests.checks(req.params.id, req.query.refresh === '1'),
  );

  app.get<{ Params: { id: string; checkId: string } }>(
    '/change-requests/:id/checks/:checkId/log',
    (req): Promise<CheckLog> => core.changeRequests.log(req.params.id, req.params.checkId),
  );

  app.post<{ Params: { id: string }; Body: ChecksRerunRequest }>('/change-requests/:id/checks/rerun', (req): Promise<ChangeRequestChecks> => {
    const body: Partial<ChecksRerunRequest> = req.body ?? {};
    if (body.scope !== 'failed' && body.scope !== 'check' && body.scope !== 'all') throw new Error("scope must be 'failed', 'check' or 'all'");
    if (body.scope === 'check' && (typeof body.checkId !== 'string' || !body.checkId)) throw new Error("checkId is required when scope is 'check'");
    return core.changeRequests.rerun(req.params.id, body.scope === 'check' ? { scope: 'check', checkId: body.checkId } : { scope: body.scope });
  });

  app.post<{ Params: { id: string } }>('/change-requests/:id/checks/cancel', (req): Promise<ChangeRequestChecks> => core.changeRequests.cancel(req.params.id));

  app.post<{ Params: { id: string; checkId: string } }>(
    '/change-requests/:id/checks/:checkId/run',
    (req): Promise<ChangeRequestChecks> => core.changeRequests.run(req.params.id, req.params.checkId),
  );

  app.post<{ Params: { id: string } }>('/change-requests/:id/checks/fix', (req): Promise<ChangeRequestFix> => core.changeRequests.fix(req.params.id));

  app.post<{ Params: { id: string } }>(
    '/change-requests/:id/push-fix',
    (req): Promise<WorkItemPullRequest | OrchestrationPullRequest | null> => core.changeRequests.pushFix(req.params.id),
  );
};
