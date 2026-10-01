import type {
  AddressReviewRequest,
  ApprovalState,
  ChangeRequest,
  ChangeRequestChecks,
  ChangeRequestKind,
  ChangeRequestReviewPosts,
  ChangeRequestReviewers,
  ChangeRequestThreads,
  CheckLog,
  ChecksRerunRequest,
  Orchestration,
  OrchestrationPullRequest,
  ReviewDraft,
  ReviewDraftInput,
  ReviewPost,
  ReviewSubmitRequest,
  ReviewThread,
  ReviewersRequest,
  WorkItem,
  WorkItemPullRequest,
} from '@agentry/shared';
import type { Db } from './db.ts';
import type { ReviewTriage } from './decisions/review-triage.ts';
import { HostActionNotOffered } from './hosts/code-host.ts';
import { ChecksError, type ChecksService, type ChecksTarget } from './hosts/checks-service.ts';
import { ReviewInputError, ReviewsError, type ReviewsService, type ReviewsTarget } from './hosts/reviews-service.ts';
import { orchestrationPullRequestOf, type OrchestrationPullRequestRow } from './orchestration-pr-rows.ts';
import { OrchestrationPullRequestError, type OrchestrationPullRequestService } from './orchestration-pull-requests.ts';
import { PullRequestError, type PullRequestService } from './pull-requests.ts';
import { fixOf, hostOf, pullRequestOf, refOf, type PullRequestRow } from './work-item-rows.ts';

/** A refusal the API answers by its status, with the reason a client acts on. */
export class ChangeRequestError extends Error {
  /** The message of a refusal was written for the person, so it is shown even on a 5xx */
  readonly expose = true;
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 429 | 502,
    readonly reason: string | null = null,
    /** The review post a refusal left behind, so a client can settle it */
    readonly postId: string | null = null,
  ) {
    super(message);
    this.name = 'ChangeRequestError';
  }
}

/** Where each host reason lands: what the person can change is a 409, a host that did not answer a 502. */
function statusOf(reason: string): ChangeRequestError['statusCode'] {
  if (reason === 'not-found') return 404;
  if (reason === 'rate-limited' || reason === 'slowed-down') return 429;
  if (['unreachable', 'server-error', 'timeout', 'output-too-large', 'unexpected-output'].includes(reason)) return 502;
  return 409;
}

/** Translates what the services throw into one error type; anything else is a bug and passes through. */
function translated(err: unknown): unknown {
  if (err instanceof ChecksError) return new ChangeRequestError(err.detail ? `${err.message}: ${err.detail}` : err.message, statusOf(err.reason), err.reason);
  if (err instanceof ReviewsError) return new ChangeRequestError(err.detail ? `${err.message}: ${err.detail}` : err.message, statusOf(err.reason), err.reason, err.postId);
  if (err instanceof ReviewInputError) return new ChangeRequestError(err.message, 400);
  if (err instanceof HostActionNotOffered) return new ChangeRequestError(err.message, 409, 'not-offered');
  if (err instanceof PullRequestError) return new ChangeRequestError(err.message, err.statusCode === 404 ? 404 : 409, err.reason);
  if (err instanceof OrchestrationPullRequestError) return new ChangeRequestError(err.message, err.reason === 'not-found' ? 404 : 409, err.reason);
  return err;
}

async function guarded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw translated(err);
  }
}

type Found = { kind: 'work-item'; ownerId: string; row: PullRequestRow } | { kind: 'orchestration'; ownerId: string; row: OrchestrationPullRequestRow };

export interface ChangeRequestServiceDeps {
  db: Db;
  checks: ChecksService;
  reviews: ReviewsService;
  pullRequests: PullRequestService;
  orchestrationPullRequests: OrchestrationPullRequestService;
  orchestration: (id: string) => Orchestration | null;
  /** The item after the check that its project lets the caller read or write it */
  itemAccess: (itemId: string, access: 'read' | 'write') => Promise<WorkItem>;
  /** Asked who should take each unresolved thread whenever the threads are read; absent, nothing is asked */
  triage?: ReviewTriage;
}

/** What `POST …/checks/fix` answers: whether a fix started, and the prompt for a chat of the person's own when it did not. */
export interface ChangeRequestFix {
  started: boolean;
  prompt: string;
  worktree: string | null;
  pullRequest: WorkItemPullRequest | OrchestrationPullRequest | null;
}

/**
 * The neutral `/change-requests/:id/…` surface: the id is the row id of either table (UUIDs, unique
 * across both), and this resolves which service owns it. It holds no state of its own.
 */
export class ChangeRequestService {
  constructor(private readonly deps: ChangeRequestServiceDeps) {}

  private find(id: string): Found | null {
    const sql = this.deps.db.connection;
    const item = sql.prepare('SELECT * FROM work_item_pull_requests WHERE id = ?').get(id) as PullRequestRow | undefined;
    if (item) return { kind: 'work-item', ownerId: item.item_id, row: item };
    const orch = sql.prepare('SELECT * FROM orchestration_pull_requests WHERE id = ?').get(id) as OrchestrationPullRequestRow | undefined;
    return orch ? { kind: 'orchestration', ownerId: orch.orchestration_id, row: orch } : null;
  }

  private require(id: string): Found {
    const found = this.find(id);
    if (!found) throw new ChangeRequestError('change request not found', 404, 'not-found');
    return found;
  }

  /** The kind of a row id; null when no table has it. */
  kindOf(id: string): ChangeRequestKind | null {
    return this.find(id)?.kind ?? null;
  }

  /** What `ChecksService` needs to talk to the host about this row. */
  async target(id: string): Promise<ChecksTarget | null> {
    const found = this.find(id);
    if (!found) return null;
    return found.kind === 'work-item' ? this.deps.pullRequests.checksTarget(found.row) : this.deps.orchestrationPullRequests.checksTarget(found.row);
  }

  /** What `ReviewsService` needs to talk to the host about this row. */
  async reviewsTarget(id: string): Promise<ReviewsTarget | null> {
    const found = this.find(id);
    if (!found) return null;
    return found.kind === 'work-item' ? this.deps.pullRequests.reviewsTarget(found.row) : this.deps.orchestrationPullRequests.reviewsTarget(found.row);
  }

  /** The project's access check for a read or a write; an orchestration's change request has none beyond the guard. */
  private async access(found: Found, access: 'read' | 'write'): Promise<void> {
    if (found.kind === 'work-item') await this.deps.itemAccess(found.ownerId, access);
  }

  async get(id: string): Promise<ChangeRequest> {
    const found = this.require(id);
    await this.access(found, 'read');
    const view = found.kind === 'work-item' ? pullRequestOf(found.row) : orchestrationPullRequestOf(found.row);
    return {
      id,
      kind: found.kind,
      ownerId: found.ownerId,
      host: hostOf(found.row.host),
      phase: view.phase,
      number: view.number,
      ref: refOf(hostOf(found.row.host), view.number),
      url: view.url,
      branch: view.branch,
      base: view.base,
      ci: view.ci,
      error: view.error,
      openedAt: view.openedAt,
      closedAt: view.closedAt,
      checkedAt: view.checkedAt,
      ...fixOf(found.row),
    };
  }

  async checks(id: string, refresh: boolean): Promise<ChangeRequestChecks> {
    await this.access(this.require(id), 'read');
    return guarded(this.deps.checks.list(id, { refresh }));
  }

  async log(id: string, checkId: string): Promise<CheckLog> {
    await this.access(this.require(id), 'read');
    return guarded(this.deps.checks.log(id, checkId));
  }

  async rerun(id: string, req: ChecksRerunRequest): Promise<ChangeRequestChecks> {
    await this.access(this.require(id), 'write');
    return guarded(this.deps.checks.rerun(id, req));
  }

  async cancel(id: string): Promise<ChangeRequestChecks> {
    await this.access(this.require(id), 'write');
    return guarded(this.deps.checks.cancel(id));
  }

  async run(id: string, checkId: string): Promise<ChangeRequestChecks> {
    await this.access(this.require(id), 'write');
    return guarded(this.deps.checks.run(id, checkId));
  }

  /** Fixes the owner's newest change request, which is the one a client shows. */
  async fix(id: string): Promise<ChangeRequestFix> {
    const found = this.require(id);
    await this.access(found, 'write');
    if (found.kind === 'work-item') {
      const result = await guarded(this.deps.pullRequests.fixChecks(found.ownerId, 'person'));
      return { started: result.started, prompt: result.prompt, worktree: result.worktree, pullRequest: result.pullRequest };
    }
    const orch = this.deps.orchestration(found.ownerId);
    if (!orch) throw new ChangeRequestError('orchestration not found', 404, 'not-found');
    const result = await guarded(this.deps.orchestrationPullRequests.fixChecks(orch));
    return { started: true, prompt: result.prompt, worktree: orch.integration?.worktree ?? null, pullRequest: result.pullRequest };
  }

  async pushFix(id: string): Promise<WorkItemPullRequest | OrchestrationPullRequest | null> {
    const found = this.require(id);
    await this.access(found, 'write');
    if (found.kind === 'work-item') return (await guarded(this.deps.pullRequests.pushFix(found.ownerId))).pullRequest;
    const orch = this.deps.orchestration(found.ownerId);
    if (!orch) throw new ChangeRequestError('orchestration not found', 404, 'not-found');
    return guarded(this.deps.orchestrationPullRequests.pushFix(orch));
  }

  // ---------- reviews ----------

  private async reading(id: string): Promise<void> {
    await this.access(this.require(id), 'read');
  }

  private async writing(id: string): Promise<Found> {
    const found = this.require(id);
    await this.access(found, 'write');
    return found;
  }

  async threads(id: string, refresh: boolean): Promise<ChangeRequestThreads> {
    const found = this.require(id);
    const item = found.kind === 'work-item' ? await this.deps.itemAccess(found.ownerId, 'read') : null;
    const list = await guarded(this.deps.reviews.threads(id, { refresh }));
    // The Address dialog reads the answer from the decision history, so the question goes out as soon as the threads are seen
    if (this.deps.triage) {
      const title = item?.title ?? this.deps.orchestration(found.ownerId)?.name ?? '';
      this.deps.triage.onThreads(id, item?.projectId ?? null, title, list);
    }
    return list;
  }

  async drafts(id: string): Promise<ReviewDraft[]> {
    await this.reading(id);
    return guarded(Promise.resolve().then(() => this.deps.reviews.listDrafts(id)));
  }

  async reviewPosts(id: string): Promise<ChangeRequestReviewPosts> {
    await this.reading(id);
    return guarded(this.deps.reviews.reviewPosts(id));
  }

  async addDraft(id: string, input: ReviewDraftInput): Promise<ReviewDraft> {
    await this.writing(id);
    return guarded(this.deps.reviews.addDraft(id, input));
  }

  async updateDraft(id: string, draftId: string, input: ReviewDraftInput): Promise<ReviewDraft> {
    await this.writing(id);
    return guarded(this.deps.reviews.updateDraft(id, draftId, input));
  }

  async deleteDraft(id: string, draftId: string): Promise<void> {
    await this.writing(id);
    await guarded(Promise.resolve().then(() => this.deps.reviews.deleteDraft(id, draftId)));
  }

  async submit(id: string, req: ReviewSubmitRequest): Promise<ReviewPost> {
    await this.writing(id);
    return guarded(this.deps.reviews.submit(id, req));
  }

  async publishSaved(id: string, postId: string): Promise<ReviewPost> {
    await this.writing(id);
    return guarded(this.deps.reviews.publishSaved(id, postId));
  }

  async discardSaved(id: string, postId: string): Promise<ReviewPost> {
    await this.writing(id);
    return guarded(this.deps.reviews.discardSaved(id, postId));
  }

  async reply(id: string, threadId: string, body: string): Promise<ReviewThread> {
    await this.writing(id);
    return guarded(this.deps.reviews.reply(id, threadId, body));
  }

  async resolve(id: string, threadId: string, resolved: boolean): Promise<ReviewThread> {
    await this.writing(id);
    return guarded(this.deps.reviews.resolve(id, threadId, resolved));
  }

  async approval(id: string): Promise<ApprovalState> {
    await this.reading(id);
    return guarded(this.deps.reviews.approval(id));
  }

  async approve(id: string, sha: string): Promise<ApprovalState> {
    await this.writing(id);
    return guarded(this.deps.reviews.approve(id, sha));
  }

  async revoke(id: string): Promise<ApprovalState> {
    await this.writing(id);
    return guarded(this.deps.reviews.revoke(id));
  }

  async reviewers(id: string): Promise<ChangeRequestReviewers> {
    await this.reading(id);
    return guarded(this.deps.reviews.reviewers(id));
  }

  async requestReviewers(id: string, req: ReviewersRequest): Promise<ChangeRequestReviewers> {
    await this.writing(id);
    return guarded(this.deps.reviews.requestReviewers(id, req));
  }

  /** Hands the chosen threads to the fixer, on the same path as a checks fix. */
  async address(id: string, req: AddressReviewRequest): Promise<ChangeRequestFix> {
    const found = await this.writing(id);
    if (found.kind === 'work-item') {
      const result = await guarded(this.deps.pullRequests.addressReview(found.ownerId, req.threadIds, 'person'));
      return { started: result.started, prompt: result.prompt, worktree: result.worktree, pullRequest: result.pullRequest };
    }
    const orch = this.deps.orchestration(found.ownerId);
    if (!orch) throw new ChangeRequestError('orchestration not found', 404, 'not-found');
    const result = await guarded(this.deps.orchestrationPullRequests.addressReview(orch, req.threadIds));
    return { started: true, prompt: result.prompt, worktree: orch.integration?.worktree ?? null, pullRequest: result.pullRequest };
  }
}
