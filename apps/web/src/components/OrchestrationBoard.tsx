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
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { ErrorBox, Field, statusText } from './ui';

/**
 * A status is always its icon and its word, never a colour alone. `held` is the synthesis waiting on
 * a decision, which no task status expresses.
 */
export type BoardStatus = Orchestration['status'] | OrchestrationTaskState['status'] | 'held';

const STATUS: Record<BoardStatus, { icon: LucideIcon; tone: string }> = {
  pending: { icon: CircleDashed, tone: 'muted' },
  running: { icon: CircleDashed, tone: 'active' },
  completed: { icon: CircleCheck, tone: 'ok' },
  failed: { icon: CircleX, tone: 'bad' },
  blocked: { icon: CirclePause, tone: 'warn' },
  skipped: { icon: Ban, tone: 'muted' },
  stopped: { icon: Square, tone: 'warn' },
  interrupted: { icon: Zap, tone: 'warn' },
  waiting: { icon: Hand, tone: 'warn' },
  held: { icon: Hourglass, tone: 'warn' },
};

/** The statuses the shared `common:status.*` names do not cover are the board's own: they say what a person is asked for. */
function statusLabel(status: BoardStatus, t: TFunction<'orchestration'>): string {
  switch (status) {
    case 'waiting':
      return t('board.status.waiting');
    case 'held':
      return t('board.status.held');
    case 'interrupted':
      return t('board.status.interrupted');
    default:
      return statusText(status);
  }
}

export function BoardStatusBadge({ status, title }: { status: BoardStatus; title?: string }) {
  const { t } = useTranslation('orchestration');
  const { icon: Icon, tone } = STATUS[status];
  const label = statusLabel(status, t);
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {status === 'running' ? <span className="spinner spinner-xs" aria-hidden /> : <Icon {...ICON_SM} />}
      {label}
    </span>
  );
}

const DONE = new Set(['completed', 'failed', 'skipped', 'stopped', 'interrupted']);

export function StageHead({ title, tasks }: { title: string; tasks: OrchestrationTaskState[] }) {
  const { t } = useTranslation('orchestration');
  const done = tasks.filter((t) => DONE.has(t.status)).length;
  const failed = tasks.some((t) => t.status === 'failed');
  const held = tasks.some((t) => t.status === 'blocked');
  const value = tasks.length === 0 ? 0 : done / tasks.length;
  return (
    <div className="board-col-head">
      <ProgressRing value={value} size={26} stroke={3.5} tone={failed ? 'bad' : held ? 'warn' : value === 1 ? 'ok' : 'accent'} />
      <h3 className="board-col-title">{title}</h3>
      {/* The ring is colour and arc only, so the state it draws is also said in an icon and words */}
      {failed && <CircleX className="text-bad" {...ICON_SM} />}
      {!failed && held && <CirclePause className="text-warn" {...ICON_SM} />}
      <span className="count">
        {done}/{tasks.length}
        <span className="sr-only">
          {' '}
          {failed ? t('board.stageDoneFailed') : held ? t('board.stageDoneBlocked') : t('board.stageDone')}
        </span>
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

function HintForm({ orchId, task, onDone }: { orchId: string; task: OrchestrationTaskState; onDone: () => void }) {
  const { t } = useTranslation(['orchestration', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => api.hintOrchestrationTask(orchId, task.id, { text: text.trim() }),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.orchestration(orchId), next);
      toast.success(t('board.hintSent'), t('board.hintSentBody', { name: task.name || task.id }));
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
      <Field label={t('board.hintLabel')} hint={t('board.hintExplained')}>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('board.hintPlaceholder')} autoFocus />
      </Field>
      <ErrorBox error={send.error} />
      <div className="form-actions">
        <button type="submit" className="btn btn-small btn-primary" disabled={send.isPending || !text.trim()}>
          <Send {...ICON_SM} /> {send.isPending ? t('board.sending') : t('board.sendHint')}
        </button>
        <button type="button" className="btn btn-small" onClick={onDone} disabled={send.isPending}>
          {t('common:actions.cancel')}
        </button>
      </div>
    </form>
  );
}

function TaskActions({ orch, task }: { orch: Orchestration; task: OrchestrationTaskState }) {
  const { t } = useTranslation('orchestration');
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
            title={t('board.retryTitle')}
            onClick={() => decide.mutate('retry')}
          >
            <RotateCcw {...ICON_SM} /> {t('board.retry')}
          </button>
        )}
        {decisions.retryClean && (
          <button
            type="button"
            className="btn btn-small"
            disabled={decide.isPending}
            onClick={() =>
              void confirm({
                title: t('board.retryCleanTitle', { name }),
                body: t('board.retryCleanBody'),
                confirmLabel: t('board.retryClean'),
                danger: true,
              }).then((ok) => {
                if (ok) decide.mutate('retry-clean');
              })
            }
          >
            <RotateCcw {...ICON_SM} /> {t('board.retryClean')}
          </button>
        )}
        {decisions.skip && (
          <button
            type="button"
            className="btn btn-small"
            disabled={decide.isPending}
            onClick={() =>
              void confirm({
                title: t('board.skipTitle', { name }),
                // Not `behind` itself: 0 would read as plural, and the text is singular unless several branches are held
                body: t('board.skipBody', { count: behind > 1 ? 2 : 1 }),
                confirmLabel: t('board.skipConfirm'),
              }).then((ok) => {
                if (ok) decide.mutate('skip');
              })
            }
          >
            <SkipForward {...ICON_SM} /> {t('board.skip')}
          </button>
        )}
        {decisions.hint && !hinting && (
          <button type="button" className="btn btn-small" onClick={() => setHinting(true)}>
            <Send {...ICON_SM} /> {t('board.sendAHint')}
          </button>
        )}
      </div>
      {hinting && decisions.hint && <HintForm orchId={orch.id} task={task} onDone={() => setHinting(false)} />}
      <ErrorBox error={decide.error} />
    </div>
  );
}

export function TaskCard({ orch, task }: { orch: Orchestration; task: OrchestrationTaskState }) {
  const { t } = useTranslation('orchestration');
  const reduced = useReducedMotion();
  const previousError = usePreviousError(task);
  const attempt = attemptLabel(orch, task);
  const chat = chatPath(task);
  const behind = task.status === 'blocked' ? blockedBy(orch, task) : [];
  const finished = DONE.has(task.status);
  const titleId = useId();
  return (
    // Keyed on status so a task visibly settles into its new state when it changes
    <motion.article
      key={task.status}
      className={`board-task status-${task.status}`}
      aria-labelledby={titleId}
      initial={reduced ? false : { opacity: 0.4, scale: 0.98 }}
      // Fading a skipped task would drop its muted text below the contrast the badge needs
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="side-item-head">
        <BoardStatusBadge status={task.status} />
        <span className="muted small">{task.startedAt ? durationBetween(task.startedAt, task.endedAt) : ''}</span>
      </div>
      <h4 id={titleId} className="board-task-name">
        {task.name || task.id}
      </h4>
      <div className="mono small muted">{task.id}</div>
      {(task.dependsOn?.length ?? 0) > 0 && (
        <div className="small muted meta-icon">
          <CornerDownRight size={12} strokeWidth={1.75} aria-hidden /> {t('board.after', { deps: task.dependsOn?.join(', ') })}
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
            {t('board.blockedNote')}
            {behind.length > 0 && (
              <>
                {' '}
                {t('board.cannotStart', { count: behind.length, names: behind.map((b) => b.name || b.id).join(', ') })}
              </>
            )}
          </div>
        </div>
      )}
      {task.status === 'skipped' && <div className="small muted">{t('board.givenUp')}</div>}
      {previousError && (
        <div className="alert alert-warn small">
          <CircleAlert className="alert-icon" {...ICON_SM} />
          <div className="alert-body">
            <span className="strong">{t('board.previousFailed')}</span> {previousError}
          </div>
        </div>
      )}
      <Collapsible className="fold" title={t('board.prompt')}>
        <div className="prose small">{task.prompt}</div>
      </Collapsible>
      {task.error && task.status !== 'running' && (
        <div className="alert alert-bad small">
          <CircleAlert className="alert-icon" {...ICON_SM} />
          <div className="alert-body">{task.error}</div>
        </div>
      )}
      {task.result && (
        <Collapsible className="fold" title={t('board.result')}>
          <RichText text={task.result} />
        </Collapsible>
      )}
      <TaskActions orch={orch} task={task} />
      <div className="meta">
        {chat && (
          <Link to={chat} className="meta-icon">
            <MessageSquare size={12} strokeWidth={1.75} aria-hidden /> {t('board.chat')}
          </Link>
        )}
        {chat && finished && (
          <Link
            to={chat}
            className="meta-icon"
            title={t('board.forkTitle')}
          >
            <GitFork size={12} strokeWidth={1.75} aria-hidden /> {t('board.fork')}
          </Link>
        )}
        {task.model && <span>{task.model}</span>}
        {task.costUsd > 0 && <span title={t('board.costTitle')}>{formatCost(task.costUsd)}</span>}
        {/* The branch is how the work is found afterwards, so it is worth the space */}
        {task.branch && (
          <span className="mono" title={task.worktree ?? undefined}>
            {task.branch}
          </span>
        )}
      </div>
    </motion.article>
  );
}

/** What an orchestration in `waiting` asks of the person looking at it, and what is held until then. */
export function WaitingNotice({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation('orchestration');
  const waiting = waitingSummary(orch);
  if (!waiting) return null;
  const { failed, blocked } = waiting;
  const held = orch.worktree && orch.synthesize ? t('board.heldBoth') : orch.synthesize ? t('board.heldSynthesis') : orch.worktree ? t('board.heldIntegration') : null;
  const names = failed.map((f) => f.name || f.id).join(', ');
  return (
    <div className="alert alert-warn alert-big" role="status">
      <Hand className="alert-icon" {...ICON_SM} />
      <div className="alert-body stack-tight">
        <div className="strong">{t('board.waitingTitle')}</div>
        <div className="small">
          {t('board.failedForGood', { count: failed.length, names })}
          {blocked.length > 0 && ` ${failed.length === 1 ? t('board.blockedBehindIt', { count: blocked.length }) : t('board.blockedBehindThem', { count: blocked.length })}`}.
          {held && ` ${held}`} {t('board.decide')}
        </div>
      </div>
    </div>
  );
}
