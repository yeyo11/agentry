import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ApprovalState,
  ChangeRequestKind,
  ChangeRequestReviewers,
  ChangeRequestThreads,
  HostReason,
  ReviewComment,
  ReviewDraft,
  ReviewDraftInput,
  ReviewPost,
  ReviewSide,
  ReviewSubmitRequest,
  ReviewThread,
  ReviewersRequest,
} from '@agentry/shared';
import type { AgentryEventInput } from '../events.ts';
import { reviewDraftOf, reviewPostOf, type ReviewDraftRow, type ReviewPostRow } from '../work-item-rows.ts';
import { hostErrorFields, reasonOf } from './classify.ts';
import {
  HostActionNotOffered,
  HostParseError,
  type DiffRefs,
  type HostCall,
  type HostRepo,
  type ReviewNote,
  type ReviewOperation,
  type ReviewsCodeHostAdapter,
  type ThreadsRead,
} from './code-host.ts';
import type { HostResult } from './exec.ts';
import { firstLine } from './redact.ts';

// What a change request's review needs beyond the adapters: the threads cached by head, the person's
// draft review as rows, one review posted with a marker and recovered after a timeout, replies,
// resolves, approvals and reviewers, each followed by a re-read. The adapters only build calls and
// parse what came back; this runs them (docs/plans/code-hosts.md, phase 3).

/** How long a thread list is served from the cache */
export const THREADS_TTL = 30_000;
/** What a read that hit the rate limit waits when the host did not say */
const LIMIT_FALLBACK = 60_000;
/** The most notes one draft review holds, so one post stays one request */
export const MAX_DRAFTS = 200;
/** A bound on the follow-up reads of a long thread; the plan's list ceilings hold the rest */
const MAX_FOLLOW_PAGES = 20;

/** Why the service did not do what was asked: the reason a client words, and the first line the host said */
export class ReviewsError extends Error {
  constructor(
    message: string,
    readonly reason: HostReason,
    readonly detail: string | null = null,
    /** The post an attempt was recorded as, when one was */
    readonly postId: string | null = null,
  ) {
    super(message);
    this.name = 'ReviewsError';
  }
}

/** A request the person's own input makes impossible: a bad line, an empty note, a draft that is not there. */
export class ReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewInputError';
  }
}

/**
 * Everything a call needs about one change request, resolved by the caller from the row. `diff` is
 * the unified diff `<base>...<head>` the person reviews, used only to place a GitLab note on a
 * context line; the host stays the judge of whether a line is in its diff.
 */
export interface ReviewsTarget {
  id: string;
  kind: ChangeRequestKind;
  adapter: ReviewsCodeHostAdapter;
  repo: HostRepo;
  number: number;
  run: (call: HostCall) => Promise<HostResult>;
  diff?: () => Promise<string | null>;
}

export interface ReviewsServiceDeps {
  db: DatabaseSync;
  /** The target of a row id from either table; null when no change request has it or it has no number */
  resolve: (id: string) => Promise<ReviewsTarget | null>;
  emit?: (event: AgentryEventInput) => void;
  now?: () => number;
  /** For tests: the marker's uuid */
  uuid?: () => string;
}

interface Cached {
  threads: ChangeRequestThreads;
  fetchedAt: number;
}

const isLimited = (reason: HostReason): boolean => reason === 'rate-limited' || reason === 'slowed-down';
const failed = (result: HostResult): boolean => result.exitCode !== 0 || Boolean(result.reason);

const MARKER = /\n*<!-- agentry:[0-9a-f-]+ -->/g;
const markerOf = (uuid: string): string => `<!-- agentry:${uuid} -->`;
/** The marker is for recovery: nobody reads it, and an agent should not see it */
const clean = (body: string): string => body.replace(MARKER, '');

const stripMarkers = (threads: ReviewThread[]): ReviewThread[] =>
  threads.map((t) => ({ ...t, comments: t.comments.map((c): ReviewComment => ({ ...c, body: clean(c.body) })) }));

// ---------- the diff, for placing a note ----------

interface FileLines {
  oldPath: string | null;
  /** new-side line → the old-side line of a context line, or null for an added one */
  right: Map<number, number | null>;
  left: Set<number>;
}

/** The lines each file's hunks show on either side, from unified diff text */
export function diffLines(diff: string): Map<string, FileLines> {
  const files = new Map<string, FileLines>();
  let file: FileLines | null = null;
  let oldPath: string | null = null;
  let oldAt = 0;
  let newAt = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      file = null;
      oldPath = null;
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) {
      oldPath = line.startsWith('--- a/') ? line.slice(6).split('\t')[0] ?? null : null;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const path = line.startsWith('+++ b/') ? (line.slice(6).split('\t')[0] ?? null) : oldPath;
      if (path) {
        file = { oldPath: oldPath && oldPath !== path ? oldPath : null, right: new Map(), left: new Set() };
        files.set(path, file);
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldAt = Number(hunk[1]);
      newAt = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!file || !inHunk) continue;
    if (line.startsWith('+')) {
      file.right.set(newAt, null);
      newAt += 1;
    } else if (line.startsWith('-')) {
      file.left.add(oldAt);
      oldAt += 1;
    } else if (line.startsWith(' ')) {
      file.right.set(newAt, oldAt);
      file.left.add(oldAt);
      oldAt += 1;
      newAt += 1;
    }
  }
  return files;
}

export class ReviewsService {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly cache = new Map<string, Cached>();
  private readonly decisions = new Map<string, ChangeRequestReviewers['decision']>();
  private readonly reading = new Map<string, Promise<ChangeRequestThreads>>();
  private readonly writing = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ReviewsServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? randomUUID;
  }

  private async target(id: string): Promise<ReviewsTarget> {
    const target = await this.deps.resolve(id);
    if (!target) throw new ReviewsError('no change request with that id, or it has no number yet', 'not-found');
    return target;
  }

  /** What a failed call says: the adapter's reading of its own stdout, then the generic one, and the host's first line beside it */
  private failure(what: string, op: ReviewOperation, target: ReviewsTarget, call: HostCall, result: HostResult): ReviewsError {
    const reason = target.adapter.reasonOf(op, result) ?? reasonOf(result, call.cli) ?? 'unreachable';
    return new ReviewsError(`${what} failed`, reason, result.stderrFirstLine || null);
  }

  private async runRead(target: ReviewsTarget, call: HostCall, what: string, op: ReviewOperation = 'submit'): Promise<HostResult> {
    const result = await target.run(call);
    if (failed(result)) throw this.failure(what, op, target, call, result);
    return result;
  }

  /** Writes to one change request go one after the other, so a double click never posts twice */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.writing.get(id) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    const tracked: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.writing.get(id) === tracked) this.writing.delete(id);
    });
    this.writing.set(id, tracked);
    return run;
  }

  // ---------- the head, and the threads ----------

  private async readHead(target: ReviewsTarget): Promise<{ headSha: string | null; diffRefs: DiffRefs | null }> {
    const result = await this.runRead(target, target.adapter.readChangeRequest(target.repo, target.number), 'reading the change request', 'reply');
    try {
      const read = target.adapter.parseChangeRequest(result);
      return { headSha: read.headSha, diffRefs: read.diffRefs ?? null };
    } catch (error) {
      if (error instanceof HostParseError) throw new ReviewsError('the host did not return the change request', error.message.includes('NOT_FOUND') ? 'not-found' : 'unexpected-output', firstLine(error.message));
      throw error;
    }
  }

  /** The raw read: every page, then the rest of every long thread. Bodies still hold their markers. */
  private async fetchThreads(target: ReviewsTarget): Promise<ThreadsRead> {
    // GitLab places "outdated" by comparing with the head, which its discussions do not print
    const head = target.adapter.id === 'gitlab' ? (await this.readHead(target)).headSha : null;
    const result = await this.runRead(target, target.adapter.threads(target.repo, target.number), 'reading the threads', 'reply');
    let read: ThreadsRead;
    try {
      read = target.adapter.parseThreads(result, { headSha: head });
    } catch (error) {
      if (error instanceof HostParseError) throw new ReviewsError('the host did not return the threads', error.message.includes('NOT_FOUND') ? 'not-found' : 'unexpected-output', firstLine(error.message));
      throw error;
    }
    for (const follow of read.followUps) {
      const thread = read.threads.find((t) => t.id === follow.threadId);
      if (!thread) continue;
      let after: string | null = follow.after;
      for (let page = 0; after !== null && page < MAX_FOLLOW_PAGES; page += 1) {
        const call = target.adapter.threadComments(target.repo, { threadId: follow.threadId, after });
        if (!call) break;
        const more = target.adapter.parseThreadComments(await this.runRead(target, call, 'reading a long thread', 'reply'));
        thread.comments.push(...more.comments);
        after = more.after;
      }
      thread.commentsTruncated = after !== null;
    }
    return read;
  }

  private store(id: string, read: ThreadsRead): ChangeRequestThreads {
    const threads: ChangeRequestThreads = {
      headSha: read.headSha,
      threads: stripMarkers(read.threads),
      truncated: read.truncated,
      checkedAt: new Date(this.now()).toISOString(),
    };
    this.cache.set(id, { threads, fetchedAt: this.now() });
    return threads;
  }

  /**
   * The threads of the head commit, from the cache while it is under 30 s old and the head is the
   * one it was read for. `refresh` reads again; a read that hit the rate limit serves the last list.
   */
  async threads(id: string, options: { refresh?: boolean } = {}): Promise<ChangeRequestThreads> {
    const cached = this.cache.get(id);
    if (!options.refresh && cached && this.now() - cached.fetchedAt < THREADS_TTL) return cached.threads;
    const running = this.reading.get(id);
    if (running) return running;
    const read = this.load(id).finally(() => this.reading.delete(id));
    this.reading.set(id, read);
    return read;
  }

  private async load(id: string): Promise<ChangeRequestThreads> {
    const target = await this.target(id);
    const before = this.cache.get(id)?.threads ?? null;
    try {
      const next = this.store(id, await this.fetchThreads(target));
      this.announce(id, next, before);
      return next;
    } catch (error) {
      if (error instanceof ReviewsError && isLimited(error.reason) && before) return before;
      throw error;
    }
  }

  private unresolved = (threads: ChangeRequestThreads): number => threads.threads.filter((t) => !t.isResolved && !t.isOutdated).length;

  private announce(id: string, now: ChangeRequestThreads, before: ChangeRequestThreads | null, force = false): void {
    const count = this.unresolved(now);
    if (!force && before && this.unresolved(before) === count && before.headSha === now.headSha) return;
    this.deps.emit?.({ type: 'change-request.review', title: `${String(count)} unresolved`, changeRequestId: id, unresolvedThreads: count, decision: this.decisions.get(id) ?? null });
  }

  /** After a write: the cache is stale, and what the host now says is what the client sees */
  private async reread(id: string): Promise<ChangeRequestThreads> {
    const before = this.cache.get(id)?.threads ?? null;
    this.cache.delete(id);
    const fresh = await this.threads(id, { refresh: true });
    this.announce(id, fresh, before, true);
    return fresh;
  }

  private async threadOf(id: string, threadId: string, fresh = false): Promise<ReviewThread> {
    const threads = await this.threads(id, fresh ? { refresh: true } : {});
    const thread = threads.threads.find((t) => t.id === threadId);
    if (!thread) throw new ReviewsError('that thread is not in the list', 'not-found');
    return thread;
  }

  // ---------- drafts ----------

  private rows(id: string): ReviewDraftRow[] {
    return this.deps.db.prepare('SELECT * FROM review_drafts WHERE cr_id = ? ORDER BY created_at, rowid').all(id) as unknown as ReviewDraftRow[];
  }

  private async exists(id: string): Promise<void> {
    await this.target(id);
  }

  listDrafts(id: string): ReviewDraft[] {
    return this.rows(id).map(reviewDraftOf);
  }

  private checked(input: ReviewDraftInput): { path: string | null; side: ReviewSide | null; line: number | null; startLine: number | null; body: string; suggestion: boolean } {
    const body = typeof input.body === 'string' ? input.body : '';
    const suggestion = input.suggestion === true;
    if (body.trim() === '' && !suggestion) throw new ReviewInputError('a note needs text');
    const path = typeof input.path === 'string' && input.path !== '' ? input.path : null;
    if (path === null) {
      if (suggestion) throw new ReviewInputError('a suggestion belongs on a line');
      return { path: null, side: null, line: null, startLine: null, body, suggestion: false };
    }
    const line = input.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) throw new ReviewInputError('a note on a file needs a line');
    const startLine = input.startLine ?? null;
    if (startLine !== null && (!Number.isInteger(startLine) || startLine < 1 || startLine > line)) throw new ReviewInputError('the first line of a range cannot come after its last');
    const side: ReviewSide = input.side === 'left' ? 'left' : 'right';
    if (suggestion && side === 'left') throw new ReviewInputError('a suggestion replaces lines of the new file');
    return { path, side, line, startLine: startLine === line ? null : startLine, body, suggestion };
  }

  async addDraft(id: string, input: ReviewDraftInput): Promise<ReviewDraft> {
    await this.exists(id);
    const draft = this.checked(input);
    if (this.rows(id).length >= MAX_DRAFTS) throw new ReviewInputError(`a review holds at most ${String(MAX_DRAFTS)} notes`);
    const at = new Date(this.now()).toISOString();
    const row: ReviewDraftRow = { id: randomUUID(), cr_id: id, path: draft.path, side: draft.side, line: draft.line, start_line: draft.startLine, body: draft.body, suggestion: draft.suggestion ? 1 : 0, created_at: at, updated_at: at };
    this.deps.db
      .prepare('INSERT INTO review_drafts (id, cr_id, path, side, line, start_line, body, suggestion, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.cr_id, row.path, row.side, row.line, row.start_line, row.body, row.suggestion, row.created_at, row.updated_at);
    return reviewDraftOf(row);
  }

  async updateDraft(id: string, draftId: string, input: ReviewDraftInput): Promise<ReviewDraft> {
    const current = this.rows(id).find((r) => r.id === draftId);
    if (!current) throw new ReviewsError('that draft is not in the review', 'not-found');
    const draft = this.checked(input);
    const at = new Date(this.now()).toISOString();
    this.deps.db
      .prepare('UPDATE review_drafts SET path = ?, side = ?, line = ?, start_line = ?, body = ?, suggestion = ?, updated_at = ? WHERE id = ? AND cr_id = ?')
      .run(draft.path, draft.side, draft.line, draft.startLine, draft.body, draft.suggestion ? 1 : 0, at, draftId, id);
    return reviewDraftOf({ ...current, path: draft.path, side: draft.side, line: draft.line, start_line: draft.startLine, body: draft.body, suggestion: draft.suggestion ? 1 : 0, updated_at: at });
  }

  deleteDraft(id: string, draftId: string): void {
    const gone = this.deps.db.prepare('DELETE FROM review_drafts WHERE id = ? AND cr_id = ?').run(draftId, id);
    if (gone.changes === 0) throw new ReviewsError('that draft is not in the review', 'not-found');
  }

  // ---------- posts ----------

  private postRow(id: string, postId: string): ReviewPostRow | undefined {
    return this.deps.db.prepare('SELECT * FROM review_posts WHERE id = ? AND cr_id = ?').get(postId, id) as ReviewPostRow | undefined;
  }

  posts(id: string): ReviewPost[] {
    return (this.deps.db.prepare('SELECT * FROM review_posts WHERE cr_id = ? ORDER BY created_at DESC, rowid DESC').all(id) as unknown as ReviewPostRow[]).map(reviewPostOf);
  }

  private setPost(postId: string, state: ReviewPost['state'], extra: { remoteId?: string | null; detail?: ReviewPost['detail'] } = {}): ReviewPost {
    this.deps.db
      .prepare('UPDATE review_posts SET state = ?, remote_id = COALESCE(?, remote_id), detail = ?, updated_at = ? WHERE id = ?')
      .run(state, extra.remoteId ?? null, extra.detail ? JSON.stringify(extra.detail) : null, new Date(this.now()).toISOString(), postId);
    return reviewPostOf(this.deps.db.prepare('SELECT * FROM review_posts WHERE id = ?').get(postId) as unknown as ReviewPostRow);
  }

  private dropDrafts(ids: string[]): void {
    const remove = this.deps.db.prepare('DELETE FROM review_drafts WHERE id = ?');
    this.deps.db.exec('BEGIN');
    try {
      for (const draftId of ids) remove.run(draftId);
      this.deps.db.exec('COMMIT');
    } catch (error) {
      this.deps.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The draft notes (GitLab) or reviews (GitHub) that are in the way of a post */
  private async pendingIn(target: ReviewsTarget): Promise<{ id: string; pending: boolean; body: string }[]> {
    const result = await this.runRead(target, target.adapter.pendingReviews(target.repo, target.number), 'reading the pending reviews', 'draft');
    try {
      return target.adapter.parsePendingReviews(result);
    } catch (error) {
      if (error instanceof HostParseError) throw new ReviewsError('the host did not return its reviews', 'unexpected-output', firstLine(error.message));
      throw error;
    }
  }

  /**
   * Whether a post's marker reached the host, after a write that timed out or ended unclear. A
   * review (GitHub) carries it in its body; GitLab's body draft becomes a discussion's first note.
   */
  private async landed(target: ReviewsTarget, marker: string): Promise<{ found: boolean; remoteId: string | null }> {
    try {
      if (target.adapter.id === 'github') {
        const found = (await this.pendingIn(target)).find((r) => r.body.includes(marker));
        return { found: Boolean(found), remoteId: found?.id ?? null };
      }
      const read = await this.fetchThreads(target);
      return { found: read.threads.some((t) => t.comments.some((c) => c.body.includes(marker))), remoteId: null };
    } catch {
      // A recovery that cannot read looks like a post that is unconfirmed, which is what it is
      return { found: false, remoteId: null };
    }
  }

  private notesOf(drafts: ReviewDraft[], files: Map<string, FileLines> | null): { notes: ReviewNote[]; general: string[] } {
    const notes: ReviewNote[] = [];
    const general: string[] = [];
    for (const draft of drafts) {
      if (draft.path === null || draft.line === null) {
        general.push(draft.body);
        continue;
      }
      const side = draft.side ?? 'right';
      const file = files?.get(draft.path) ?? null;
      const oldLine = side === 'right' ? (file?.right.get(draft.line) ?? null) : null;
      notes.push({
        path: draft.path,
        ...(file?.oldPath ? { oldPath: file.oldPath } : {}),
        side,
        line: draft.line,
        startLine: draft.startLine,
        ...(oldLine !== null ? { oldLine } : {}),
        suggestion: draft.suggestion,
        body: draft.body,
      });
    }
    return { notes, general };
  }

  /**
   * `POST …/reviews`: the drafts as one review. GitHub is one request. GitLab saves a draft note per
   * call and publishes; a note it cannot place is refused before anything is published, and what
   * reached the host is counted after. `approve` (GitLab) posts what there is, then approves.
   */
  submit(id: string, req: ReviewSubmitRequest): Promise<ReviewPost> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      if (req.event === 'request-changes') throw new HostActionNotOffered('Agentry does not request changes; the host does');
      // The call is built only to learn whether the host has one
      if (req.event === 'approve' && !target.adapter.approve(target.repo, target.number, '0000000')) throw new HostActionNotOffered('Agentry does not approve on this host');
      const rows = this.rows(id);
      const drafts = rows.map(reviewDraftOf);
      const text = typeof req.body === 'string' ? req.body.trim() : '';
      const content = text !== '' || drafts.length > 0;
      if (!content && req.event === 'comment') throw new ReviewInputError('a review needs text or a note');
      const marker = markerOf(this.uuid());
      const postId = randomUUID();
      const at = new Date(this.now()).toISOString();
      this.deps.db.prepare('INSERT INTO review_posts (id, cr_id, marker, event, state, remote_id, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)').run(postId, id, marker, req.event, 'posting', at, at);
      const fail = (error: ReviewsError, code: HostReason = error.reason, extra: { saved?: number; total?: number } = {}): never => {
        const state = code === 'review-partly-posted' ? 'partly' : 'failed';
        this.setPost(postId, state, { detail: { code, detail: error.detail ?? '', ...extra } });
        throw new ReviewsError(error.message, error.reason, error.detail, postId);
      };
      try {
        let post = this.setPost(postId, 'posting');
        // The read that counted a GitLab publish is also the fresh list
        let settled = false;
        let headSha: string | null = null;
        if (content) {
          // The head and refs come first: GitLab pins every note to them, and GitHub to the commit
          const head = await this.readHead(target);
          headSha = head.headSha;
          if (!headSha) throw new ReviewsError('the host did not say which commit the change request is at', 'unexpected-output');
          const diff = target.adapter.id === 'gitlab' && target.diff ? await target.diff().catch(() => null) : null;
          const { notes, general } = this.notesOf(drafts, diff ? diffLines(diff) : null);
          const body = [text, ...general, marker].filter((part) => part !== '').join('\n\n');
          const pending = await this.pendingIn(target);
          // GitLab publishes every draft note there is: one that is not ours would go out with the review
          if (pending.some((p) => p.pending)) fail(new ReviewsError('a review is already waiting to be published', 'pending-review-exists', `${String(pending.filter((p) => p.pending).length)} pending`));
          const before = target.adapter.id === 'gitlab' ? new Set((await this.fetchThreads(target)).threads.map((t) => t.id)) : null;
          let plan;
          try {
            plan = target.adapter.submit(target.repo, target.number, { headSha, body, notes, diffRefs: head.diffRefs }, 'comment');
          } catch (error) {
            if (error instanceof HostParseError) throw new ReviewInputError(error.message);
            throw error;
          }
          const created: string[] = [];
          for (const call of plan.calls) {
            const result = await target.run(call);
            if (failed(result)) {
              const error = this.failure('posting the review', 'submit', target, call, result);
              if (target.adapter.id === 'github') {
                const found = error.reason === 'timeout' || error.reason === 'unreachable' ? await this.landed(target, marker) : { found: false, remoteId: null };
                if (found.found) {
                  post = this.setPost(postId, 'posted', { remoteId: found.remoteId });
                  break;
                }
                if (error.reason === 'timeout') fail(new ReviewsError('the host did not confirm the review', 'write-unconfirmed', error.detail));
                fail(error);
              }
              if (created.length === 0) fail(error.reason === 'timeout' ? new ReviewsError('the host did not confirm the review', 'write-unconfirmed', error.detail) : error);
              fail(new ReviewsError('a note was refused after others were saved', 'review-partly-posted', error.detail), 'review-partly-posted', { saved: created.length, total: plan.calls.length });
            }
            if (target.adapter.id === 'gitlab') {
              const draft = target.adapter.parseDraftNote(result);
              if (draft && !draft.placed) {
                // Published, it would vanish without an error (recorded): take back what was saved and say which note it was
                created.push(draft.id);
                for (const saved of created) {
                  const discard = target.adapter.discardDraft(target.repo, target.number, saved);
                  if (discard) await target.run(discard);
                }
                const note = notes[plan.calls.indexOf(call) - 1];
                fail(new ReviewsError('a note is on a line that is not in the diff', 'line-not-in-diff', note ? `${note.path}:${String(note.line)}` : null));
              }
              if (draft) created.push(draft.id);
            } else {
              post = this.setPost(postId, 'posted', { remoteId: target.adapter.parseSubmitted(result).remoteId });
            }
          }
          if (plan.publish) {
            const result = await target.run(plan.publish);
            if (failed(result)) {
              const error = this.failure('publishing the review', 'submit', target, plan.publish, result);
              const found = await this.landed(target, marker);
              if (!found.found) fail(new ReviewsError('the saved notes were not published', 'review-partly-posted', error.detail), 'review-partly-posted', { saved: created.length, total: plan.calls.length });
            }
            // A published note that is not there is a note the host dropped
            const after = await this.fetchThreads(target);
            const made = after.threads.filter((t) => !before?.has(t.id)).length;
            if (made < plan.calls.length) fail(new ReviewsError('the host published fewer notes than were saved', 'review-partly-posted', `${String(made)} of ${String(plan.calls.length)}`), 'review-partly-posted', { saved: made, total: plan.calls.length });
            this.announce(id, this.store(id, after), null, true);
            settled = true;
            post = this.setPost(postId, 'posted');
          }
          this.dropDrafts(rows.map((r) => r.id));
        }
        if (req.event === 'approve') {
          // The post stands; an approval that fails is its own failure
          const sha = headSha ?? (await this.readHead(target)).headSha;
          if (!sha) throw new ReviewsError('the host did not say which commit the change request is at', 'unexpected-output', null, postId);
          if (!content) post = this.setPost(postId, 'posting');
          await this.approveNow(id, target, sha).catch((error: unknown) => {
            if (error instanceof ReviewsError) {
              this.setPost(postId, content ? 'posted' : 'failed', content ? {} : { detail: { code: error.reason, detail: error.detail ?? '' } });
              throw new ReviewsError(error.message, error.reason, error.detail, postId);
            }
            throw error;
          });
          post = this.setPost(postId, 'posted');
        }
        if (!settled) await this.reread(id).catch(() => undefined);
        return post;
      } catch (error) {
        const row = this.postRow(id, postId);
        // Anything that escaped with the post still `posting` ends it, so no attempt is left looking live
        if (row?.state === 'posting') {
          const reason = error instanceof ReviewsError ? error.reason : 'unreachable';
          this.setPost(postId, 'failed', { detail: { code: reason, detail: error instanceof Error ? firstLine(error.message) : '' } });
        }
        if (error instanceof ReviewsError && error.postId === null) throw new ReviewsError(error.message, error.reason, error.detail, postId);
        throw error;
      }
    });
  }

  /** GitLab: publish what a partly posted review saved. The drafts of the person are done with once it is out. */
  publishSaved(id: string, postId: string): Promise<ReviewPost> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      const row = this.postRow(id, postId);
      if (!row) throw new ReviewsError('that review is not recorded', 'not-found');
      const call = target.adapter.publishSaved(target.repo, target.number);
      if (row.state !== 'partly' || !call) throw new HostActionNotOffered('there is nothing saved to publish');
      const result = await target.run(call);
      if (failed(result) && !(await this.landed(target, row.marker)).found) throw this.failure('publishing the saved notes', 'submit', target, call, result);
      this.dropDrafts(this.rows(id).map((r) => r.id));
      const post = this.setPost(postId, 'posted');
      await this.reread(id).catch(() => undefined);
      return post;
    });
  }

  /** GitLab: delete what a partly posted review saved; the person's drafts stay to be posted again. */
  discardSaved(id: string, postId: string): Promise<ReviewPost> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      const row = this.postRow(id, postId);
      if (!row) throw new ReviewsError('that review is not recorded', 'not-found');
      if (row.state !== 'partly' || !target.adapter.discardDraft(target.repo, target.number, '0')) throw new HostActionNotOffered('there is nothing saved to discard');
      // A post is refused while any draft note is pending, so everything pending is what this post saved
      for (const entry of await this.pendingIn(target)) {
        const call = target.adapter.discardDraft(target.repo, target.number, entry.id);
        if (!call) continue;
        const result = await target.run(call);
        if (failed(result)) throw this.failure('discarding a saved note', 'submit', target, call, result);
      }
      return this.setPost(postId, 'failed', { detail: { code: 'review-partly-posted', detail: 'discarded' } });
    });
  }

  // ---------- replies and resolves ----------

  /** `POST …/threads/:threadId/reply`. The reply carries a marker, so a timeout is settled by looking for it. */
  reply(id: string, threadId: string, body: string): Promise<ReviewThread> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      if (typeof body !== 'string' || body.trim() === '') throw new ReviewInputError('a reply needs text');
      const thread = await this.threadOf(id, threadId, true);
      if (!thread.viewerCanReply) throw new ReviewsError('the host does not let you reply there', 'forbidden');
      const marker = markerOf(this.uuid());
      let call: HostCall;
      try {
        call = target.adapter.reply(target.repo, target.number, { id: thread.id, comments: thread.comments }, `${body.trim()}\n\n${marker}`);
      } catch (error) {
        if (error instanceof HostParseError) throw new ReviewInputError(error.message);
        throw error;
      }
      const result = await target.run(call);
      if (failed(result)) {
        const error = this.failure('replying', 'reply', target, call, result);
        // A 422 on GitHub is the person's own pending review, which a reply cannot be added beside (matrix D4)
        const pending = target.adapter.id === 'github' && error.reason === 'unreachable' && hostErrorFields(result).status === 422;
        const raw = await this.fetchThreads(target).catch(() => null);
        const landed = raw?.threads.find((t) => t.id === threadId)?.comments.some((c) => c.body.includes(marker)) === true;
        if (!landed) {
          if (pending) throw new ReviewsError('a review of yours is waiting to be published', 'pending-review-exists', error.detail);
          throw error.reason === 'timeout' ? new ReviewsError('the host did not confirm the reply', 'write-unconfirmed', error.detail) : error;
        }
      }
      await this.reread(id);
      return this.threadOf(id, threadId);
    });
  }

  /** `POST …/resolve` and `…/unresolve`: idempotent, and decided by what the re-read says */
  resolve(id: string, threadId: string, resolved: boolean): Promise<ReviewThread> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      const thread = await this.threadOf(id, threadId, true);
      if (thread.isResolved === resolved) return thread;
      if (!thread.viewerCanResolve) throw new ReviewsError('the host does not let you do that on this thread', 'not-resolvable');
      let call: HostCall;
      try {
        call = target.adapter.resolve(target.repo, target.number, threadId, resolved);
      } catch (error) {
        if (error instanceof HostParseError) throw new ReviewInputError(error.message);
        throw error;
      }
      const result = await target.run(call);
      const fresh = await this.reread(id).then(
        (list) => list.threads.find((t) => t.id === threadId) ?? null,
        (error: unknown) => {
          if (!failed(result)) throw error;
          return null;
        },
      );
      if (!failed(result)) {
        if (!fresh) throw new ReviewsError('that thread is no longer in the list', 'not-found');
        return fresh;
      }
      // "Already resolved" is exit 0 on one host and 1 on the other: the state decides
      if (fresh?.isResolved === resolved) return fresh;
      const error = this.failure(resolved ? 'resolving' : 'reopening', 'resolve', target, call, result);
      if (fresh && !fresh.viewerCanResolve) throw new ReviewsError(error.message, 'not-resolvable', error.detail);
      throw error.reason === 'timeout' ? new ReviewsError(error.message, 'write-unconfirmed', error.detail) : error;
    });
  }

  // ---------- approval ----------

  /** The viewer's approval and the rule's count; GitHub has none to read, so it answers that Agentry does not approve */
  async approval(id: string): Promise<ApprovalState> {
    const target = await this.target(id);
    const headSha = (await this.readHead(target)).headSha;
    return this.readApproval(target, headSha);
  }

  private async readApproval(target: ReviewsTarget, headSha: string | null): Promise<ApprovalState> {
    const call = target.adapter.approvals(target.repo, target.number);
    if (!call) return target.adapter.parseApprovals({ exitCode: 0, stdout: '', stderrFirstLine: '', http: null, truncated: false, durationMs: 0 }, headSha);
    const result = await this.runRead(target, call, 'reading the approvals', 'approve');
    try {
      return target.adapter.parseApprovals(result, headSha);
    } catch (error) {
      if (error instanceof HostParseError) throw new ReviewsError('the host did not return the approvals', 'unexpected-output', firstLine(error.message));
      throw error;
    }
  }

  private async approveNow(id: string, target: ReviewsTarget, sha: string): Promise<ApprovalState> {
    const head = (await this.readHead(target)).headSha;
    if (head !== null && head !== sha) throw new ReviewsError('the change request has a newer commit than the one you looked at', 'head-moved');
    const call = target.adapter.approve(target.repo, target.number, sha);
    if (!call) throw new HostActionNotOffered('Agentry does not approve on this host');
    const result = await target.run(call);
    const state = await this.readApproval(target, head).catch((error: unknown) => {
      if (!failed(result)) throw error;
      return null;
    });
    if (!failed(result)) return state as ApprovalState;
    // Approving twice is a 401 and a stale `--sha` a 409, and stderr is never read: the re-read says which
    if (state?.viewerHasApproved) return state;
    const now = await this.readHead(target).catch(() => null);
    if (now?.headSha && now.headSha !== sha) throw new ReviewsError('the change request has a newer commit than the one you looked at', 'head-moved');
    const error = this.failure('approving', 'approve', target, call, result);
    throw error.reason === 'timeout' ? new ReviewsError(error.message, 'write-unconfirmed', error.detail) : error;
  }

  /** `POST …/approval`: GitLab only. The sha is the head the person looked at. */
  approve(id: string, sha: string): Promise<ApprovalState> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      const state = await this.approveNow(id, target, sha);
      await this.emitDecision(id).catch(() => undefined);
      return state;
    });
  }

  /** `DELETE …/approval`: GitLab only. Revoking what was never given is the state it wanted. */
  revoke(id: string): Promise<ApprovalState> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      const call = target.adapter.revoke(target.repo, target.number);
      if (!call) throw new HostActionNotOffered('Agentry does not revoke on this host');
      const result = await target.run(call);
      const head = (await this.readHead(target).catch(() => null))?.headSha ?? null;
      const state = await this.readApproval(target, head).catch((error: unknown) => {
        if (!failed(result)) throw error;
        return null;
      });
      if (!failed(result)) return state as ApprovalState;
      if (state && !state.viewerHasApproved) return state;
      const error = this.failure('revoking', 'approve', target, call, result);
      throw error.reason === 'timeout' ? new ReviewsError(error.message, 'write-unconfirmed', error.detail) : error;
    });
  }

  // ---------- reviewers ----------

  /** The reviewers, the host's decision and the unresolved count. GitLab's decision merges its two reads. */
  async reviewers(id: string): Promise<ChangeRequestReviewers> {
    const target = await this.target(id);
    const unresolved = this.unresolved(await this.threads(id));
    const result = await this.runRead(target, target.adapter.reviewers(target.repo, target.number), 'reading the reviewers', 'reviewers');
    let read: ChangeRequestReviewers;
    try {
      read = target.adapter.parseReviewers(result, unresolved);
    } catch (error) {
      if (error instanceof HostParseError) throw new ReviewsError('the host did not return the reviewers', 'unexpected-output', firstLine(error.message));
      throw error;
    }
    if (read.decision === null && target.adapter.approvals(target.repo, target.number)) {
      const approval = await this.readApproval(target, null).catch(() => null);
      if (approval?.approved) read = { ...read, decision: 'approved' };
      else if (approval && (approval.approvalsLeft ?? 0) > 0) read = { ...read, decision: 'review-required' };
    }
    this.decisions.set(id, read.decision);
    return read;
  }

  private async emitDecision(id: string): Promise<void> {
    const before = this.decisions.get(id);
    const read = await this.reviewers(id);
    if (read.decision !== before) this.deps.emit?.({ type: 'change-request.review', title: read.decision ?? 'no decision', changeRequestId: id, unresolvedThreads: read.unresolvedThreads, decision: read.decision });
  }

  /**
   * `POST …/reviewers`: adds and removes, never replaces. Whether a name was added is read back: an
   * unknown login exits 0 and adds nobody on GitHub (recorded).
   */
  requestReviewers(id: string, req: ReviewersRequest): Promise<ChangeRequestReviewers> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      const add = [...new Set(req.add.map((n) => n.trim()).filter((n) => n !== ''))];
      const remove = [...new Set((req.remove ?? []).map((n) => n.trim()).filter((n) => n !== ''))];
      if (add.length === 0 && remove.length === 0) throw new ReviewInputError('name at least one reviewer');
      let calls: HostCall[];
      try {
        calls = target.adapter.requestReviewers(target.repo, target.number, { add, remove });
      } catch (error) {
        if (error instanceof HostParseError) throw new ReviewInputError(error.message);
        throw error;
      }
      let refused: { call: HostCall; result: HostResult } | null = null;
      for (const call of calls) {
        const result = await target.run(call);
        if (failed(result)) {
          refused = { call, result };
          break;
        }
      }
      const fresh = await this.reviewers(id).catch((error: unknown) => {
        if (!refused) throw error;
        return null;
      });
      const has = (name: string): boolean => fresh?.reviewers.some((r) => r.login.toLowerCase() === name.toLowerCase() && r.state === 'requested') === true;
      const missing = add.filter((name) => !has(name));
      const stayed = remove.filter((name) => has(name));
      if (fresh && missing.length === 0 && stayed.length === 0) return fresh;
      if (refused) throw this.failure('requesting reviewers', 'reviewers', target, refused.call, refused.result);
      throw new ReviewsError('the host did not add every reviewer', 'not-found', [...missing, ...stayed].join(', '));
    });
  }
}
