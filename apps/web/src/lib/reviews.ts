/**
 * The pure model of a change request's review: where each thread is drawn, which word and colour the
 * decision and the reviewers carry, what the draft review holds, what the submit sheet offers and
 * which action is the item page's gradient one. No React and no fetching: tested without a browser
 * (test/reviews.test.ts).
 *
 * Label keys are in the `reviews` namespace: `t(label)` with `useTranslation('reviews')`.
 */
import type { ApprovalState, ChangeRequest, ChangeRequestReviewers, CodeHostId, ReviewDraft, ReviewEvent, ReviewPost, ReviewSide, ReviewThread, ReviewerState, WorkItemPullRequest } from '@agentry/shared';

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

/**
 * Counted as the core counts them: an outdated thread waits for no answer (the code it was left on
 * moved), so it is not unresolved, and the number does not change when the threads load after the
 * reviewers' count.
 */
export const isUnresolved = (thread: Pick<ReviewThread, 'isResolved' | 'isOutdated'>): boolean => !thread.isResolved && !thread.isOutdated;

export function countThreads(threads: readonly ReviewThread[]): ThreadCounts {
  return { unresolved: threads.filter(isUnresolved).length, resolved: threads.filter((t) => t.isResolved).length };
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

/**
 * The head each draft note was written on, kept for the tab: a note belongs to the commit the person
 * had in front of them, and neither the draft row nor the diff page's load says which. A reload
 * forgets it, and the page's own head stands in for the notes it no longer knows.
 */
const noteHeads = new Map<string, string>();

export const pinNoteHead = (draftId: string, head: string | null | undefined): void => {
  if (head) noteHeads.set(draftId, head);
};

export const noteHeadOf = (draftId: string): string | null => noteHeads.get(draftId) ?? null;

/**
 * The head a submit is posted on, which the server compares with the host's: the first note written
 * on a commit other than the current one, so a head that moved after any note was written is refused
 * and never posted over. Notes the tab does not know (`pinned` has no head for them) are read on
 * `fallback`, the head the page last looked at.
 */
export function reviewedHead(drafts: readonly Pick<ReviewDraft, 'id'>[], pinned: (draftId: string) => string | null, fallback: string | null, headNow: string | null): string | null {
  const heads = drafts.map((d) => pinned(d.id) ?? fallback);
  return heads.find((h) => h !== null && h !== headNow) ?? heads.find((h) => h !== null) ?? fallback;
}

/** Whether submitting can do anything: a drafted note or a text of its own, or an approval, which needs neither. */
export const canSubmit = (drafts: readonly unknown[], event: ReviewEvent, body: string): boolean =>
  event === 'approve' || drafts.length > 0 || body.trim().length > 0;

/** A GitLab review that stopped half way: the person chooses Publish saved or Discard saved. */
export const needsPartialChoice = (post: Pick<ReviewPost, 'state'> | null | undefined): boolean => post?.state === 'partly';

/**
 * The post the draft block still has to settle: the newest attempt, when it stopped half way. A
 * later attempt that went out (or none) leaves nothing to choose, so a reload shows what the last
 * tab did.
 */
export function partlyPost<P extends Pick<ReviewPost, 'state'>>(posts: readonly P[] | undefined): P | null {
  const newest = posts?.[0];
  return newest && needsPartialChoice(newest) ? newest : null;
}

// ---------- the item page's primary action ----------

/**
 * One gradient action per zone. While the person has a draft review, **Submit review** is the
 * zone's, and the header's **Work on it** renders neutral, as it does while **Fix failing checks**
 * shows (`checksFixShowing`), and while **Merge** leads the merge block (`mergeLeading`).
 */
export const workOnItNeutral = (opts: { drafts: number; checksFixShowing: boolean; mergeLeading?: boolean }): boolean => opts.drafts > 0 || opts.checksFixShowing || opts.mergeLeading === true;

// ---------- addressing with an agent ----------

/** What `review.triage` suggests for a thread; it only preselects, nothing is sent or done by a mark. */
export type TriageMark = 'agent' | 'person' | 'no-action';

export interface TriageTone {
  tone: ReviewTone;
}

/** The mark's words are `address.triage.*` in the `workItem` namespace; only its colour is decided here. */
export const triageMark = (mark: TriageMark): TriageTone => ({ tone: mark === 'agent' ? 'ok' : 'idle' });

/** The most threads an address hands over (`review.triage` reads as many). */
export const ADDRESS_THREADS_MAX = 40;

/** The unresolved threads the dialog lists, at most the ceiling: the ones the strip and the review block count. */
export const addressable = (threads: readonly ReviewThread[]): ReviewThread[] => threads.filter(isUnresolved).slice(0, ADDRESS_THREADS_MAX);

/** The ids chosen beforehand: the ones marked `agent`. With no marks, none: the person chooses. */
export function preselected(threads: readonly ReviewThread[], marks: Readonly<Record<string, TriageMark>> | undefined): Set<string> {
  const ids = new Set<string>();
  if (!marks) return ids;
  for (const t of threads) if (marks[t.id] === 'agent') ids.add(t.id);
  return ids;
}

/** An address of review threads is under way or waiting for its push. */
export const isReviewFix = (cr: { fixKind?: ChangeRequest['fixKind']; fixState?: ChangeRequest['fixState'] } | null | undefined): boolean => cr?.fixKind === 'review' && !!cr.fixState;

/**
 * Whether the last word on a thread is `text`: the reply a follow-up posts. The host is the record of it,
 * so a follow-up that is shown again (the page was reloaded, or left and come back to) does not post it twice.
 */
export const answeredWith = (thread: Pick<ReviewThread, 'comments'>, text: string): boolean => thread.comments.at(-1)?.body.trim() === text.trim();

/** The threads a finished address offers "Addressed in" and Resolve for: its own, still open. */
export function followUpThreads(threads: readonly ReviewThread[], addressedIds: readonly string[]): ReviewThread[] {
  const ids = new Set(addressedIds);
  return threads.filter((t) => ids.has(t.id) && !t.isResolved);
}

/**
 * What "Addressed in <sha>" may say: the push the address itself made, as the core recorded it. A
 * head the browser saw move proves nothing (a card taken over and then pushed by someone else moves it
 * too), so a change request with no record of such a push offers nothing.
 */
export function followUp(pr: Pick<WorkItemPullRequest, 'addressed' | 'fixState'> | null | undefined): { sha: string; threadIds: string[] } | null {
  const done = pr?.addressed;
  if (!done || pr.fixState || !done.head || done.threadIds.length === 0) return null;
  return { sha: done.head, threadIds: done.threadIds };
}
