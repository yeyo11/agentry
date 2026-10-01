/**
 * The pure model of merging a change request: which colour and word each blocker carries, what the
 * remedy is, which method is preselected, the body of the person's click and when the state is read
 * again. The item page and the orchestration page draw their merge block from here, so a blocker
 * means one thing on both. No React and no fetching: tested without a browser (test/merge.test.ts).
 *
 * Label keys are in the `merge` namespace: `t(key, params)` with `useTranslation('merge')`.
 */
import type { ChangeRequest, MergeBlocker, MergeBlockerAction, MergeBlockerCode, MergeMethod, MergeRequestBody, MergeState } from '@agentry/shared';
import { changeRequestWords } from './code-hosts';

/** `live` is the host working it out now: the only blockers that move, and only while it does. */
export type MergeTone = 'ok' | 'warn' | 'bad' | 'idle' | 'live';

/** The tone of each blocker, as the validated blocked-states sheet draws it. */
const TONE: Readonly<Record<MergeBlockerCode, MergeTone>> = {
  'not-open': 'idle',
  computing: 'live',
  draft: 'idle',
  conflicts: 'bad',
  'nothing-to-merge': 'warn',
  behind: 'warn',
  'checks-running': 'live',
  'checks-failing': 'bad',
  'checks-missing': 'warn',
  'external-checks': 'warn',
  'review-required': 'warn',
  'changes-requested': 'warn',
  'threads-unresolved': 'warn',
  'tracker-key-missing': 'warn',
  'title-rejected': 'warn',
  'blocked-by-dependency': 'warn',
  'not-yet': 'warn',
  'locked-files': 'warn',
  'merge-queue': 'warn',
  'blocked-by-policy': 'warn',
};

export interface BlockerMark {
  tone: MergeTone;
  /** The badge's word, which always goes with the colour */
  word: `blocker.${MergeBlockerCode}.word`;
  /** The sentence; its placeholders are the ones `blockerParams` fills */
  text: `blocker.${MergeBlockerCode}.text`;
}

/** A code this version does not know reads as the policy block: warn, with the host's rules in its words. */
export function blockerMark(code: MergeBlockerCode | string): BlockerMark {
  const known = Object.prototype.hasOwnProperty.call(TONE, code) ? (code as MergeBlockerCode) : 'blocked-by-policy';
  return { tone: TONE[known], word: `blocker.${known}.word`, text: `blocker.${known}.text` };
}

/** What a blocker's remedy does: an Agentry call, a link to the host, or a move inside the page. */
export type BlockerActionKind = 'call' | 'link' | 'page';

const ACTION_KIND: Readonly<Record<MergeBlockerAction, BlockerActionKind>> = {
  'mark-ready': 'call',
  'update-from-base': 'call',
  'rebase-on-host': 'call',
  close: 'call',
  'auto-merge': 'call',
  'fix-checks': 'call',
  'rerun-checks': 'call',
  'request-reviewers': 'page',
  'address-review': 'call',
  'show-threads': 'page',
  'edit-title': 'page',
  'open-on-host': 'link',
  refresh: 'call',
};

export const blockerActionKind = (action: MergeBlockerAction): BlockerActionKind => ACTION_KIND[action];

/** The label of a remedy button, with `{base}` and `{host}` filled by `blockerParams`. */
export const actionLabelKey = (action: MergeBlockerAction): `action.${MergeBlockerAction}` => `action.${action}`;

export interface BlockerParams extends Record<string, string> {
  noun: string;
  host: string;
  head: string;
  base: string;
  name: string;
  state: string;
}

/**
 * The words a blocker's sentence and remedy are written with. The host's text (`detail`) is
 * untrusted and is only ever interpolated as text: callers render the result, never inject it.
 * `noun` is the host's word ("PR" / "MR"), resolved by the caller from the `tasks` namespace.
 */
export function blockerParams(blocker: Pick<MergeBlocker, 'detail'>, cr: Pick<ChangeRequest, 'host' | 'branch' | 'base' | 'phase'>, noun: string): BlockerParams {
  const words = changeRequestWords(cr.host);
  return { noun, host: words.label, head: cr.branch, base: cr.base, name: blocker.detail ?? '', state: cr.phase };
}

/** The blockers shown: the first, with the rest under it in a line of codes. */
export function blockersOf(state: Pick<MergeState, 'blocker' | 'others'>): MergeBlocker[] {
  return state.blocker ? [state.blocker, ...state.others] : [];
}

/** A merge that is allowed but carries a notice: the optional checks that failed. */
export const hasMergeWarning = (state: Pick<MergeState, 'canMerge' | 'warning'>): boolean => state.canMerge && state.warning !== null;

/** Squash and merge commits carry the person's subject and body; a rebase has no commit of its own. */
export const methodHasMessage = (method: MergeMethod): boolean => method !== 'rebase';

/** The method on offer: the one the person chose while it is still allowed, else the repository's default. */
export function chosenMethod(state: Pick<MergeState, 'methods' | 'defaultMethod'>, chosen: MergeMethod | null | undefined): MergeMethod | null {
  if (chosen && state.methods.includes(chosen)) return chosen;
  return state.defaultMethod ?? state.methods[0] ?? null;
}

export interface MergeChoice {
  method: MergeMethod | null;
  deleteBranch: boolean;
  subject: string;
  body: string;
}

/**
 * The body of the Merge click, carrying the head the person is looking at. Null when there is
 * nothing to send: no head read yet, no method allowed, or Merge now is not possible. A blank
 * subject or body is left out so the host writes its own.
 */
export function mergeBody(state: Pick<MergeState, 'headSha' | 'canMerge' | 'methods' | 'defaultMethod'>, choice: MergeChoice): MergeRequestBody | null {
  const method = chosenMethod(state, choice.method);
  if (!state.canMerge || !state.headSha || !method) return null;
  const subject = choice.subject.trim();
  const body = choice.body.trim();
  return {
    method,
    expectedHead: state.headSha,
    deleteBranch: choice.deleteBranch,
    ...(methodHasMessage(method) && subject ? { subject } : {}),
    ...(methodHasMessage(method) && body ? { body } : {}),
  };
}

/** The body of arming auto-merge; null when the state does not offer it. */
export function armBody(
  state: Pick<MergeState, 'headSha' | 'autoMerge' | 'methods' | 'defaultMethod'>,
  chosen: MergeMethod | null,
): { method: MergeMethod; expectedHead: string } | null {
  const method = chosenMethod(state, chosen);
  if (!state.autoMerge.available || state.autoMerge.armed || !state.headSha || !method) return null;
  return { method, expectedHead: state.headSha };
}

/** Auto-merge is armed: the block shows who armed it, with which method, and Turn off. */
export const isArmed = (state: Pick<MergeState, 'autoMerge'> | undefined): boolean => state?.autoMerge.armed === true;

/** GitLab, head's pipeline not attached yet: the block shows the spinner next to the verb. */
export const isWaitingForPipeline = (state: Pick<MergeState, 'waitingForPipeline'> | undefined): boolean => state?.waitingForPipeline === true;

/** How often the state is read again while nothing tells us it moved; `false` leaves it to the event feed. */
export const PIPELINE_POLL_MS = 10_000;
export const COMPUTING_POLL_MS = 5_000;

export function mergeRefetchMs(state: Pick<MergeState, 'waitingForPipeline' | 'blocker'> | undefined): number | false {
  if (!state) return false;
  if (state.waitingForPipeline) return PIPELINE_POLL_MS;
  return state.blocker?.code === 'computing' ? COMPUTING_POLL_MS : false;
}

/** The refusals a merge click can answer with, each worded in the `merge` namespace under `failure.`. */
const FAILURES = [
  'head-moved',
  'method-not-allowed',
  'auto-merge-not-allowed',
  'auto-merge-not-needed',
  'waiting-for-pipeline',
  'rate-limited',
  'forbidden',
  'merge-failed',
] as const;
export type MergeFailure = (typeof FAILURES)[number];

/** The reason code of a failed call, or `merge-failed` for any other (the host's own text stays the detail). */
export function mergeFailure(code: string | undefined): MergeFailure {
  return (FAILURES as readonly string[]).includes(code ?? '') ? (code as MergeFailure) : 'merge-failed';
}

/** A moved head or a changed rule merges nothing: the state is read again before another click. */
export const needsReread = (failure: MergeFailure): boolean =>
  failure === 'head-moved' || failure === 'method-not-allowed' || failure === 'waiting-for-pipeline' || failure === 'auto-merge-not-needed';
