import type { FastifyPluginAsync } from 'fastify';
import type { Core, ChangeRequestFix } from '@agentry/core';
import type {
  AddressReviewRequest,
  ApprovalRequest,
  ApprovalState,
  AutoMergeRequestBody,
  ChangeRequest,
  ChangeRequestChecks,
  ChangeRequestReviewPosts,
  ChangeRequestReviewers,
  ChangeRequestThreads,
  CheckLog,
  ChecksRerunRequest,
  MergeReadyRequest,
  MergeRequestBody,
  MergeResult,
  MergeState,
  OrchestrationPullRequest,
  ReviewDraft,
  ReviewDraftInput,
  ReviewPost,
  ReviewReplyRequest,
  ReviewSubmitRequest,
  ReviewThread,
  ReviewersRequest,
  UpdateBranchResult,
  WorkItemPullRequest,
} from '@agentry/shared';

/**
 * A change request's checks and their fixes. `:id` is the row id of either change request table
 * (a work item's or an orchestration's), which core resolves; every refusal arrives as an error
 * with a status and a `code` (the host's reason or the fix flow's). Writes are the person's: a
 * chat's token is refused in `security.ts`. Merging above all: the merge, the arming and the update
 * of the branch are the person's click, so the caller's own identity is what the audit records.
 */
const METHODS: readonly string[] = ['squash', 'merge', 'rebase'];

function methodOf(value: unknown): MergeRequestBody['method'] {
  if (typeof value !== 'string' || !METHODS.includes(value)) throw new Error("method must be 'squash', 'merge' or 'rebase'");
  return value as MergeRequestBody['method'];
}

function headOf(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('expectedHead is required: the full id of the head the person looked at');
  return value;
}

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

  // ---------- reviews ----------

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/change-requests/:id/threads',
    (req): Promise<ChangeRequestThreads> => core.changeRequests.threads(req.params.id, req.query.refresh === '1'),
  );

  app.get<{ Params: { id: string } }>('/change-requests/:id/review-drafts', (req): Promise<ReviewDraft[]> => core.changeRequests.drafts(req.params.id));

  app.get<{ Params: { id: string } }>('/change-requests/:id/review-posts', (req): Promise<ChangeRequestReviewPosts> => core.changeRequests.reviewPosts(req.params.id));

  app.post<{ Params: { id: string }; Body: ReviewDraftInput }>(
    '/change-requests/:id/review-drafts',
    async (req, reply): Promise<ReviewDraft> => {
      const draft = await core.changeRequests.addDraft(req.params.id, req.body ?? ({} as ReviewDraftInput));
      void reply.status(201);
      return draft;
    },
  );

  app.put<{ Params: { id: string; draftId: string }; Body: ReviewDraftInput }>(
    '/change-requests/:id/review-drafts/:draftId',
    (req): Promise<ReviewDraft> => core.changeRequests.updateDraft(req.params.id, req.params.draftId, req.body ?? ({} as ReviewDraftInput)),
  );

  app.delete<{ Params: { id: string; draftId: string } }>('/change-requests/:id/review-drafts/:draftId', async (req): Promise<{ ok: true }> => {
    await core.changeRequests.deleteDraft(req.params.id, req.params.draftId);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: ReviewSubmitRequest }>('/change-requests/:id/reviews', (req): Promise<ReviewPost> => {
    const body: Partial<ReviewSubmitRequest> = req.body ?? {};
    if (body.event !== 'comment' && body.event !== 'approve' && body.event !== 'request-changes') throw new Error("event must be 'comment', 'approve' or 'request-changes'");
    if (body.body !== undefined && typeof body.body !== 'string') throw new Error('body must be text');
    if (body.headSha !== undefined && typeof body.headSha !== 'string') throw new Error('headSha must be text');
    return core.changeRequests.submit(req.params.id, { event: body.event, body: body.body ?? '', ...(body.headSha ? { headSha: body.headSha } : {}) });
  });

  app.post<{ Params: { id: string; postId: string } }>(
    '/change-requests/:id/reviews/:postId/publish-saved',
    (req): Promise<ReviewPost> => core.changeRequests.publishSaved(req.params.id, req.params.postId),
  );

  app.post<{ Params: { id: string; postId: string } }>(
    '/change-requests/:id/reviews/:postId/discard-saved',
    (req): Promise<ReviewPost> => core.changeRequests.discardSaved(req.params.id, req.params.postId),
  );

  app.post<{ Params: { id: string; threadId: string }; Body: ReviewReplyRequest }>(
    '/change-requests/:id/threads/:threadId/reply',
    (req): Promise<ReviewThread> => {
      const body: Partial<ReviewReplyRequest> = req.body ?? {};
      if (typeof body.body !== 'string' || !body.body.trim()) throw new Error('a reply needs text');
      return core.changeRequests.reply(req.params.id, req.params.threadId, body.body);
    },
  );

  app.post<{ Params: { id: string; threadId: string } }>(
    '/change-requests/:id/threads/:threadId/resolve',
    (req): Promise<ReviewThread> => core.changeRequests.resolve(req.params.id, req.params.threadId, true),
  );

  app.post<{ Params: { id: string; threadId: string } }>(
    '/change-requests/:id/threads/:threadId/unresolve',
    (req): Promise<ReviewThread> => core.changeRequests.resolve(req.params.id, req.params.threadId, false),
  );

  app.get<{ Params: { id: string } }>('/change-requests/:id/approval', (req): Promise<ApprovalState> => core.changeRequests.approval(req.params.id));

  app.post<{ Params: { id: string }; Body: ApprovalRequest }>('/change-requests/:id/approval', (req): Promise<ApprovalState> => {
    const body: Partial<ApprovalRequest> = req.body ?? {};
    if (typeof body.sha !== 'string' || !body.sha) throw new Error('sha is required: the head the approval is given on');
    return core.changeRequests.approve(req.params.id, body.sha);
  });

  app.delete<{ Params: { id: string } }>('/change-requests/:id/approval', (req): Promise<ApprovalState> => core.changeRequests.revoke(req.params.id));

  app.get<{ Params: { id: string } }>('/change-requests/:id/reviewers', (req): Promise<ChangeRequestReviewers> => core.changeRequests.reviewers(req.params.id));

  app.post<{ Params: { id: string }; Body: ReviewersRequest }>('/change-requests/:id/reviewers', (req): Promise<ChangeRequestReviewers> => {
    const body: Partial<ReviewersRequest> = req.body ?? {};
    const names = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
    if (!names(body.add)) throw new Error('add must be a list of logins');
    if (body.remove !== undefined && !names(body.remove)) throw new Error('remove must be a list of logins');
    return core.changeRequests.requestReviewers(req.params.id, { add: body.add, ...(body.remove ? { remove: body.remove } : {}) });
  });

  app.post<{ Params: { id: string }; Body: AddressReviewRequest }>('/change-requests/:id/address', (req): Promise<ChangeRequestFix> => {
    const body: Partial<AddressReviewRequest> = req.body ?? {};
    if (body.threadIds !== undefined && !(Array.isArray(body.threadIds) && body.threadIds.every((t) => typeof t === 'string'))) throw new Error('threadIds must be a list of thread ids');
    return core.changeRequests.address(req.params.id, { threadIds: body.threadIds ?? [] });
  });

  // ---------- merging ----------

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/change-requests/:id/merge',
    (req): Promise<MergeState> => core.changeRequests.mergeState(req.params.id, req.query.refresh === '1'),
  );

  app.post<{ Params: { id: string }; Body: MergeRequestBody }>('/change-requests/:id/merge', (req): Promise<MergeResult> => {
    const body: Partial<MergeRequestBody> = req.body ?? {};
    if (typeof body.deleteBranch !== 'boolean') throw new Error('deleteBranch must be true or false: the box the person saw');
    if (body.subject !== undefined && typeof body.subject !== 'string') throw new Error('subject must be text');
    if (body.body !== undefined && typeof body.body !== 'string') throw new Error('body must be text');
    return core.changeRequests.merge(
      req.params.id,
      {
        method: methodOf(body.method),
        expectedHead: headOf(body.expectedHead),
        deleteBranch: body.deleteBranch,
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
      },
      req.actor ?? 'local',
    );
  });

  app.post<{ Params: { id: string }; Body: AutoMergeRequestBody }>('/change-requests/:id/auto-merge', (req): Promise<MergeState> => {
    const body: Partial<AutoMergeRequestBody> = req.body ?? {};
    return core.changeRequests.arm(req.params.id, { method: methodOf(body.method), expectedHead: headOf(body.expectedHead) }, req.actor ?? 'local');
  });

  app.delete<{ Params: { id: string } }>('/change-requests/:id/auto-merge', (req): Promise<MergeState> => core.changeRequests.disarm(req.params.id, req.actor ?? 'local'));

  app.post<{ Params: { id: string } }>('/change-requests/:id/update-branch', (req): Promise<UpdateBranchResult> => core.changeRequests.updateBranch(req.params.id, req.actor ?? 'local'));

  app.post<{ Params: { id: string }; Body: MergeReadyRequest }>('/change-requests/:id/ready', (req): Promise<MergeState> => {
    const body: Partial<MergeReadyRequest> = req.body ?? {};
    if (typeof body.ready !== 'boolean') throw new Error('ready must be true (ready for review) or false (back to a draft)');
    return core.changeRequests.ready(req.params.id, body.ready);
  });
};
