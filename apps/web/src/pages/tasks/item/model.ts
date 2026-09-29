/**
 * The pure part of a work item's page and of the New task form: how a history entry is told, how
 * comments and history interleave, how a diffstat is drawn, what "Work on it" may start on. No
 * React and no fetching, so it is tested without a browser (test/work-item-page.test.ts).
 *
 * Every key returned here is in the `workItem` namespace.
 */
import type {
  AcceptanceCriterion,
  PullRequestReadiness,
  ChangedFile,
  CodeHostId,
  FlowRun,
  ProviderMove,
  WorkItem,
  WorkItemAssignee,
  WorkItemCause,
  WorkItemComment,
  WorkItemHistoryCriterion,
  WorkItemHistoryEntry,
  WorkItemHistoryPullRequest,
  WorkItemHistoryRef,
  WorkItemHistoryValue,
  WorkItemLink,
  WorkItemRelation,
  WorkItemStatus,
} from '@agentry/shared';
import { WORK_ITEM_PR_CAUSE } from '@agentry/shared';
import { changeRequestRef, changeRequestWords } from '../../../lib/code-hosts';
import type en from '../../../i18n/locales/en/workItem.json';

// ---------- the person ----------

/**
 * What the person is called on a comment or a history entry: the part before the @ of the account
 * the CLI is signed in with, as the prototypes draw "yeyo" for yeyo@inmoseo.net. Null when there is
 * no account to read it from, and the page says "you" instead.
 */
export function personName(email: string | null | undefined): string | null {
  const local = email?.split('@')[0]?.trim();
  return local ? local : null;
}

/** The first six characters of a chat's id: how a chat is named where its title does not fit. */
export const shortId = (id: string | null | undefined): string => (id ?? '').slice(0, 6);

// ---------- history ----------

const isRef = (value: WorkItemHistoryValue): value is WorkItemHistoryRef => typeof value === 'object' && value !== null && !Array.isArray(value) && 'label' in value;

const isCriterion = (value: WorkItemHistoryValue): value is WorkItemHistoryCriterion =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'checked' in value && 'text' in value;

const isRelation = (value: WorkItemHistoryValue): value is WorkItemRelation =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value && 'item' in value;

const isAssignee = (value: WorkItemHistoryValue): value is WorkItemAssignee => typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value;

const isPullRequest = (value: WorkItemHistoryValue): value is WorkItemHistoryPullRequest =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'phase' in value && 'conflicts' in value;

/** The host's change request noun as the history writes it: "PR" or "MR", the same in every language. */
const hostNoun = (host: CodeHostId | undefined): string => (changeRequestWords(host).nounKey === 'pr.noun.mr' ? 'MR' : 'PR');

/** The host of a pull request entry, for the words of its cause; absent on any other change. */
export function historyPullRequestHost(entry: Pick<WorkItemHistoryEntry, 'to'>): CodeHostId | undefined {
  return isPullRequest(entry.to) ? entry.to.host : undefined;
}

const text = (value: WorkItemHistoryValue): string => (typeof value === 'string' ? value : '');

/** A key of the `workItem` namespace under `prefix`, checked against the English file. */
type KeyUnder<Prefix extends string> = `${Prefix}.${keyof (typeof en)[Prefix & keyof typeof en] & string}`;

export type HistoryKey = KeyUnder<'history'>;
export type CauseKey = KeyUnder<'cause'>;

/** What a history entry says, as a key and its values; `status`, `type` and `priority` values are ids the page translates. */
export interface HistoryLine {
  key: HistoryKey;
  values: Record<string, string>;
  /**
   * The value the sentence ends on, drawn in bold after it ("Moved from To do to **In progress**"):
   * kept out of the translated text so a title never goes through the translator's markup.
   */
  strong?: string;
  /** The glyph beside it: what kind of change it was */
  icon: 'created' | 'forward' | 'start' | 'done' | 'check' | 'edit' | 'relation' | 'link' | 'wait' | 'pr';
}

/** One entry told in a sentence. Values that name a column, a type or a priority are left as ids. */
export function historyLine(entry: Pick<WorkItemHistoryEntry, 'change' | 'from' | 'to'>): HistoryLine {
  const { from, to } = entry;
  switch (entry.change) {
    case 'created':
      return { key: 'history.created', values: {}, icon: 'created' };
    case 'status': {
      const target = text(to) as WorkItemStatus;
      const icon = target === 'done' ? 'done' : target === 'in_progress' ? 'start' : 'forward';
      return { key: 'history.status', values: { from: text(from), to: target }, strong: 'to', icon };
    }
    case 'type':
      return { key: 'history.type', values: { to: text(to) }, strong: 'to', icon: 'edit' };
    case 'title':
      return { key: 'history.title', values: { to: text(to) }, strong: 'to', icon: 'edit' };
    case 'description':
      return { key: 'history.description', values: {}, icon: 'edit' };
    case 'priority':
      return { key: 'history.priority', values: { to: text(to) }, strong: 'to', icon: 'edit' };
    case 'labels': {
      const labels = Array.isArray(to) ? to : [];
      return labels.length ? { key: 'history.labels', values: { to: labels.join(', ') }, strong: 'to', icon: 'edit' } : { key: 'history.labelsCleared', values: {}, icon: 'edit' };
    }
    case 'assignee':
      if (!isAssignee(to)) return { key: 'history.unassigned', values: {}, icon: 'edit' };
      return to.kind === 'role'
        ? { key: 'history.assignedRole', values: { role: to.role }, strong: 'role', icon: 'edit' }
        : { key: 'history.assignedPerson', values: {}, strong: 'person', icon: 'edit' };
    case 'epic':
      if (isRef(to)) return { key: 'history.epic', values: { to: to.label }, strong: 'to', icon: 'edit' };
      return { key: 'history.epicRemoved', values: { from: isRef(from) ? from.label : '' }, strong: 'from', icon: 'edit' };
    case 'milestone':
      if (isRef(to)) return { key: 'history.milestone', values: { to: to.label }, strong: 'to', icon: 'edit' };
      return { key: 'history.milestoneRemoved', values: { from: isRef(from) ? from.label : '' }, strong: 'from', icon: 'edit' };
    case 'criterion': {
      if (!isCriterion(from) && isCriterion(to)) return { key: 'history.criterionAdded', values: { text: to.text }, strong: 'text', icon: 'edit' };
      if (isCriterion(from) && !isCriterion(to)) return { key: 'history.criterionRemoved', values: { text: from.text }, strong: 'text', icon: 'edit' };
      if (isCriterion(from) && isCriterion(to)) {
        if (from.checked !== to.checked)
          return { key: to.checked ? 'history.criterionChecked' : 'history.criterionUnchecked', values: { text: to.text }, strong: 'text', icon: 'check' };
        return { key: 'history.criterionEdited', values: { text: to.text }, strong: 'text', icon: 'edit' };
      }
      return { key: 'history.criterionEdited', values: { text: '' }, icon: 'edit' };
    }
    case 'relation': {
      if (isRelation(to)) return { key: to.type === 'blocks' ? 'history.blocks' : 'history.blockedBy', values: { key: to.item.key }, strong: 'key', icon: 'relation' };
      if (isRelation(from)) return { key: from.type === 'blocks' ? 'history.unblocks' : 'history.unblockedBy', values: { key: from.item.key }, strong: 'key', icon: 'relation' };
      return { key: 'history.relation', values: {}, icon: 'relation' };
    }
    case 'link':
      if (isRef(to)) return { key: 'history.linked', values: { name: to.label }, strong: 'name', icon: 'link' };
      return { key: 'history.unlinked', values: { name: isRef(from) ? from.label : '' }, strong: 'name', icon: 'link' };
    case 'waiting':
      if (typeof to === 'string' && to)
        return { key: to === 'bounces' ? 'history.waitingBounces' : to === 'merge' ? 'history.waitingMerge' : 'history.waitingApproval', values: {}, icon: 'wait' };
      return { key: 'history.waitingEnded', values: {}, icon: 'wait' };
    case 'pull_request':
      return pullRequestLine(to);
    case 'comment':
      return { key: 'history.comment', values: {}, icon: 'edit' };
  }
}

/** A pull request's entry: its number (bold) where it has one, the conflicting files when it conflicted. */
function pullRequestLine(to: WorkItemHistoryValue): HistoryLine {
  if (!isPullRequest(to)) return { key: 'history.prChanged', values: { noun: hostNoun(undefined) }, icon: 'pr' };
  const noun = hostNoun(to.host);
  const number = changeRequestRef(to.host, to.number, to.ref) ?? undefined;
  const withNumber = (key: HistoryKey, icon: HistoryLine['icon'] = 'pr'): HistoryLine =>
    number ? { key, values: { noun, number }, strong: 'number', icon } : { key, values: { noun }, icon };
  switch (to.phase) {
    case 'open':
      return withNumber('history.prOpened');
    case 'merged':
      return withNumber('history.prMerged', 'done');
    case 'closed':
      return withNumber('history.prClosed');
    case 'conflict':
      return to.conflicts.length
        ? { key: 'history.prConflict', values: { files: to.conflicts.join(', ') }, strong: 'files', icon: 'pr' }
        : { key: 'history.prChanged', values: { noun }, icon: 'pr' };
    case 'failed':
      return { key: 'history.prFailed', values: { noun }, icon: 'pr' };
    case 'preparing':
      return { key: 'history.prPreparing', values: { noun }, icon: 'pr' };
    case 'awaiting-verify':
      return { key: 'history.prAwaiting', values: { noun }, icon: 'pr' };
  }
}

/**
 * Who made a change, and why when it was automatic: "yeyo", "automatic · chat 4c1d0e started". A
 * cause code this version does not know still says the change was automatic.
 */
export interface ActorLine {
  key: CauseKey;
  values: Record<string, string>;
}

const CAUSE_KEY: Record<string, CauseKey> = {
  'chat.started': 'cause.chatStarted',
  'chat.turn-completed': 'cause.turnCompleted',
  'chat.message': 'cause.message',
  'orchestration.task.started': 'cause.taskStarted',
  'orchestration.task.completed': 'cause.taskCompleted',
  [WORK_ITEM_PR_CAUSE.opened]: 'cause.prOpened',
  [WORK_ITEM_PR_CAUSE.conflict]: 'cause.prConflict',
  [WORK_ITEM_PR_CAUSE.merged]: 'cause.prMerged',
  [WORK_ITEM_PR_CAUSE.closed]: 'cause.prClosed',
};

export function causeLine(cause: Pick<WorkItemCause, 'event' | 'chatId'> | null, host?: CodeHostId): ActorLine | null {
  if (!cause) return null;
  const key = CAUSE_KEY[cause.event];
  return key ? { key, values: { chat: shortId(cause.chatId), noun: hostNoun(host), host: changeRequestWords(host).label } } : { key: 'cause.other', values: {} };
}

// ---------- activity: comments and history interleaved ----------

export type ActivityFilter = 'all' | 'comments' | 'history';

/** A flow run and the move that took it to another provider. */
export interface MovedRun {
  run: FlowRun;
  move: ProviderMove;
}

/**
 * The moves of an item's runs to another provider, oldest first. A wait is not a move, and neither
 * is a move that never made its new chat; the run itself says that it waits.
 */
export function movedRunsOf(runs: readonly FlowRun[], moves: readonly ProviderMove[]): MovedRun[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const found: MovedRun[] = [];
  for (const move of moves) {
    if (move.subjectKind !== 'flow_run' || move.toChat === null || move.toProvider === null || move.action === 'wait') continue;
    const run = byId.get(move.subjectId);
    if (run) found.push({ run, move });
  }
  return found.sort((a, b) => a.move.at.localeCompare(b.move.at));
}

export type ActivityEntry =
  | { kind: 'history'; at: string; entry: WorkItemHistoryEntry }
  | { kind: 'comment'; at: string; comment: WorkItemComment }
  | { kind: 'retry'; at: string; run: FlowRun }
  /** A run that went on in a new chat on another provider after a limit */
  | { kind: 'moved'; at: string; run: FlowRun; move: ProviderMove };

/**
 * Oldest first, as the page reads top to bottom. The history's `created` entry opens it; a comment
 * and a change at the same instant keep the change first, since the comment usually explains it.
 * A person's retries of a flow run (`retries`) are history the core does not write: they read as
 * entries of it, at the moment each was queued.
 */
export function activityOf(
  history: readonly WorkItemHistoryEntry[],
  comments: readonly WorkItemComment[],
  filter: ActivityFilter = 'all',
  retries: readonly FlowRun[] = [],
  moved: readonly MovedRun[] = [],
): ActivityEntry[] {
  const entries: ActivityEntry[] = [
    ...(filter === 'comments' ? [] : history.map((entry) => ({ kind: 'history' as const, at: entry.createdAt, entry }))),
    ...(filter === 'comments' ? [] : retries.map((run) => ({ kind: 'retry' as const, at: run.queuedAt, run }))),
    ...(filter === 'comments' ? [] : moved.map(({ run, move }) => ({ kind: 'moved' as const, at: move.at, run, move }))),
    ...(filter === 'history' ? [] : comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment }))),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || (a.entry.kind === b.entry.kind ? a.index - b.index : a.entry.kind === 'comment' ? 1 : b.entry.kind === 'comment' ? -1 : a.index - b.index))
    .map(({ entry }) => entry);
}

// ---------- the checklist ----------

export function criteriaProgress(criteria: readonly Pick<AcceptanceCriterion, 'checked'>[]): { done: number; total: number } {
  return { done: criteria.filter((c) => c.checked).length, total: criteria.length };
}

// ---------- changes ----------

/**
 * The five dots of a file's diffstat, as the prototype draws them: how many are filled grows with
 * the size of the change (on a log scale, so a 500-line file does not dwarf the rest), and the
 * filled ones split between added and removed in proportion. No status colours.
 */
export function diffstat(file: Pick<ChangedFile, 'additions' | 'deletions'>): Array<'add' | 'del' | 'none'> {
  const total = file.additions + file.deletions;
  const filled = total === 0 ? 0 : Math.min(5, Math.max(1, Math.round(Math.log2(total + 1) * 0.7)));
  const add = total === 0 ? 0 : Math.round((filled * file.additions) / total);
  return Array.from({ length: 5 }, (_, i) => (i < add ? 'add' : i < filled ? 'del' : 'none'));
}

/**
 * A path cut at its slashes so a narrow column wraps it there and keeps the file name whole
 * (`.path.wrap` in the prototype): every part but the last ends with its slash.
 */
export function pathParts(path: string): { dirs: string[]; name: string } {
  const parts = path.split('/');
  const name = parts.pop() ?? path;
  return { dirs: parts.map((part) => `${part}/`), name };
}

// ---------- links ----------

/**
 * What the link did to the item, read from the history the store wrote with the link as the cause:
 * the last column it moved the item to, or that it moved nothing. An origin link made the item.
 */
export function linkEffect(
  link: Pick<WorkItemLink, 'kind' | 'role' | 'chatId' | 'taskId' | 'orchestrationId'>,
  history: readonly Pick<WorkItemHistoryEntry, 'change' | 'to' | 'cause'>[],
): { key: 'link.origin' | 'link.moved' | 'link.noMove'; values: Record<string, string> } {
  if (link.role === 'origin') return { key: 'link.origin', values: {} };
  const own = (cause: WorkItemCause | null) =>
    cause !== null && (link.kind === 'orchestration' ? cause.orchestrationId === link.orchestrationId && cause.taskId === link.taskId : cause.chatId === link.chatId);
  const moves = history.filter((entry) => entry.change === 'status' && own(entry.cause));
  const last = moves.at(-1);
  return last && typeof last.to === 'string' ? { key: 'link.moved', values: { to: last.to } } : { key: 'link.noMove', values: {} };
}

/**
 * The flow run a chat link was made for: the newest of the item's runs in that chat (`GET
 * /work-items/:itemId/runs`, newest first). A failed run leaves its chat looking finished
 * ("completed") and the item unmoved, so this is what says it failed, for every run of the item and
 * not only a member's latest. A newer run going on in the same chat is what the link shows. Null for
 * a chat the flow did not run.
 */
export function linkRun<R extends Pick<FlowRun, 'chatId' | 'state' | 'outcome' | 'error'>>(link: Pick<WorkItemLink, 'kind' | 'chatId'>, runs: readonly R[]): R | null {
  if (link.kind !== 'chat' || !link.chatId) return null;
  return runs.find((run) => run.chatId === link.chatId) ?? null;
}

/**
 * The item's flow runs that no chat link stands for: queued ones, and those that ended before a chat
 * started (no account had quota, the chat did not start). They acted on the item too, so its links
 * list them, a failed one with its reason, rather than leaving the board strip their only trace.
 */
export function chatlessRuns<R extends Pick<FlowRun, 'chatId'>>(links: readonly Pick<WorkItemLink, 'kind' | 'chatId'>[], runs: readonly R[]): R[] {
  const chats = new Set(links.flatMap((link) => (link.kind === 'chat' && link.chatId ? [link.chatId] : [])));
  return runs.filter((run) => !run.chatId || !chats.has(run.chatId));
}

/**
 * The rows of an item's links, newest first: one per flow run, and one per link no run stands for.
 * The Developer continues its own chat from one run to the next (a retry, a round QA sent back), so
 * a chat can hold several runs; each is a row of its own on that chat's link, or a failure the
 * newest run in the chat covers would vanish from the item (CW-20, on claude-wrapper's real data).
 * A run with no chat link (queued, or failed before its chat started) is a row without a link.
 * `runs` is null until the item's runs have answered: a flow's chat link is left out meanwhile,
 * since drawn as a plain chat it would read "idle" with no squircle and then turn into its runs.
 */
export function linkEntries<L extends Pick<WorkItemLink, 'kind' | 'chatId' | 'teamRole' | 'createdAt'>, R extends Pick<FlowRun, 'id' | 'chatId' | 'queuedAt'>>(
  links: readonly L[],
  runs: readonly R[] | null,
): { at: string; link: L | null; run: R | null }[] {
  if (runs === null) return links.filter((link) => !link.teamRole).map((link) => ({ at: link.createdAt, link, run: null })).sort((a, b) => b.at.localeCompare(a.at));
  const drawn = new Set<string>();
  const entries: { at: string; link: L | null; run: R | null }[] = [];
  for (const link of links) {
    const own = link.teamRole && link.kind === 'chat' && link.chatId ? runs.filter((run) => run.chatId === link.chatId && !drawn.has(run.id)) : [];
    for (const run of own) {
      drawn.add(run.id);
      entries.push({ at: run.queuedAt, link, run });
    }
    if (own.length === 0) entries.push({ at: link.createdAt, link, run: null });
  }
  for (const run of chatlessRuns(links, runs)) entries.push({ at: run.queuedAt, link: null, run });
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

// ---------- actions ----------

/**
 * Why "Work on it" cannot start, as the API would refuse it, so the button says so before anyone
 * presses it: an epic groups work and is not worked on, an item in Done stays there, and an item a
 * chat or a node is already on has its chat to go to. Null when it can start.
 */
export function workOnBlocker(item: Pick<WorkItem, 'type' | 'status' | 'activeLink'>): 'epic' | 'done' | 'busy' | null {
  if (item.type === 'epic') return 'epic';
  if (item.status === 'done') return 'done';
  if (item.activeLink && (item.activeLink.chatState === 'working' || item.activeLink.chatState === 'waiting' || item.activeLink.taskStatus === 'running')) return 'busy';
  return null;
}

/**
 * What the item's page says about its pull request (docs/plans/work-item-pull-requests.md), in the
 * panel beside the waiting one: the PR being prepared, a conflict, an approval kept until QA passes,
 * an open PR waiting for the person's merge, one closed or failed, a merged one whose worktree was
 * kept; or, for an item in In review with nothing working on it, the offer to open one, or why the
 * project cannot. Null when there is nothing to say. Each phase speaks only in the column it leaves
 * the item in, as on the card's strip.
 */
export type PullRequestPanel = 'preparing' | 'conflict' | 'awaiting' | 'merge' | 'closed' | 'failed' | 'kept' | 'offer' | 'not-ready';

type PanelItem = Pick<WorkItem, 'type' | 'status' | 'waiting' | 'activeLink' | 'pullRequest'>;

export function pullRequestPanel(item: PanelItem, readiness: Pick<PullRequestReadiness, 'status'> | null | undefined): PullRequestPanel | null {
  const pr = item.pullRequest ?? null;
  if (item.status === 'done') return pr?.phase === 'merged' && pr.error?.code === 'worktree-kept' ? 'kept' : null;
  if (item.waiting === 'merge' || pr?.phase === 'open') return 'merge';
  if (pr?.phase === 'preparing') return 'preparing';
  if (pr?.phase === 'conflict' && item.status === 'in_progress') return 'conflict';
  if (pr?.phase === 'awaiting-verify' && (item.status === 'in_progress' || item.status === 'in_review')) return 'awaiting';
  if (item.status !== 'in_review' || item.type === 'epic' || workOnBlocker(item) === 'busy') return null;
  if (pr?.phase === 'closed' && item.waiting !== 'bounces') return 'closed';
  if (pr?.phase === 'failed' && item.waiting !== 'bounces') return 'failed';
  if (!readiness) return null;
  return readiness.status === 'ready' ? 'offer' : 'not-ready';
}

/**
 * The button the panel offers: "Approve and open PR" where the item waits for the person's approval
 * (QA passed it, or its PR closed or failed), "Open PR" on any other item in In review. Both call
 * `POST /work-items/:itemId/pull-request`, and only in a ready project; "Move to Done" stays in the
 * head as the person's own way out.
 */
export function pullRequestAction(item: Pick<WorkItem, 'waiting'>, panel: PullRequestPanel | null, readiness: Pick<PullRequestReadiness, 'status'> | null | undefined): 'approve' | 'open' | null {
  if (readiness?.status !== 'ready') return null;
  if (panel === 'closed' || panel === 'failed') return 'approve';
  if (panel === 'offer') return item.waiting === 'approval' ? 'approve' : 'open';
  return null;
}

/** Criteria still unchecked: moving to Done with any asks first, since Done means every one is met. */
export function uncheckedCriteria(item: Pick<WorkItem, 'acceptanceCriteria'>): { unchecked: number; total: number } {
  const total = item.acceptanceCriteria.length;
  return { unchecked: item.acceptanceCriteria.filter((c) => !c.checked).length, total };
}

/** Deleting an item a chat or a node is working on leaves that work without its task: the confirmation says so. */
export function deleteWarning(item: Pick<WorkItem, 'activeLink'>): 'working' | null {
  return item.activeLink && (item.activeLink.chatState === 'working' || item.activeLink.chatState === 'waiting' || item.activeLink.taskStatus === 'running') ? 'working' : null;
}

// ---------- the New task form ----------

/** A label typed in the form: trimmed, and the same label twice (case folded) kept once. */
export function addLabel(labels: readonly string[], typed: string): string[] {
  const label = typed.trim().replace(/,+$/, '').trim();
  if (!label) return [...labels];
  const folded = label.toLocaleLowerCase();
  return labels.some((l) => l.toLocaleLowerCase() === folded) ? [...labels] : [...labels, label];
}

/** The criteria worth sending: the blank rows a person added and never filled are left out. */
export function cleanCriteria(rows: readonly string[]): Array<{ text: string }> {
  return rows
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => ({ text: row }));
}

// ---------- the one gradient action of the pull request zone ----------

/** The actions of the pull request zone that carry the gradient, oldest first. */
export type LeadingAction = 'push' | 'publish' | 'reply' | 'submit' | 'fix' | 'merge';

export interface LeadingFacts {
  /** A fix's commit waits for the person's push (Push the fix, Push review fixes) */
  pushWaiting: boolean;
  /** A review that stopped half way waits for Publish */
  publishWaiting: boolean;
  /** Review threads wait for Reply and resolve after a pushed fix */
  replyWaiting: boolean;
  /** The person has a draft review */
  drafts: number;
  /** Fix failing checks is on the page */
  fixOffered: boolean;
  /** The merge block offers Merge, or arming auto-merge, as its action */
  mergeOffered: boolean;
}

/**
 * The zone's ONE gradient action. What has waited longest leads: a push or a publish that is
 * pending, the reply to the threads a pushed fix answered, then Submit review, Fix failing checks
 * and last Merge. Every other button of the zone, and the header's Work on it, renders neutral.
 */
export function leadingAction(facts: LeadingFacts): LeadingAction | null {
  if (facts.pushWaiting) return 'push';
  if (facts.publishWaiting) return 'publish';
  if (facts.replyWaiting) return 'reply';
  if (facts.drafts > 0) return 'submit';
  if (facts.fixOffered) return 'fix';
  if (facts.mergeOffered) return 'merge';
  return null;
}
