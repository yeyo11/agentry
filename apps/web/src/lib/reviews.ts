/**
 * The pure model of a change request's review: where each thread is drawn, which word and colour the
 * decision and the reviewers carry, what the draft review holds, what the submit sheet offers and
 * which action is the item page's gradient one. No React and no fetching: tested without a browser
 * (test/reviews.test.ts).
 *
 * Label keys are in the `reviews` namespace: `t(label)` with `useTranslation('reviews')`.
 */
import type { ApprovalState, ChangeRequest, ChangeRequestReviewers, CodeHostId, ReviewDraft, ReviewEvent, ReviewPost, ReviewSide, ReviewThread, ReviewerState } from '@agentry/shared';

/** The status colour of a mark: ok, warn, bad or idle. Reviews have nothing running, so never `live`. */
export type ReviewTone = 'ok' | 'warn' | 'bad' | 'idle';

// ---------- threads ----------

/** `left:42` / `right:42`: the key of a line in a file's thread layer. */
export const lineKey = (side: ReviewSide, line: number): string => `${side}:${line}`;

/**
 * - `line`: drawn under its new-side line, because it was left on the head commit.
 * - `outdated`: the code moved; folded, with the line it was left on and its own hunk.
 * - `file`: has a path but no line to draw on (a thread on the whole file).
 * - `general`: on the change request, not on a file.
 */
export type ThreadPlace = 'line' | 'outdated' | 'file' | 'general';

export function threadPlace(thread: ReviewThread): ThreadPlace {
  if (thread.path === null) return 'general';
  if (thread.isOutdated) return 'outdated';
  return thread.line === null ? 'file' : 'line';
}

/** What a file shows of its threads, in the order the page draws them. */
export interface FileThreads {
  /** Open threads by the line they end on; they stay on the diff */
  byLine: Map<string, ReviewThread[]>;
  /** Resolved threads on a line: folded by default, but they still belong to it */
  resolvedByLine: Map<string, ReviewThread[]>;
  /** Outdated threads, open or resolved, in the file's fold */
  outdated: ReviewThread[];
  /** Threads on the file with no line */
  file: ReviewThread[];
}

const emptyFile = (): FileThreads => ({ byLine: new Map(), resolvedByLine: new Map(), outdated: [], file: [] });

function push(map: Map<string, ReviewThread[]>, key: string, thread: ReviewThread): void {
  const list = map.get(key);
  if (list) list.push(thread);
  else map.set(key, [thread]);
}

/** The threads of every file, by path; general ones come apart in `general`. Order is the host's. */
export function groupThreads(threads: readonly ReviewThread[]): { files: Map<string, FileThreads>; general: ReviewThread[] } {
  const files = new Map<string, FileThreads>();
  const general: ReviewThread[] = [];
  for (const thread of threads) {
    if (thread.path === null) {
      general.push(thread);
      continue;
    }
    let file = files.get(thread.path);
    if (!file) files.set(thread.path, (file = emptyFile()));
    if (thread.isOutdated) file.outdated.push(thread);
    else if (thread.line === null) file.file.push(thread);
    else push(thread.isResolved ? file.resolvedByLine : file.byLine, lineKey(thread.side ?? 'right', thread.line), thread);
  }
  return { files, general };
}

export interface ThreadCounts {
  unresolved: number;
  resolved: number;
}

export function countThreads(threads: readonly ReviewThread[]): ThreadCounts {
  const unresolved = threads.filter((t) => !t.isResolved).length;
  return { unresolved, resolved: threads.length - unresolved };
}

/** A thread starts folded when it is resolved; the person's own click overrides it. */
export const startsFolded = (thread: ReviewThread): boolean => thread.isResolved;

/** `:142`, or `:57–60` for a range: the mono locator of a thread or a draft. */
export function lineLabel(line: number | null, startLine: number | null): string | null {
  if (line === null) return null;
  return startLine !== null && startLine !== line ? `:${Math.min(startLine, line)}–${Math.max(startLine, line)}` : `:${line}`;
}

/** The line a thread is shown on: where it stands now, else where it was left. */
export const threadLine = (thread: ReviewThread): number | null => thread.line ?? thread.originalLine;

// ---------- decision and reviewers ----------

export interface DecisionMark {
  tone: ReviewTone;
  label: `decision.${'approved' | 'changes-requested' | 'review-required' | 'none'}`;
}

/** The host's decision in Agentry's words: approved is ok, changes asked is bad, a review that is missing waits (idle). */
export function decisionMark(decision: ChangeRequestReviewers['decision'] | undefined): DecisionMark {
  switch (decision) {
    case 'approved':
      return { tone: 'ok', label: 'decision.approved' };
    case 'changes-requested':
      return { tone: 'bad', label: 'decision.changes-requested' };
    case 'review-required':
      return { tone: 'idle', label: 'decision.review-required' };
    default:
      return { tone: 'idle', label: 'decision.none' };
  }
}

export interface ReviewerMark {
  tone: ReviewTone;
  label: `reviewer.${ReviewerState}`;
}

export function reviewerMark(state: ReviewerState): ReviewerMark {
  switch (state) {
    case 'approved':
      return { tone: 'ok', label: 'reviewer.approved' };
    case 'changes-requested':
      return { tone: 'bad', label: 'reviewer.changes-requested' };
    case 'commented':
      return { tone: 'idle', label: 'reviewer.commented' };
    case 'requested':
      return { tone: 'idle', label: 'reviewer.requested' };
  }
}

/** `1 of 2`: the approvals line, only when the host counts them. */
export function approvalsProgress(approval: Pick<ApprovalState, 'approvalsRequired' | 'approvalsLeft'> | undefined): { given: number; required: number } | null {
  if (!approval || approval.approvalsRequired === null || approval.approvalsLeft === null) return null;
  return { given: Math.max(0, approval.approvalsRequired - approval.approvalsLeft), required: approval.approvalsRequired };
}

/** The logins to ask for a review: trimmed, without `@`, empty ones, repeats and the ones already on the list. */
export function parseLogins(text: string, already: readonly string[] = []): string[] {
  const have = new Set(already.map((l) => l.toLowerCase()));
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const login = raw.replace(/^@/, '').trim();
    if (!login || have.has(login.toLowerCase())) continue;
    have.add(login.toLowerCase());
    out.push(login);
  }
  return out;
}

// ---------- the draft review ----------

export interface DraftSummary {
  total: number;
  comments: number;
  suggestions: number;
}

/** `3 comments · 1 suggestion`: a suggestion is counted apart, and not as a comment. */
export function summarizeDrafts(drafts: readonly Pick<ReviewDraft, 'suggestion'>[]): DraftSummary {
  const suggestions = drafts.filter((d) => d.suggestion).length;
  return { total: drafts.length, comments: drafts.length - suggestions, suggestions };
}

/** Drafts in the order of the diff: by file, then line; notes on the change request itself last. */
export function sortDrafts(drafts: readonly ReviewDraft[]): ReviewDraft[] {
  return [...drafts].sort((a, b) => {
    if ((a.path === null) !== (b.path === null)) return a.path === null ? 1 : -1;
    if (a.path !== b.path) return (a.path ?? '').localeCompare(b.path ?? '');
    return (a.line ?? 0) - (b.line ?? 0) || a.createdAt.localeCompare(b.createdAt);
  });
}

/** The drafts left on one line of a file (either side), for the composer that sits under it. */
export const draftsOnLine = (drafts: readonly ReviewDraft[], path: string, side: ReviewSide, line: number): ReviewDraft[] =>
  drafts.filter((d) => d.path === path && d.line === line && (d.side ?? 'right') === side);

/** A suggestion block, as the host reads it: the replacement lines between the fences. */
export const suggestionBlock = (replacement: string): string => `\`\`\`suggestion\n${replacement.replace(/\n$/, '')}\n\`\`\``;

// ---------- submitting ----------

export interface SubmitOffer {
  /** The events Agentry posts itself, `comment` first */
  events: ReviewEvent[];
  /** Approve and request changes happen on the host: the sheet links them instead (GitHub; its success path was never recorded) */
  openOnHost: boolean;
  /** GitHub refuses a verdict on the person's own change request: it is neither offered nor linked, and the sheet says why */
  own: boolean;
}

/**
 * What the submit sheet offers. Comment always; Approve only on GitLab and only when the approval
 * state says the viewer can (Agentry's rule, never the host's `user_can_approve`). Request changes
 * is never offered by Agentry.
 */
export function submitOffer(host: CodeHostId, approval: Pick<ApprovalState, 'canApprove'> | undefined, own = false): SubmitOffer {
  const events: ReviewEvent[] = ['comment'];
  if (host === 'gitlab' && approval?.canApprove) events.push('approve');
  return { events, openOnHost: host === 'github' && !own, own: own && host === 'github' };
}

/** Whether submitting can do anything: a drafted note or a text of its own, or an approval, which needs neither. */
export const canSubmit = (drafts: readonly unknown[], event: ReviewEvent, body: string): boolean =>
  event === 'approve' || drafts.length > 0 || body.trim().length > 0;

export interface PostMark {
  tone: ReviewTone;
  label: `post.${ReviewPost['state']}`;
}

export function postMark(post: Pick<ReviewPost, 'state'>): PostMark {
  switch (post.state) {
    case 'posted':
      return { tone: 'ok', label: 'post.posted' };
    case 'partly':
      return { tone: 'warn', label: 'post.partly' };
    case 'failed':
      return { tone: 'bad', label: 'post.failed' };
    case 'posting':
      return { tone: 'idle', label: 'post.posting' };
  }
}

/** A GitLab review that stopped half way: the person chooses Publish saved or Discard saved. */
export const needsPartialChoice = (post: Pick<ReviewPost, 'state'> | null | undefined): boolean => post?.state === 'partly';

// ---------- the item page's primary action ----------

/**
 * One gradient action per zone. While the person has a draft review, **Submit review** is the
 * zone's, and the header's **Work on it** renders neutral, as it does while **Fix failing checks**
 * shows (`checksFixShowing`).
 */
export const workOnItNeutral = (opts: { drafts: number; checksFixShowing: boolean }): boolean => opts.drafts > 0 || opts.checksFixShowing;

/** Submit review is the zone's gradient action while there is a draft to send. */
export const submitIsPrimary = (drafts: number): boolean => drafts > 0;

// ---------- addressing with an agent ----------

/** What `review.triage` suggests for a thread; it only preselects, nothing is sent or done by a mark. */
export type TriageMark = 'agent' | 'person' | 'no-action';

export interface TriageTone {
  tone: ReviewTone;
  label: `triage.${TriageMark}`;
}

export const triageMark = (mark: TriageMark): TriageTone => ({ tone: mark === 'agent' ? 'ok' : 'idle', label: `triage.${mark}` });

/** The most threads an address hands over (`review.triage` reads as many). */
export const ADDRESS_THREADS_MAX = 40;

/** The unresolved threads the dialog lists, at most the ceiling. */
export const addressable = (threads: readonly ReviewThread[]): ReviewThread[] => threads.filter((t) => !t.isResolved).slice(0, ADDRESS_THREADS_MAX);

/** The ids chosen beforehand: the ones marked `agent`. With no marks, none: the person chooses. */
export function preselected(threads: readonly ReviewThread[], marks: Readonly<Record<string, TriageMark>> | undefined): Set<string> {
  const ids = new Set<string>();
  if (!marks) return ids;
  for (const t of threads) if (marks[t.id] === 'agent') ids.add(t.id);
  return ids;
}

/** An address of review threads is under way or waiting for its push. */
export const isReviewFix = (cr: Pick<ChangeRequest, 'fixKind' | 'fixState'> | undefined): boolean => cr?.fixKind === 'review' && !!cr.fixState;

/** The threads a finished address offers "Addressed in" and Resolve for: its own, still open. */
export function followUpThreads(threads: readonly ReviewThread[], addressedIds: readonly string[]): ReviewThread[] {
  const ids = new Set(addressedIds);
  return threads.filter((t) => ids.has(t.id) && !t.isResolved);
}
