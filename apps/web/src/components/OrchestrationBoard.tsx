import type { Orchestration, OrchestrationTaskState } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  CornerDownRight,
  GitFork,
  Hand,
  Hourglass,
  MessageSquare,
  RotateCcw,
  Send,
  SkipForward,
  Square,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { attemptLabel, blockedBy, decisionsOn, waitingSummary } from '../lib/orchestration-board';
import { durationBetween, formatCost } from '../lib/format';
import { Collapsible } from './controls';
import { useConfirm } from './Dialog';
import { ICON_SM } from './icons';
import { motion, ProgressRing, useReducedMotion } from './motion';
import { useToast } from './Toast';
import { RichText } from './Transcript';
import { ErrorBox, Field } from './ui';

/**
 * A status is always its icon and its word, never a colour alone. `held` is the synthesis waiting on
 * a decision, which no task status expresses.
 */
export type BoardStatus = Orchestration['status'] | OrchestrationTaskState['status'] | 'held';

const STATUS: Record<BoardStatus, { icon: LucideIcon; tone: string; label: string }> = {
  pending: { icon: CircleDashed, tone: 'muted', label: 'pending' },
  running: { icon: CircleDashed, tone: 'active', label: 'running' },
  completed: { icon: CircleCheck, tone: 'ok', label: 'completed' },
  failed: { icon: CircleX, tone: 'bad', label: 'failed' },
  blocked: { icon: CirclePause, tone: 'warn', label: 'blocked' },
  skipped: { icon: Ban, tone: 'muted', label: 'skipped' },
  stopped: { icon: Square, tone: 'warn', label: 'stopped' },
  waiting: { icon: Hand, tone: 'warn', label: 'waiting for you' },
  held: { icon: Hourglass, tone: 'warn', label: 'held' },
};

export function BoardStatusBadge({ status, title }: { status: BoardStatus; title?: string }) {
  const { icon: Icon, tone, label } = STATUS[status];
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {status === 'running' ? <span className="spinner spinner-xs" aria-hidden /> : <Icon {...ICON_SM} />}
      {label}
    </span>
  );
}

const DONE = new Set(['completed', 'failed', 'skipped', 'stopped']);

export function StageHead({ title, tasks }: { title: string; tasks: OrchestrationTaskState[] }) {
  const done = tasks.filter((t) => DONE.has(t.status)).length;
  const failed = tasks.some((t) => t.status === 'failed');
  const held = tasks.some((t) => t.status === 'blocked');
  const value = tasks.length === 0 ? 0 : done / tasks.length;
  return (
    <div className="board-col-head">
      <ProgressRing value={value} size={26} stroke={3.5} tone={failed ? 'bad' : held ? 'warn' : value === 1 ? 'ok' : 'accent'} />
      <span className="board-col-title">{title}</span>
      <span className="count">
        {done}/{tasks.length}
      </span>
    </div>
  );
}

/** The chat a task works in is its home: the board is where a task is followed, the chat where it can be read. */
function chatPath(task: OrchestrationTaskState): string | null {
  return task.sessionId ? `/chats/${encodeURIComponent(task.sessionId)}` : null;
}

/** Why the last attempt failed, once the task has started the next one and the task itself no longer says. */
function usePreviousError(task: OrchestrationTaskState): string | null {
  const retrying = task.status === 'running' && task.attempts > 1 && task.sessionId;
  const { data } = useQuery({
    queryKey: ['task-executions', task.sessionId, task.attempts],
    queryFn: () => api.chatExecutions(task.sessionId ?? ''),
    enabled: Boolean(retrying),
  });
  if (!retrying) return null;
  return task.error ?? [...(data ?? [])].reverse().find((e) => e.error)?.error ?? null;
}

const HINT_EXPLAINED =
  'A hint is added to what this worker is doing now. It does not answer back here: the task carries on, and its result is what the graph waits for.';

function HintForm({ orchId, task, onDone }: { orchId: string; task: OrchestrationTaskState; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => api.hintOrchestrationTask(orchId, task.id, { text: text.trim() }),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.orchestration(orchId), next);
      toast.success('Hint sent', `${task.name || task.id} will see it with its next step.`);
      onDone();
    },
  });
  return (
    <form
      className="stack-tight task-hint"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) send.mutate();
      }}
    >
      <Field label="Hint for this worker" hint={`${HINT_EXPLAINED} To talk it through, wait for it to finish and fork its chat.`}>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="One thing it should know or change" autoFocus />
      </Field>
      <ErrorBox error={send.error} />
      <div className="form-actions">
        <button type="submit" className="btn btn-small btn-primary" disabled={send.isPending || !text.trim()}>
          <Send {...ICON_SM} /> {send.isPending ? 'Sending…' : 'Send hint'}
        </button>
        <button type="button" className="btn btn-small" onClick={onDone} disabled={send.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function TaskActions({ orch, task }: { orch: Orchestration; task: OrchestrationTaskState }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [hinting, setHinting] = useState(false);
  const decisions = decisionsOn(orch, task);
  const decide = useMutation({
    mutationFn: (action: 'retry' | 'retry-clean' | 'skip') =>
      action === 'retry'
        ? api.retryOrchestrationTask(orch.id, task.id)
        : action === 'retry-clean'
          ? api.retryOrchestrationTaskClean(orch.id, task.id)
          : api.skipOrchestrationTask(orch.id, task.id),
    onSuccess: (next) => queryClient.setQueryData(keys.orchestration(orch.id), next),
  });
  const name = task.name || task.id;
  const behind = orch.tasks.filter((t) => t.status === 'blocked').length;

  if (!decisions.retry && !decisions.skip && !decisions.hint) return null;
  return (
    <div className="stack-tight">
      <div className="task-actions">
        {decisions.retry && (
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={decide.isPending}
            title="One more execution of the same chat, in the worktree it left, told what went wrong"
            onClick={() => decide.mutate('retry')}
          >
            <RotateCcw {...ICON_SM} /> Retry
          </button>
        )}
        {decisions.retryClean && (
          <button
            type="button"
            className="btn btn-small"
            disabled={decide.isPending}
            onClick={() =>
              void confirm({
                title: `Start ${name} over?`,
                body: 'Its worktree is removed and its branch deleted, and a new chat starts from the base commit. The old chat stays listed as a record of what was tried.',
                confirmLabel: 'Retry clean',
                danger: true,
              }).then((ok) => {
                if (ok) decide.mutate('retry-clean');
              })
            }
          >
            <RotateCcw {...ICON_SM} /> Retry clean
          </button>
        )}
        {decisions.skip && (
          <button
            type="button"
            className="btn btn-small"
            disabled={decide.isPending}
            onClick={() =>
              void confirm({
                title: `Give up ${name}?`,
                body: `It and everything that depends on it are skipped, and the graph finishes without ${behind > 1 ? 'those branches' : 'that branch'}. The chats keep what they did; nothing is deleted.`,
                confirmLabel: 'Skip the branch',
              }).then((ok) => {
                if (ok) decide.mutate('skip');
              })
            }
          >
            <SkipForward {...ICON_SM} /> Skip branch
          </button>
        )}
        {decisions.hint && !hinting && (
          <button type="button" className="btn btn-small" onClick={() => setHinting(true)}>
            <Send {...ICON_SM} /> Send a hint
          </button>
        )}
      </div>
      {hinting && decisions.hint && <HintForm orchId={orch.id} task={task} onDone={() => setHinting(false)} />}
      <ErrorBox error={decide.error} />
    </div>
  );
}

export function TaskCard({ orch, task }: { orch: Orchestration; task: OrchestrationTaskState }) {
  const reduced = useReducedMotion();
  const previousError = usePreviousError(task);
  const attempt = attemptLabel(orch, task);
  const chat = chatPath(task);
  const behind = task.status === 'blocked' ? blockedBy(orch, task) : [];
  const finished = DONE.has(task.status);
  return (
    // Keyed on status so a task visibly settles into its new state when it changes
    <motion.div
      key={task.status}
      className={`board-task status-${task.status}`}
      initial={reduced ? false : { opacity: 0.4, scale: 0.98 }}
      animate={{ opacity: task.status === 'skipped' ? 0.7 : 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="side-item-head">
        <BoardStatusBadge status={task.status} />
        <span className="muted small">{task.startedAt ? durationBetween(task.startedAt, task.endedAt) : ''}</span>
      </div>
      <div className="strong">{task.name || task.id}</div>
      <div className="mono small muted">{task.id}</div>
      {(task.dependsOn?.length ?? 0) > 0 && (
        <div className="small muted meta-icon">
          <CornerDownRight size={12} strokeWidth={1.75} aria-hidden /> after {task.dependsOn?.join(', ')}
        </div>
      )}
      {attempt && (
        <div className={`small meta-icon ${task.status === 'failed' ? '' : 'muted'}`}>
          <RotateCcw size={12} strokeWidth={1.75} aria-hidden /> {attempt}
        </div>
      )}
      {task.status === 'blocked' && (
        <div className="alert alert-warn small">
          <CirclePause className="alert-icon" {...ICON_SM} />
          <div className="alert-body">
            Waiting for a decision, not failed itself.
            {behind.length > 0 && (
              <>
                {' '}
                It cannot start until {behind.map((t) => t.name || t.id).join(', ')} {behind.length === 1 ? 'is' : 'are'} retried or given up.
              </>
            )}
          </div>
        </div>
      )}
      {task.status === 'skipped' && <div className="small muted">Given up: the graph finishes without this branch.</div>}
      {previousError && (
        <div className="alert alert-warn small">
          <CircleAlert className="alert-icon" {...ICON_SM} />
          <div className="alert-body">
            <span className="strong">Previous attempt failed:</span> {previousError}
          </div>
        </div>
      )}
      <Collapsible className="fold" title="Prompt">
        <div className="prose small">{task.prompt}</div>
      </Collapsible>
      {task.error && task.status !== 'running' && (
        <div className="alert alert-bad small">
          <CircleAlert className="alert-icon" {...ICON_SM} />
          <div className="alert-body">{task.error}</div>
        </div>
      )}
      {task.result && (
        <Collapsible className="fold" title="Result">
          <RichText text={task.result} />
        </Collapsible>
      )}
      <TaskActions orch={orch} task={task} />
      <div className="meta">
        {chat && (
          <Link to={chat} className="meta-icon">
            <MessageSquare size={12} strokeWidth={1.75} aria-hidden /> Chat
          </Link>
        )}
        {chat && finished && (
          <Link
            to={chat}
            className="meta-icon"
            title="A finished task is closed: to build on its work, fork its chat and continue in the copy"
          >
            <GitFork size={12} strokeWidth={1.75} aria-hidden /> Fork it
          </Link>
        )}
        {task.model && <span>{task.model}</span>}
        {task.costUsd > 0 && <span title="Everything this task's chat cost, every attempt included">{formatCost(task.costUsd)}</span>}
        {/* The branch is how the work is found afterwards, so it is worth the space */}
        {task.branch && (
          <span className="mono" title={task.worktree ?? undefined}>
            {task.branch}
          </span>
        )}
      </div>
    </motion.div>
  );
}

/** What an orchestration in `waiting` asks of the person looking at it, and what is held until then. */
export function WaitingNotice({ orch }: { orch: Orchestration }) {
  const waiting = waitingSummary(orch);
  if (!waiting) return null;
  const { failed, blocked } = waiting;
  const held = orch.worktree && orch.synthesize ? 'The integration and the synthesis are' : orch.synthesize ? 'The synthesis is' : orch.worktree ? 'The integration is' : null;
  return (
    <div className="alert alert-warn alert-big" role="status">
      <Hand className="alert-icon" {...ICON_SM} />
      <div className="alert-body stack-tight">
        <div className="strong">Waiting for you: nothing is running</div>
        <div className="small">
          {failed.length} task{failed.length === 1 ? '' : 's'} failed for good ({failed.map((t) => t.name || t.id).join(', ')})
          {blocked.length > 0 && ` and ${blocked.length} ${blocked.length === 1 ? 'is' : 'are'} blocked behind ${failed.length === 1 ? 'it' : 'them'}`}.
          {held && ` ${held} held until each is retried or given up.`} Decide on the cards below.
        </div>
      </div>
    </div>
  );
}
