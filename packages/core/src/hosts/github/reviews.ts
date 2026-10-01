import type { ApprovalState, ChangeRequestReviewer, ChangeRequestReviewers, ReviewComment, ReviewerState, ReviewSide, ReviewThread } from '@agentry/shared';
import {
  HostParseError,
  HostActionNotOffered,
  MAX_THREADS,
  type HostCall,
  type HostRepo,
  type HostResult,
  type PendingReviewEntry,
  type ReviewsAdapter,
  type ThreadFollowUp,
} from '../code-host.ts';
import { tryParseJson } from '../json.ts';
import {
  digits,
  documentsOf,
  GITHUB_LOGIN,
  idText,
  json,
  jsonOf,
  listOf,
  login,
  objectOf,
  suggestionFence,
  suggestionOf,
  text,
} from '../reviews-shape.ts';
import { RESOLVE_MUTATION, THREAD_COMMENTS_QUERY, THREADS_QUERY, UNRESOLVE_MUTATION } from './queries/threads.ts';

// Arguments and fields are what gh 2.92.0 and 2.102.0 were recorded to take and print for reviews
// (r0-NOTES.md, docs/plans/code-hosts.md matrix D). Agentry posts a comment review only: approving
// and requesting changes stay on GitHub (owner decision 1), so those calls are not built.

const scope = (repo: HostRepo): string => `repos/${repo.owner}/${repo.name}`;
const pin = (repo: HostRepo): string => `${repo.host}/${repo.owner}/${repo.name}`;

const GRAPHQL_BUCKET = 'graphql' as const;

/** A GraphQL node id (`PRRT_…`): it goes into `-F id=`, so it never starts with `-` or holds anything but these */
const NODE_ID = /^[A-Za-z0-9_=-]{6,200}$/;
const nodeId = (value: string, what: string): string => {
  if (!NODE_ID.test(value) || value.startsWith('-')) throw new HostParseError(`${what} is not a GraphQL node id`);
  return value;
};

/** An opaque page cursor is base64: it may hold `+` and `/`, and never starts with `-` or `@` */
const CURSOR = /^[A-Za-z0-9_=][A-Za-z0-9+/=_-]{5,499}$/;
const cursorOf = (value: string): string => {
  if (!CURSOR.test(value)) throw new HostParseError('a thread cursor is not what GitHub prints');
  return value;
};

const SIDES: Readonly<Record<string, ReviewSide>> = { LEFT: 'left', RIGHT: 'right' };

function comment(node: Record<string, unknown>, range: { from: number | null; to: number | null }): ReviewComment {
  // The REST reply endpoint takes the numeric id; the node id is only a fallback for a shape without it
  const id = idText(node.databaseId) ?? text(node.id);
  if (id === null) throw new HostParseError('a review comment has no id');
  const body = typeof node.body === 'string' ? node.body : '';
  return {
    id,
    author: text(objectOf(node.author)?.login),
    body,
    suggestion: suggestionOf(body, range.from, range.to),
    createdAt: text(node.createdAt),
    url: null,
  };
}

function commentsOf(connection: Record<string, unknown> | null, range: { from: number | null; to: number | null }): ReviewComment[] {
  const nodes = connection?.nodes;
  if (!Array.isArray(nodes)) throw new HostParseError('a review thread has no comments');
  return nodes.map((node) => {
    const object = objectOf(node);
    if (!object) throw new HostParseError('a review thread holds a non-object comment');
    return comment(object, range);
  });
}

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

/** The state a person's latest review leaves them in; PENDING and DISMISSED say nothing */
const REVIEW_STATES: Readonly<Record<string, ReviewerState>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
};

const DECISIONS: Readonly<Record<string, NonNullable<ChangeRequestReviewers['decision']>>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
};

export const githubReviews: ReviewsAdapter = {
  threads: (repo, number): HostCall => ({
    cli: 'gh',
    // `-i` for the status and rate-limit headers of a failed poll; with `--paginate` each page has its own block (recorded)
    args: [
      'api', '-i', '--hostname', repo.host, 'graphql', '--paginate',
      '-f', `query=${THREADS_QUERY}`,
      '-f', `owner=${repo.owner}`,
      '-f', `repo=${repo.name}`,
      '-F', `number=${String(number)}`,
      '-F', 'first=100',
    ],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: GRAPHQL_BUCKET,
  }),

  parseThreads(result) {
    if (result.exitCode !== 0) throw new HostParseError(`threads read exited ${String(result.exitCode)}`);
    const threads: ReviewThread[] = [];
    const followUps: ThreadFollowUp[] = [];
    let headSha: string | null = null;
    let truncated = false;
    for (const page of documentsOf(result.stdout, 'threads')) {
      const pull = objectOf(objectOf(objectOf(page.data)?.repository)?.pullRequest);
      // A pull request that does not exist is HTTP 200 with `errors[]` (recorded): the status line decides nothing
      if (!pull) throw new HostParseError('threads answer has no pull request');
      headSha ??= text(pull.headRefOid);
      const nodes = objectOf(pull.reviewThreads)?.nodes;
      if (!Array.isArray(nodes)) throw new HostParseError('threads answer has no reviewThreads');
      for (const raw of nodes) {
        const node = objectOf(raw);
        if (!node) throw new HostParseError('reviewThreads holds a non-object');
        if (threads.length >= MAX_THREADS) {
          truncated = true;
          continue;
        }
        const id = text(node.id);
        if (id === null) throw new HostParseError('a review thread has no id');
        const outdated = node.isOutdated === true;
        const line = outdated ? null : numberOrNull(node.line);
        const startLine = outdated ? null : (numberOrNull(node.startLine) ?? line);
        const originalLine = numberOrNull(node.originalLine);
        const connection = objectOf(node.comments);
        // A suggestion replaces the lines the thread sits on; an outdated thread has none to name
        const comments = commentsOf(connection, { from: startLine, to: line });
        const first = Array.isArray(connection?.nodes) ? objectOf(connection.nodes[0]) : null;
        const page2 = objectOf(connection?.pageInfo);
        const more = page2?.hasNextPage === true;
        const after = text(page2?.endCursor);
        if (more && after) followUps.push({ threadId: id, after });
        threads.push({
          id,
          path: text(node.path),
          side: SIDES[String(node.diffSide)] ?? null,
          line,
          startLine,
          originalLine,
          diffHunk: text(first?.diffHunk),
          isResolved: node.isResolved === true,
          isOutdated: outdated,
          resolvedBy: text(objectOf(node.resolvedBy)?.login),
          viewerCanReply: node.viewerCanReply === true,
          viewerCanResolve: node.viewerCanResolve === true,
          comments,
          commentsTruncated: more,
        });
      }
    }
    return { headSha, threads, truncated, followUps };
  },

  // From the cursor the first read ended at: one request for the rest (recorded), where `--paginate`
  // would read the 100 again
  threadComments: (repo, follow): HostCall => ({
    cli: 'gh',
    args: [
      'api', '--hostname', repo.host, 'graphql',
      '-f', `query=${THREAD_COMMENTS_QUERY}`,
      '-F', `id=${nodeId(follow.threadId, 'thread')}`,
      '-F', 'first=100',
      '-F', `endCursor=${cursorOf(follow.after)}`,
    ],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: GRAPHQL_BUCKET,
  }),

  parseThreadComments(result) {
    if (result.exitCode !== 0) throw new HostParseError(`thread comments read exited ${String(result.exitCode)}`);
    const [page] = documentsOf(result.stdout, 'thread comments');
    const connection = objectOf(objectOf(objectOf(page?.data)?.node)?.comments);
    if (!connection) throw new HostParseError('thread comments answer has no node');
    const info = objectOf(connection.pageInfo);
    return {
      comments: commentsOf(connection, { from: null, to: null }),
      after: info?.hasNextPage === true ? text(info.endCursor) : null,
    };
  },

  reply: (repo, number, thread, body): HostCall => {
    const root = thread.comments[0];
    return {
      cli: 'gh',
      args: [
        'api', '--hostname', repo.host, '-X', 'POST',
        `${scope(repo)}/pulls/${String(number)}/comments/${digits(root?.id, 'thread root comment')}/replies`,
        '--input', '-',
      ],
      input: json({ body }),
      kind: 'write',
      class: 'write',
      host: repo.host,
      bucket: 'core',
    };
  },

  resolve: (repo, _number, threadId, resolved): HostCall => ({
    cli: 'gh',
    args: [
      'api', '--hostname', repo.host, 'graphql',
      '-f', `query=${resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION}`,
      '-F', `id=${nodeId(threadId, 'thread')}`,
    ],
    kind: 'write',
    class: 'write',
    host: repo.host,
    bucket: GRAPHQL_BUCKET,
  }),

  submit(repo, number, review, event = 'comment') {
    if (event !== 'comment') throw new HostActionNotOffered('GitHub reviews are posted as comments only');
    // One request, all or nothing, always with an event, so no pending review is left behind (recorded)
    const comments = review.notes.map((note) => {
      const side = note.side === 'left' ? 'LEFT' : 'RIGHT';
      const body = note.suggestion ? suggestionFence(note.body, '') : note.body;
      const range = note.startLine !== null && note.startLine !== undefined && note.startLine < note.line;
      return range
        ? { path: note.path, start_line: note.startLine, start_side: side, line: note.line, side, body }
        : { path: note.path, line: note.line, side, body };
    });
    return {
      calls: [
        {
          cli: 'gh',
          args: ['api', '--hostname', repo.host, '-X', 'POST', `${scope(repo)}/pulls/${String(number)}/reviews`, '--input', '-'],
          input: json({ commit_id: review.headSha, event: 'COMMENT', body: review.body, comments }),
          kind: 'write',
          class: 'write',
          host: repo.host,
          bucket: 'core',
        },
      ],
      publish: null,
    };
  },

  parseSubmitted(result) {
    const body = objectOf(jsonOf(result.stdout, 'review'));
    return { remoteId: body ? idText(body.id) : null };
  },

  parseDraftNote: () => null,

  // Every reply is a review of its own, so the list passes 100 fast and must be paged (recorded)
  pendingReviews: (repo, number): HostCall => ({
    cli: 'gh',
    args: ['api', '--hostname', repo.host, '--paginate', '--slurp', `${scope(repo)}/pulls/${String(number)}/reviews?per_page=100`],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: 'core',
  }),

  parsePendingReviews(result): PendingReviewEntry[] {
    if (result.exitCode !== 0) throw new HostParseError(`reviews read exited ${String(result.exitCode)}`);
    return listOf(result.stdout, 'reviews').flatMap((review) => {
      const id = idText(review.id);
      // The REST id is the number; a review without one cannot be told apart, so it is not listed
      return id === null
        ? []
        : [{ id, pending: String(review.state).toUpperCase() === 'PENDING', body: typeof review.body === 'string' ? review.body : '', author: text(objectOf(review.user)?.login) }];
    });
  },

  publishSaved: () => null,
  discardDraft: () => null,
  approve: () => null,
  revoke: () => null,
  approvals: () => null,

  parseApprovals(): ApprovalState {
    // Agentry does not approve on GitHub: the decision is `reviewers`'s
    return { approved: false, approvalsRequired: null, approvalsLeft: null, viewerHasApproved: false, canApprove: false, canRevoke: false, approvedBy: [], headSha: null };
  },

  requestReviewers(repo, number, req) {
    if (req.remove && req.remove.length > 0) throw new HostActionNotOffered('removing a reviewer is not offered on GitHub');
    if (req.add.length === 0) return [];
    // Not `gh pr edit --add-reviewer`, which drops the author silently with exit 0
    return [
      {
        cli: 'gh',
        args: ['api', '--hostname', repo.host, '-X', 'POST', `${scope(repo)}/pulls/${String(number)}/requested_reviewers`, '--input', '-'],
        input: json({ reviewers: req.add.map((name) => login(name, GITHUB_LOGIN)) }),
        kind: 'write',
        class: 'write',
        host: repo.host,
        bucket: 'core',
      },
    ];
  },

  // An unknown login exits 0 and adds nobody (recorded), so the person's list is always re-read
  reviewers: (repo, number): HostCall => ({
    cli: 'gh',
    args: ['pr', 'view', String(number), '-R', pin(repo), '--json', 'reviewRequests,reviewDecision,reviews'],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: GRAPHQL_BUCKET,
  }),

  parseReviewers(result, unresolvedThreads): ChangeRequestReviewers {
    const view = objectOf(jsonOf(result.stdout, 'pr view'));
    if (!view || !Array.isArray(view.reviews) || !Array.isArray(view.reviewRequests)) throw new HostParseError('pr view has no reviews or reviewRequests');
    const byLogin = new Map<string, ReviewerState>();
    // Oldest first: a later review replaces an earlier one, a DISMISSED or PENDING one changes nothing
    for (const raw of view.reviews) {
      const review = objectOf(raw);
      const name = text(objectOf(review?.author)?.login);
      const state = REVIEW_STATES[String(review?.state).toUpperCase()];
      if (name && state) byLogin.set(name, state);
    }
    // A re-requested review wins over the old verdict: the person is asked again
    for (const raw of view.reviewRequests) {
      const request = objectOf(raw);
      const name = text(request?.login) ?? text(request?.slug) ?? text(request?.name);
      if (name) byLogin.set(name, 'requested');
    }
    const reviewers: ChangeRequestReviewer[] = [...byLogin].map(([name, state]) => ({ login: name, state }));
    return { decision: DECISIONS[String(view.reviewDecision).toUpperCase()] ?? null, reviewers, unresolvedThreads };
  },

  reasonOf(op, result) {
    const body = objectOf(tryParseJson(result.stdout));
    if (!body) return null;
    if (op === 'submit' || op === 'draft') {
      // `errors` are strings here, not the objects of a GraphQL answer (recorded)
      const errors = Array.isArray(body.errors) ? body.errors : [];
      return errors.some((error) => error === 'Line could not be resolved') ? 'line-not-in-diff' : null;
    }
    if (op === 'reviewers') {
      return typeof body.message === 'string' && body.message.startsWith('Review cannot be requested from pull request author') ? 'own-change-request' : null;
    }
    if (op === 'resolve') {
      const errors = Array.isArray(body.errors) ? body.errors : [];
      return errors.some((error) => objectOf(error)?.type === 'NOT_FOUND') ? 'not-found' : null;
    }
    return null;
  },
};
