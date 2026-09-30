import type { DatabaseSync } from 'node:sqlite';
import type { AgentryEvent, DecisionAnswer, DecisionPointId, DecisionRecord, DecisionResolution } from '@agentry/shared';
import { TTL_SECONDS } from '../push.ts';

/*
 * Shadow accuracy (docs/plans/decision-engine.md, "Shadow accuracy"). Each point has a resolver that
 * reads the signal the app already produces (a flow run ending, a proposal decided, a task's
 * status) and says whether the answer matched what happened. A resolver returns null while the
 * outcome is not known yet, so the row stays unresolved and does not count. The person's
 * useful / not useful outranks the inference: the store leaves `agreed` alone once there is feedback.
 *
 * Only what a point flagged is judged for the suggest points: "not flagged" says nothing that a
 * later event could confirm or refute.
 */

type Sql = DatabaseSync;
type Resolver = (row: DecisionRecord, sql: Sql, now: number) => DecisionResolution | null;

const PERSON = 'person';

/** How long a push lives at the push service: a notification not opened by then was not opened soon */
const NOTIFICATION_WINDOW_MS = TTL_SECONDS * 1000;

/** A task in one of these may still change, so the row waits */
const STILL_GOING = new Set(['pending', 'running', 'blocked', 'interrupted']);

const FAMILIES = ['haiku', 'sonnet', 'opus'];
const rankOf = (model: string | null): number => (model ? FAMILIES.findIndex((f) => model.toLowerCase().includes(f)) : -1);

/** Whether the suggestion was right for a task that ended; null when this task says nothing about it */
function modelVerdict(suggested: string, launched: string | null, kept: boolean, completed: boolean): boolean | null {
  if (kept) return completed;
  const s = rankOf(suggested);
  const l = rankOf(launched);
  if (s < 0 || l < 0 || s === l) return null;
  // A stronger model was suggested and the task failed: the suggestion was right. If it completed anyway, it was not needed
  if (s > l) return completed ? false : true;
  // A weaker one was suggested and the task failed: the suggestion was wrong; if it completed, it proves nothing
  return completed ? null : false;
}

const verdict = (agreed: boolean, summary: string, detail?: Record<string, unknown>): DecisionResolution => ({ agreed, summary, ...(detail ? { detail } : {}) });

const choiceOf = (row: DecisionRecord, id: string): string | null => {
  const answer: DecisionAnswer | undefined = row.answers?.[id];
  return answer?.kind === 'choice' ? answer.value : null;
};
const scoreOf = (answer: DecisionAnswer | undefined): string | null => (answer?.kind === 'score' ? answer.value : null);
const yes = (answer: DecisionAnswer | undefined): boolean => answer?.kind === 'noul' && answer.value;
const flagged = (row: DecisionRecord): string[] => Object.entries(row.answers ?? {}).filter(([, a]) => yes(a)).map(([id]) => id);

interface RunRow {
  id: string;
  item_id: string;
  chat_id: string | null;
  stage: string;
  role: string;
  state: string;
  outcome: string | null;
  cause: string | null;
  retry_of: string | null;
  seq: number;
  ended_at: string | null;
}

const runById = (sql: Sql, id: string | null): RunRow | null => (id ? ((sql.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as RunRow | undefined) ?? null) : null);

/** The first run of a stage that ended on the card after `since`, with an outcome */
function endedAfter(sql: Sql, itemId: string, stage: string, since: string, afterSeq = 0): RunRow | null {
  return (
    (sql
      .prepare("SELECT * FROM flow_runs WHERE item_id = ? AND stage = ? AND state = 'ended' AND outcome IN ('passed', 'rejected') AND ended_at > ? AND seq > ? ORDER BY seq LIMIT 1")
      .get(itemId, stage, since, afterSeq) as RunRow | undefined) ?? null
  );
}

interface HistoryRow {
  change: string;
  from_value: string | null;
  to_value: string | null;
  actor_kind: string;
  created_at: string;
}

const historyAfter = (sql: Sql, itemId: string, since: string, changes: string[]): HistoryRow[] =>
  sql
    .prepare(`SELECT change, from_value, to_value, actor_kind, created_at FROM work_item_history WHERE item_id = ? AND created_at > ? AND change IN (${changes.map(() => '?').join(',')}) ORDER BY seq`)
    .all(itemId, since, ...changes) as unknown as HistoryRow[];

const parse = (value: string | null): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

interface TaskRef {
  status: string;
  attempts: number;
  continuations: number;
  verification: string | null;
}

/** `<orchestration id>:<task id>`, as the orchestrator's points use it as a subject */
function taskOf(sql: Sql, subjectId: string | null): TaskRef | null {
  if (!subjectId) return null;
  const at = subjectId.indexOf(':');
  if (at < 0) return null;
  const found = sql.prepare('SELECT json FROM orchestrations WHERE id = ?').get(subjectId.slice(0, at)) as { json: string } | undefined;
  const orch = found ? parse(found.json) : null;
  if (!orch) return null;
  const taskId = subjectId.slice(at + 1);
  const verification = (orch.verification as { status?: string } | null | undefined)?.status ?? null;
  if (taskId === '__verification__') return { status: String(orch.status ?? ''), attempts: 0, continuations: 0, verification };
  const task = (orch.tasks as Array<Record<string, unknown>> | undefined)?.find((t) => t.id === taskId);
  if (!task) return null;
  return { status: String(task.status ?? ''), attempts: Number(task.attempts ?? 0), continuations: Number(task.continuations ?? 0), verification };
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

/** The verify run that follows what the row was about: passed or rejected, whichever came first */
function nextVerify(sql: Sql, itemId: string, since: string, afterSeq = 0): RunRow | null {
  return endedAfter(sql, itemId, 'verify', since, afterSeq);
}

/** The work item a chat belongs to, through the flow run that owns the chat */
function itemOfChat(sql: Sql, chatId: string | null): string | null {
  if (!chatId) return null;
  const run = sql.prepare("SELECT item_id FROM flow_runs WHERE chat_id = ? AND stage = 'work' ORDER BY seq DESC LIMIT 1").get(chatId) as { item_id: string } | undefined;
  return run?.item_id ?? null;
}

const RESOLVERS: Partial<Record<DecisionPointId, Resolver>> = {
  'flow.refine-needed': (row, sql) => {
    const itemId = row.subjectId;
    const answer = choiceOf(row, 'refine');
    if (!itemId || !answer) return null;
    const edits = historyAfter(sql, itemId, row.at, ['description', 'criterion']);
    if (answer === 'refine') {
      const refine = endedAfter(sql, itemId, 'refine', row.at);
      if (!refine?.ended_at) return null;
      const changed = edits.some((e) => e.created_at <= (refine.ended_at ?? ''));
      return verdict(changed, changed ? 'The refine changed the description or the criteria' : 'The refine changed nothing', { refine: refine.outcome });
    }
    const verify = nextVerify(sql, itemId, row.at);
    if (!verify) return null;
    const editedByPerson = edits.some((e) => e.actor_kind === PERSON);
    const right = verify.outcome === 'passed' && !editedByPerson;
    return verdict(right, right ? 'The card was built as written and QA passed it' : 'The card was rejected or a person rewrote it', { verify: verify.outcome, editedByPerson });
  },

  'flow.criteria-precheck': (row, sql) => {
    const itemId = row.subjectId;
    if (!itemId || !row.answers) return null;
    const unmet = Object.entries(row.answers).filter(([, a]) => a.kind === 'choice' && a.value === 'clearly-unmet').map(([id]) => id);
    const verify = nextVerify(sql, itemId, row.at);
    if (!verify) return null;
    const rejected = verify.outcome === 'rejected';
    return verdict(rejected === unmet.length > 0, rejected ? 'QA rejected the card' : 'QA passed the card', { unmet: unmet.length, verify: verify.outcome });
  },

  'flow.bounce': (row, sql) => {
    const answer = choiceOf(row, 'bounce');
    const run = runById(sql, row.subjectId);
    if (!run || !answer) return null;
    const next = nextVerify(sql, run.item_id, row.at, run.seq);
    const people = historyAfter(sql, run.item_id, row.at, ['status', 'description', 'criterion', 'waiting']).some((e) => e.actor_kind === PERSON);
    if (answer === 'fixable') {
      if (!next) return null;
      return verdict(next.outcome === 'passed', next.outcome === 'passed' ? 'The next QA run passed' : 'The next QA run rejected it again', { next: next.outcome });
    }
    const waiting = sql.prepare('SELECT waiting FROM work_items WHERE id = ?').get(run.item_id) as { waiting: string | null } | undefined;
    if (waiting?.waiting === 'bounces' || people) return verdict(true, 'The card waited for a person', { waiting: waiting?.waiting ?? null, person: people });
    if (!next) return null;
    return verdict(next.outcome !== 'passed', next.outcome === 'passed' ? 'A bounce was enough: the next QA run passed' : 'The next QA run rejected it again', { next: next.outcome });
  },

  'flow.restart': (row, sql) => {
    const requeue = row.answers?.requeue;
    const run = runById(sql, row.subjectId);
    if (!run || !requeue) return null;
    // The requeued run is the same row started again, or one it was retried as
    const later = sql
      .prepare("SELECT * FROM flow_runs WHERE (id = ? OR retry_of = ?) AND state = 'ended' AND ended_at > ? AND COALESCE(cause, '') != 'restarts' ORDER BY seq LIMIT 1")
      .get(run.id, run.id, row.at) as RunRow | undefined;
    if (!later) return null;
    const failedAgain = later.outcome === 'failed' || later.outcome === 'rejected';
    const doNotRequeue = requeue.kind === 'noul' && !requeue.value;
    return verdict(doNotRequeue === failedAgain, failedAgain ? 'The requeued run failed again' : 'The requeued run finished', { outcome: later.outcome });
  },

  'flow.criteria-merge': (row, sql) => {
    const flags = flagged(row);
    const run = runById(sql, row.subjectId);
    if (!run || flags.length === 0) return null;
    const removed = historyAfter(sql, run.item_id, row.at, ['criterion']).filter((e) => e.actor_kind === PERSON && e.from_value !== null && (e.to_value === null || (parse(e.to_value)?.text !== parse(e.from_value)?.text)));
    if (removed.length > 0) return verdict(true, 'A person removed or edited a merged criterion', { removed: removed.length });
    const item = sql.prepare('SELECT status FROM work_items WHERE id = ?').get(run.item_id) as { status: string } | undefined;
    return item?.status === 'done' ? verdict(false, 'The card was finished with the flagged criteria untouched') : null;
  },

  'team.assign': (row, sql) => {
    const itemId = row.subjectId;
    const proposed = choiceOf(row, 'member');
    if (!itemId || !proposed) return null;
    const assigned = typeof row.state.assigned === 'string' ? row.state.assigned : null;
    const moves = historyAfter(sql, itemId, row.at, ['assignee']).filter((e) => e.actor_kind === PERSON);
    const last = moves[moves.length - 1];
    if (last) {
      const to = parse(last.to_value)?.role;
      return verdict(to === proposed, to === proposed ? 'A person reassigned the card to the proposed member' : 'A person reassigned it elsewhere', { to: to ?? null });
    }
    // Same as the column's member: nothing to compare until a person disagrees, so the card's end counts
    const verify = nextVerify(sql, itemId, row.at);
    if (!verify) return null;
    if (proposed === assigned) return verdict(verify.outcome === 'passed', verify.outcome === 'passed' ? 'The fixed member did the work and QA passed it' : 'The fixed member was rejected', { verify: verify.outcome });
    return verdict(verify.outcome !== 'passed', verify.outcome === 'passed' ? 'The fixed member succeeded where another was proposed' : 'The fixed member was rejected where another was proposed', { verify: verify.outcome });
  },

  'run.continuation': (row, sql) => {
    const report = choiceOf(row, 'report');
    if (!report) return null;
    const owes = report === 'owes-work';
    if (row.subjectKind === 'task') {
      const task = taskOf(sql, row.subjectId);
      if (!task || (task.status !== 'completed' && task.status !== 'failed')) return null;
      const completed = task.status === 'completed';
      return verdict(owes !== completed, completed ? 'The task completed' : 'The task failed', { status: task.status, continuations: task.continuations, proxy: 'task-status' });
    }
    const run = runById(sql, row.subjectId);
    if (!run || run.state !== 'ended' || !run.outcome || run.outcome === 'cancelled') return null;
    // A work run is judged by the QA run after it; another stage by its own outcome
    const outcome = run.stage === 'work' ? nextVerify(sql, run.item_id, row.at, run.seq)?.outcome : run.outcome;
    if (!outcome) return null;
    const good = outcome === 'passed';
    return verdict(owes !== good, good ? 'Nothing was left undone' : 'Work was left undone', { outcome, proxy: 'stage-outcome' });
  },

  'orchestration.retry': (row, sql) => {
    const answer = choiceOf(row, 'retry');
    const task = taskOf(sql, row.subjectId);
    if (!answer || !task || (task.status !== 'completed' && task.status !== 'failed')) return null;
    const asked = ORDINALS.indexOf(String(row.state.attempt ?? '').split(' ')[0] ?? '') + 1;
    // A permanent answer that was acted on left no retry to compare with
    if (asked === 0 || task.attempts <= asked) return null;
    const completed = task.status === 'completed';
    return verdict(answer === 'permanent' ? !completed : completed, completed ? 'A retry completed' : 'Every retry failed', { attempts: task.attempts });
  },

  'orchestration.fixer': (row, sql) => {
    const again = row.answers?.['another-attempt'];
    const task = taskOf(sql, row.subjectId);
    // A stop that was acted on ended the verification itself, so there is nothing to compare with
    if (!again || row.acted || !task?.verification || (task.verification !== 'passed' && task.verification !== 'fixed' && task.verification !== 'failed')) return null;
    const passed = task.verification !== 'failed';
    return verdict(yes(again) === passed, passed ? 'The checks passed after more attempts' : 'The checks still failed', { verification: task.verification });
  },

  'supervisor.intervene': (row, sql) => {
    const intervene = row.answers?.intervene;
    const signal = typeof row.state.signal === 'string' ? row.state.signal : null;
    if (!intervene || !row.subjectId || !signal) return null;
    const proposal = sql.prepare('SELECT status FROM supervisor_proposals WHERE chat_id = ? AND signal = ?').get(row.subjectId, signal) as { status: string } | undefined;
    if (!proposal || proposal.status === 'proposed') return null;
    const sent = proposal.status === 'sent';
    return verdict(yes(intervene) === sent, sent ? 'The hint was sent' : 'The hint was dismissed', { status: proposal.status });
  },

  'memory.triage': (row, sql) => {
    const level = scoreOf(row.answers?.usefulness);
    const proposal = row.subjectId ? (sql.prepare('SELECT status FROM memory_proposals WHERE id = ?').get(row.subjectId) as { status: string } | undefined) : undefined;
    if (!level || !proposal || proposal.status === 'pending') return null;
    const approved = proposal.status === 'approved';
    const predictedApproved = level === 'high' || level === 'medium';
    return verdict(predictedApproved === approved, approved ? 'The proposal was approved' : 'The proposal was rejected', { score: level, status: proposal.status });
  },

  'assistant.rerank': (row, sql) => {
    if (!row.answers || !row.subjectId) return null;
    const rows = sql.prepare('SELECT id, status FROM assistant_proposals WHERE run_id = ?').all(row.subjectId) as unknown as Array<{ id: string; status: string }>;
    let judged = 0;
    let right = 0;
    for (const p of rows) {
      const level = scoreOf(row.answers[p.id]);
      if (!level || level === 'minor') continue;
      if (p.status === 'pending') return null;
      if (p.status !== 'accepted' && p.status !== 'discarded') continue;
      judged += 1;
      if ((level === 'covered') === (p.status === 'discarded')) right += 1;
    }
    return judged === 0 ? null : verdict(right * 2 >= judged, `${right} of ${judged} proposals went the way they were ranked`, { judged, right });
  },

  'assistant.sources': (row, sql) => {
    if (!row.answers || !row.projectId) return null;
    const dropped = Object.entries(row.answers).filter(([, a]) => a.kind === 'noul' && !a.value).map(([id]) => id);
    const run = sql
      .prepare("SELECT reads, status FROM assistant_runs WHERE project_id = ? AND started_at >= ? AND status != 'running' ORDER BY seq LIMIT 1")
      .get(row.projectId, row.at) as { reads: string; status: string } | undefined;
    if (!run) return null;
    const read = new Set(((parse(run.reads)?.files as string[] | undefined) ?? []).map(String));
    const missed = dropped.filter((id) => read.has(id));
    return verdict(missed.length === 0, missed.length ? `The run read ${missed.length} file(s) judged not needed` : 'No file judged unneeded was read', { missed });
  },

  'journal.relevance': (row, sql) => {
    if (!row.projectId || !row.answers || typeof row.state.title !== 'string') return null;
    const item = sql.prepare("SELECT id FROM work_items WHERE project_id = ? AND title = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1").get(row.projectId, row.state.title, row.at) as { id: string } | undefined;
    if (!item) return null;
    const verify = nextVerify(sql, item.id, row.at);
    if (!verify) return null;
    const entries = Array.isArray(row.state.entries) ? (row.state.entries as Array<{ id?: string; title?: string }>) : [];
    const irrelevant = entries.filter((e) => e.id && e.title && scoreOf(row.answers?.[e.id]) === 'irrelevant');
    const comments = (sql.prepare("SELECT body FROM work_item_comments WHERE item_id = ? AND created_at > ? AND author_kind != 'person'").all(item.id, row.at) as unknown as Array<{ body: string }>).map((c) => c.body.toLowerCase());
    const cited = irrelevant.filter((e) => comments.some((c) => c.includes((e.title ?? '').toLowerCase())));
    return verdict(cited.length === 0, cited.length ? `${cited.length} entry(ies) judged irrelevant were then cited` : 'No entry judged irrelevant was cited', { cited: cited.map((e) => e.id) });
  },

  'board.triage': (row, sql) => {
    if (!row.subjectId) return null;
    const dup = row.answers?.duplicate;
    const item = sql.prepare('SELECT type, priority, status, created_at FROM work_items WHERE id = ?').get(row.subjectId) as { type: string; priority: string; status: string; created_at: string } | undefined;
    if (!item) return yes(dup) ? verdict(true, 'The item was removed, as a duplicate would be') : null;
    // Wait for the item to settle: a person often edits the prefill some minutes after creating
    if (item.status !== 'done' && Date.parse(row.at) + 86_400_000 > Date.now()) return null;
    const type = choiceOf(row, 'type');
    const priority = choiceOf(row, 'priority');
    const kept = (!type || type === item.type) && (!priority || priority === item.priority);
    return verdict(kept && !yes(dup), kept ? 'The person kept the prefill' : 'The person changed the type or priority', { type: item.type, priority: item.priority });
  },

  'flow.scope-drift': (row, sql) => {
    if (!row.subjectId || flagged(row).length === 0) return null;
    const verify = nextVerify(sql, row.subjectId, row.at);
    if (!verify) return null;
    const rejected = verify.outcome === 'rejected';
    return verdict(rejected, rejected ? 'QA rejected the card after the drift flag' : 'QA passed the card', { verify: verify.outcome });
  },

  'health.semantic-loop': (row, sql) => {
    if (!row.subjectId || flagged(row).length === 0) return null;
    const hint = sql.prepare("SELECT status FROM supervisor_proposals WHERE chat_id = ? AND at >= ? AND status != 'proposed' ORDER BY at LIMIT 1").get(row.subjectId, row.at) as { status: string } | undefined;
    if (hint) return verdict(hint.status === 'sent', hint.status === 'sent' ? 'A supervisor hint was sent' : 'The supervisor hint was dismissed', { status: hint.status });
    const run = sql.prepare("SELECT outcome FROM flow_runs WHERE chat_id = ? AND state = 'ended' AND outcome IS NOT NULL ORDER BY seq DESC LIMIT 1").get(row.subjectId) as { outcome: string } | undefined;
    if (!run) return null;
    const bad = run.outcome === 'failed' || run.outcome === 'cancelled';
    return verdict(bad, bad ? 'The run then failed or was stopped' : 'The run finished', { outcome: run.outcome });
  },

  'palette.intent': (row) => {
    const action = row.paletteAction;
    const answer = choiceOf(row, 'command');
    if (!action || !answer) return null;
    const detail = { action: action.action, commandId: action.commandId };
    if (answer !== 'none') {
      const proposed = action.action === 'proposed';
      return verdict(proposed, proposed ? 'The person ran the proposed command' : action.action === 'other' ? 'The person ran another command' : 'The person dismissed the palette', detail);
    }
    // "No command" is right when nothing listed ran: a dismissal, or a command the palette did not offer
    const listed = Array.isArray(row.state.commands) ? (row.state.commands as Array<{ id?: unknown }>).some((c) => c.id === action.commandId) : false;
    const right = action.action === 'dismissed' || (action.action === 'other' && !listed);
    return verdict(right, right ? 'No command was proposed and none of the listed ones ran' : 'A listed command ran where none was proposed', detail);
  },

  'notification.urgency': (row) => {
    const urgency = choiceOf(row, 'urgency');
    if (!urgency) return null;
    const start = Date.parse(row.at);
    const opened = row.openedAt ? Date.parse(row.openedAt) : null;
    const withinMs = opened !== null && Number.isFinite(opened) ? opened - start : null;
    const inTime = withinMs !== null && withinMs <= NOTIFICATION_WINDOW_MS;
    const detail = { urgency, openedAt: row.openedAt, withinMs };
    if (inTime) return verdict(urgency === 'high', urgency === 'high' ? 'A raised notification was opened within the hour' : 'A normal notification was opened within the hour', detail);
    // A push nobody tapped says nothing: people ignore most of them, the app may have been opened some
    // other way, and no push may have reached a device at all. Counting that as "normal was right"
    // made the score mostly the share of normal answers, so only an open is a signal.
    return null;
  },

  'orchestration.model': (row, sql) => {
    if (!row.answers || !row.subjectId) return null;
    const found = sql
      .prepare("SELECT json FROM orchestrations WHERE created_at >= ? AND json_extract(json, '$.plannerRunId') = ? ORDER BY created_at LIMIT 1")
      .get(row.at, row.subjectId) as { json: string } | undefined;
    const orch = found ? parse(found.json) : null;
    if (!orch) return null;
    const tasks = Array.isArray(orch.tasks) ? (orch.tasks as Array<Record<string, unknown>>) : [];
    const detail: Array<{ task: string; suggested: string; launched: string | null; kept: boolean; status: string }> = [];
    let judged = 0;
    let right = 0;
    for (const [taskId, answer] of Object.entries(row.answers)) {
      if (answer.kind !== 'choice') continue;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) continue;
      const status = String(task.status ?? '');
      if (STILL_GOING.has(status)) return null;
      const launched = typeof task.model === 'string' ? task.model : typeof orch.model === 'string' ? orch.model : null;
      const kept = launched === answer.value;
      detail.push({ task: taskId, suggested: answer.value, launched, kept, status });
      if (status !== 'completed' && status !== 'failed') continue;
      const completed = status === 'completed';
      const verdictOf = modelVerdict(answer.value, launched, kept, completed);
      if (verdictOf === null) continue;
      judged += 1;
      if (verdictOf) right += 1;
    }
    if (judged === 0) return null;
    return verdict(right * 2 >= judged, `${right} of ${judged} model suggestions matched how the tasks ended`, { judged, right, tasks: detail });
  },
};

// Both are judged on the card the chat worked on: QA rejecting on the change
const viaItemOfChat: Resolver = (row, sql) => {
  if (flagged(row).length === 0) return null;
  const itemId = itemOfChat(sql, row.subjectId);
  const verify = itemId ? nextVerify(sql, itemId, row.at) : null;
  if (!verify) return null;
  const rejected = verify.outcome === 'rejected';
  return verdict(rejected, rejected ? 'QA rejected the card after the flag' : 'QA passed the card', { verify: verify.outcome });
};
RESOLVERS['health.test-weakening'] = viaItemOfChat;
RESOLVERS['changes.unexplained-hunk'] = viaItemOfChat;

export const RESOLVED_POINTS: readonly DecisionPointId[] = Object.keys(RESOLVERS) as DecisionPointId[];

/** The events after which an outcome may have become known */
const EVENTS = /^(flow\.|orchestration\.|workitem\.|memory\.|assistant\.|supervisor\.|run\.ended$|health\.)/;

const SWEEP_MAX = 500;
const SWEEP_EVERY_MS = 5 * 60_000;
const DEBOUNCE_MS = 2_000;

export interface DecisionResolversDeps {
  sql: Sql;
  db: { decision(id: string): DecisionRecord | null };
  engine: { resolve(decisionId: string, outcome: DecisionResolution): void };
  historyDays: () => number;
  now?: () => Date;
}

/**
 * Finds the answered rows still waiting for an outcome and resolves the ones whose signal has
 * arrived. It runs shortly after the events above and every few minutes, so signals that are only
 * the passing of time (a card left alone) are found too. It never throws into the caller.
 */
export class DecisionResolvers {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;

  private readonly deps: DecisionResolversDeps;

  constructor(deps: DecisionResolversDeps) {
    this.deps = deps;
  }

  /** Resolves what can be resolved now; returns how many rows it resolved */
  sweep(): number {
    const now = this.deps.now?.() ?? new Date();
    const since = new Date(now.getTime() - this.deps.historyDays() * 86_400_000).toISOString();
    let resolved = 0;
    try {
      const points = RESOLVED_POINTS.map(() => '?').join(',');
      const ids = this.deps.sql
        .prepare(`SELECT id FROM decisions WHERE outcome IS NULL AND status = 'answered' AND answers IS NOT NULL AND at >= ? AND point IN (${points}) ORDER BY seq DESC LIMIT ${SWEEP_MAX}`)
        .all(since, ...RESOLVED_POINTS) as unknown as Array<{ id: string }>;
      for (const { id } of ids) {
        const row = this.deps.db.decision(id);
        const resolver = row ? RESOLVERS[row.point] : undefined;
        if (!row || !resolver) continue;
        try {
          const outcome = resolver(row, this.deps.sql, now.getTime());
          if (outcome) {
            this.deps.engine.resolve(id, outcome);
            resolved += 1;
          }
        } catch {
          // One row whose signal cannot be read must not hold the others back
        }
      }
    } catch {
      // The database may be closed at shutdown
    }
    return resolved;
  }

  observe(event: AgentryEvent): void {
    if (EVENTS.test(event.type)) this.soon();
  }

  /** Schedules the debounced sweep; a signal recorded outside the event bus calls it too */
  soon(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.sweep();
    }, DEBOUNCE_MS);
    this.debounce.unref();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }
}
