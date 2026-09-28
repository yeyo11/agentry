/**
 * The pure part of a work item's page and of the New task form: how a history entry is told, how
 * comments and history interleave, how a diffstat is drawn, what "Work on it" may start on. No
 * React and no fetching, so it is tested without a browser (test/work-item-page.test.ts).
 *
 * Every key returned here is in the `workItem` namespace.
 */
import type {
  AcceptanceCriterion,
  ChangedFile,
  FlowRun,
  WorkItem,
  WorkItemAssignee,
  WorkItemCause,
  WorkItemComment,
  WorkItemHistoryCriterion,
  WorkItemHistoryEntry,
  WorkItemHistoryRef,
  WorkItemHistoryValue,
  WorkItemLink,
  WorkItemRelation,
  WorkItemStatus,
} from '@agentry/shared';
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
  icon: 'created' | 'forward' | 'start' | 'done' | 'check' | 'edit' | 'relation' | 'link' | 'wait';
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
      if (typeof to === 'string' && to) return { key: to === 'bounces' ? 'history.waitingBounces' : 'history.waitingApproval', values: {}, icon: 'wait' };
      return { key: 'history.waitingEnded', values: {}, icon: 'wait' };
    case 'comment':
      return { key: 'history.comment', values: {}, icon: 'edit' };
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
};

export function causeLine(cause: Pick<WorkItemCause, 'event' | 'chatId'> | null): ActorLine | null {
  if (!cause) return null;
  const key = CAUSE_KEY[cause.event];
  return key ? { key, values: { chat: shortId(cause.chatId) } } : { key: 'cause.other', values: {} };
}

// ---------- activity: comments and history interleaved ----------

export type ActivityFilter = 'all' | 'comments' | 'history';

export type ActivityEntry =
  | { kind: 'history'; at: string; entry: WorkItemHistoryEntry }
  | { kind: 'comment'; at: string; comment: WorkItemComment }
  | { kind: 'retry'; at: string; run: FlowRun };

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
): ActivityEntry[] {
  const entries: ActivityEntry[] = [
    ...(filter === 'comments' ? [] : history.map((entry) => ({ kind: 'history' as const, at: entry.createdAt, entry }))),
    ...(filter === 'comments' ? [] : retries.map((run) => ({ kind: 'retry' as const, at: run.queuedAt, run }))),
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

/** Newest first: the chat working now, then the ones before it. */
export function sortLinks<T extends Pick<WorkItemLink, 'createdAt'>>(links: readonly T[]): T[] {
  return [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
