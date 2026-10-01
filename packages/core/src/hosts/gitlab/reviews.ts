import type { ApprovalState, ChangeRequestReviewer, ChangeRequestReviewers, ReviewComment, ReviewerState, ReviewSide, ReviewSuggestion, ReviewThread } from '@agentry/shared';
import {
  HostParseError,
  HostActionNotOffered,
  MAX_THREADS,
  type HostCall,
  type HostRepo,
  type PendingReviewEntry,
  type ReviewNote,
  type ReviewsAdapter,
} from '../code-host.ts';
import { tryParseJson } from '../json.ts';
import { digits, documentsOf, GITLAB_USERNAME, idText, json, jsonOf, listOf, login, objectOf, suggestionFence, text } from '../reviews-shape.ts';
import { projectPath, projectUrl } from './checks.ts';

// Every argument and field is what glab 1.120.0 was recorded to take and print for reviews
// (r0-NOTES.md, docs/plans/code-hosts.md matrix D). GitLab has no review object: a note is a draft
// note until `mr note publish` turns every draft into a discussion of its own.

const mr = (repo: HostRepo, number: number): string => `${projectPath(repo)}/merge_requests/${String(number)}`;

const read = (repo: HostRepo, args: string[]): HostCall => ({ cli: 'glab', args: ['api', '--hostname', repo.host, ...args], kind: 'read', class: 'read', host: repo.host });

/** A JSON body needs its content type: without it GitLab answers 415 and glab says only `HTTP 415` (recorded) */
const JSON_HEADER = ['-H', 'Content-Type: application/json'];

const sendJson = (repo: HostRepo, method: 'POST', path: string, body: unknown): HostCall => ({
  cli: 'glab',
  args: ['api', '--hostname', repo.host, '-X', method, path, ...JSON_HEADER, '--input', '-'],
  input: json(body),
  kind: 'write',
  class: 'write',
  host: repo.host,
});

const porcelain = (repo: HostRepo, args: string[]): HostCall => ({ cli: 'glab', args: [...args, '-R', projectUrl(repo)], kind: 'write', class: 'write', host: repo.host });

/** A discussion id is 40 hex characters; `mr note resolve` also takes a prefix, but Agentry always has the whole id */
const discussionId = (value: string): string => {
  if (!/^[0-9a-f]{8,64}$/.test(value)) throw new HostParseError('a discussion id is not hex');
  return value;
};

const sha = (value: string): string => {
  if (!/^[0-9a-f]{7,64}$/.test(value)) throw new HostParseError('a commit id is not hex');
  return value;
};

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

function suggestionOf(note: Record<string, unknown>): ReviewSuggestion | null {
  // `[]` on a line note without one and `null` on a note that is not on a line (recorded)
  const first = Array.isArray(note.suggestions) ? objectOf(note.suggestions[0]) : null;
  const fromLine = numberOrNull(first?.from_line);
  const toLine = numberOrNull(first?.to_line);
  if (!first || fromLine === null || toLine === null || typeof first.to_content !== 'string') return null;
  return {
    fromLine,
    toLine,
    fromContent: typeof first.from_content === 'string' ? first.from_content : null,
    toContent: first.to_content,
    appliable: first.appliable === true,
    applied: first.applied === true,
  };
}

function commentOf(note: Record<string, unknown>): ReviewComment {
  const id = idText(note.id);
  if (id === null) throw new HostParseError('a note has no id');
  return {
    id,
    author: text(objectOf(note.author)?.username),
    body: typeof note.body === 'string' ? note.body : '',
    suggestion: suggestionOf(note),
    createdAt: text(note.created_at),
    url: null,
  };
}

const REVIEWER_STATES: Readonly<Record<string, ReviewerState>> = {
  unreviewed: 'requested',
  review_started: 'requested',
  reviewed: 'commented',
  requested_changes: 'changes-requested',
  approved: 'approved',
};

export const gitlabReviews: ReviewsAdapter = {
  // `per_page` counts discussions, and a discussion carries every one of its notes (102 seen)
  threads: (repo, number): HostCall => read(repo, ['--paginate', '--output', 'ndjson', `${mr(repo, number)}/discussions?per_page=100`]),

  parseThreads(result, ctx) {
    if (result.exitCode !== 0) throw new HostParseError(`discussions read exited ${String(result.exitCode)}`);
    const threads: ReviewThread[] = [];
    let truncated = false;
    for (const discussion of documentsOf(result.stdout, 'discussions')) {
      const notes = (Array.isArray(discussion.notes) ? discussion.notes : []).flatMap((raw) => {
        const note = objectOf(raw);
        return note && note.system !== true ? [note] : [];
      });
      const id = text(discussion.id);
      if (id === null || !Array.isArray(discussion.notes)) throw new HostParseError('a discussion has no id or notes');
      const first = notes[0];
      // An individual note is a top-level comment, and an event ("approved this merge request") has no author's words
      if (!first || discussion.individual_note === true) continue;
      if (threads.length >= MAX_THREADS) {
        truncated = true;
        continue;
      }
      const position = objectOf(first.position);
      const newLine = numberOrNull(position?.new_line);
      const oldLine = numberOrNull(position?.old_line);
      const side: ReviewSide | null = newLine !== null ? 'right' : oldLine !== null ? 'left' : null;
      const there = side === 'right' ? newLine : oldLine;
      const range = objectOf(position?.line_range);
      const rangeStart = objectOf(range?.start);
      const start = numberOrNull(side === 'right' ? rangeStart?.new_line : rangeStart?.old_line);
      // A position keeps the commit it was left on: another one than the head is a thread the code moved from
      const left = text(position?.head_sha);
      const outdated = side !== null && left !== null && ctx.headSha !== null && left !== ctx.headSha;
      const resolved = discussion.resolved === true;
      threads.push({
        id,
        path: text(position?.new_path) ?? text(position?.old_path),
        side,
        line: outdated ? null : there,
        startLine: outdated ? null : (start ?? there),
        originalLine: there,
        diffHunk: null,
        isResolved: resolved,
        isOutdated: outdated,
        resolvedBy: resolved ? (notes.map((n) => text(objectOf(n.resolved_by)?.username)).find((name) => name !== null) ?? null) : null,
        viewerCanReply: true,
        viewerCanResolve: discussion.resolvable === true,
        comments: notes.map(commentOf),
        commentsTruncated: false,
      });
    }
    return { headSha: ctx.headSha, threads, truncated, followUps: [] };
  },

  threadComments: () => null,
  parseThreadComments() {
    throw new HostParseError('GitLab returns every note of a discussion at once');
  },

  reply: (repo, number, thread, body): HostCall =>
    sendJson(repo, 'POST', `${mr(repo, number)}/discussions/${discussionId(thread.id)}/notes`, { body }),

  resolve: (repo, number, threadId, resolved): HostCall =>
    porcelain(repo, ['mr', 'note', resolved ? 'resolve' : 'reopen', String(number), discussionId(threadId)]),

  submit(repo, number, review, event = 'comment') {
    // An approval is `approve`: the drafts are published as comments
    if (event !== 'comment') throw new HostActionNotOffered('GitLab reviews are posted as comments; approving is a call of its own');
    const refs = review.diffRefs;
    if (review.notes.length > 0 && !refs) throw new HostParseError('GitLab places a note on the diff refs of the merge request');
    const draft = (body: unknown): HostCall => sendJson(repo, 'POST', `${mr(repo, number)}/draft_notes`, body);
    // The review's own text first: it becomes the discussion a recovery looks for the marker in (recorded)
    const calls = [draft({ note: review.body })];
    for (const note of review.notes) {
      if (!refs) break;
      calls.push(draft({ note: noteBody(note), position: positionOf(note, refs) }));
    }
    return { calls, publish: porcelain(repo, ['mr', 'note', 'publish', String(number), '-y']) };
  },

  parseSubmitted: () => ({ remoteId: null }),

  parseDraftNote(result) {
    if (result.exitCode !== 0) throw new HostParseError(`draft note create exited ${String(result.exitCode)}`);
    const draft = objectOf(jsonOf(result.stdout, 'draft note'));
    const id = idText(draft?.id);
    if (!draft || id === null) throw new HostParseError('draft note has no id');
    const position = objectOf(draft.position);
    const onLine = numberOrNull(position?.new_line) !== null || numberOrNull(position?.old_line) !== null;
    // A line outside the diff is accepted with `line_code: null` and then vanishes on publish, with exit 0 (recorded)
    return { id, placed: !onLine || text(draft.line_code) !== null };
  },

  // Not paginated (recorded: no X-Total or Link headers), newest first
  pendingReviews: (repo, number): HostCall => read(repo, [`${mr(repo, number)}/draft_notes`]),

  parsePendingReviews(result): PendingReviewEntry[] {
    if (result.exitCode !== 0) throw new HostParseError(`draft notes read exited ${String(result.exitCode)}`);
    return listOf(result.stdout, 'draft notes').flatMap((draft) => {
      const id = idText(draft.id);
      return id === null ? [] : [{ id, pending: true, body: typeof draft.note === 'string' ? draft.note : '', author: null }];
    });
  },

  publishSaved: (repo, number) => porcelain(repo, ['mr', 'note', 'publish', String(number), '-y']),

  discardDraft: (repo, number, draftId): HostCall => ({
    cli: 'glab',
    args: ['api', '--hostname', repo.host, '-X', 'DELETE', `${mr(repo, number)}/draft_notes/${digits(draftId, 'draft note')}`],
    kind: 'write',
    class: 'write',
    host: repo.host,
  }),

  // `--sha` makes a head that moved a 409 instead of an approval of code the person never saw (recorded)
  approve: (repo, number, headSha) => porcelain(repo, ['mr', 'approve', String(number), '--sha', sha(headSha)]),
  revoke: (repo, number) => porcelain(repo, ['mr', 'revoke', String(number)]),
  approvals: (repo, number) => read(repo, [`${mr(repo, number)}/approvals`]),

  parseApprovals(result, headSha): ApprovalState {
    if (result.exitCode !== 0) throw new HostParseError(`approvals read exited ${String(result.exitCode)}`);
    const body = objectOf(jsonOf(result.stdout, 'approvals'));
    if (!body || typeof body.user_has_approved !== 'boolean') throw new HostParseError('approvals has no user_has_approved');
    const by = (Array.isArray(body.approved_by) ? body.approved_by : []).flatMap((entry) => {
      const name = text(objectOf(objectOf(entry)?.user)?.username);
      return name ? [name] : [];
    });
    const viewerHasApproved = body.user_has_approved;
    return {
      approved: body.approved === true,
      approvalsRequired: numberOrNull(body.approvals_required),
      approvalsLeft: numberOrNull(body.approvals_left),
      viewerHasApproved,
      // `user_can_approve` is false for an author whose approval succeeds (recorded), so it is not the rule, and
      // neither is being the author: a project whose rules forbid it refuses the approval and the host's reason is shown
      canApprove: !viewerHasApproved,
      canRevoke: viewerHasApproved,
      approvedBy: by,
      headSha,
    };
  },

  // `--reviewer user` would replace the whole list: only `+user` and `-user` change one name (recorded)
  requestReviewers: (repo, number, req) => [
    ...req.add.map((name) => porcelain(repo, ['mr', 'update', String(number), `--reviewer=+${login(name, GITLAB_USERNAME)}`])),
    ...(req.remove ?? []).map((name) => porcelain(repo, ['mr', 'update', String(number), `--reviewer=-${login(name, GITLAB_USERNAME)}`])),
  ],

  reviewers: (repo, number): HostCall => read(repo, [`${mr(repo, number)}/reviewers`]),

  parseReviewers(result, unresolvedThreads): ChangeRequestReviewers {
    if (result.exitCode !== 0) throw new HostParseError(`reviewers read exited ${String(result.exitCode)}`);
    const reviewers: ChangeRequestReviewer[] = listOf(result.stdout, 'reviewers').flatMap((entry) => {
      const name = text(objectOf(entry.user)?.username);
      return name ? [{ login: name, state: REVIEWER_STATES[String(entry.state)] ?? 'requested' }] : [];
    });
    // Whether the approvals rule is met is `approvals`'s: here only a request for changes is a verdict
    return { decision: reviewers.some((r) => r.state === 'changes-requested') ? 'changes-requested' : null, reviewers, unresolvedThreads };
  },

  reasonOf(op, result) {
    const body = objectOf(tryParseJson(result.stdout));
    if ((op === 'submit' || op === 'draft' || op === 'reply') && typeof body?.message === 'string' && body.message.includes('line_code')) return 'line-not-in-diff';
    return null;
  },
};

function noteBody(note: ReviewNote): string {
  if (!note.suggestion) return note.body;
  // `-N+0` is how many lines above the note's own line the block replaces (recorded: `-1+1` replaced 4-6 from line 5)
  const above = note.startLine !== null && note.startLine !== undefined && note.startLine < note.line ? note.line - note.startLine : 0;
  return suggestionFence(note.body, `:-${String(above)}+0`);
}

function positionOf(note: ReviewNote, refs: { baseSha: string; startSha: string; headSha: string }): Record<string, unknown> {
  const base = {
    position_type: 'text',
    base_sha: refs.baseSha,
    start_sha: refs.startSha,
    head_sha: refs.headSha,
    old_path: note.oldPath ?? note.path,
    new_path: note.path,
  };
  // A context line needs both of its lines (matrix D3)
  if (note.side === 'right') return { ...base, new_line: note.line, ...(note.oldLine !== null && note.oldLine !== undefined ? { old_line: note.oldLine } : {}) };
  return { ...base, old_line: note.line };
}
