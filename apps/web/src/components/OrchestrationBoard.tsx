import type { Orchestration, OrchestrationTaskState } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  CornerDownRight,
  GitFork,
  Hand,
  Hourglass,
  ListChecks,
  MessageSquare,
  RotateCcw,
  RefreshCcw,
  Send,
  SkipForward,
  Square,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { useDetailPanel } from '../lib/detail';
import { attemptLabel, blockedBy, decisionsOn, waitingSummary } from '../lib/orchestration-board';
import { durationBetween, formatCost } from '../lib/format';
import { useClockTick } from '../lib/motion';
import { canRerun, dependantsOf } from '../lib/orchestration-v2';
import { orchestrationProgress } from '../lib/orchestration-steps';
import { NARROW, useMediaQuery } from '../lib/media';
import { healthReason } from '../lib/server-strings';
import { ActivityTicker } from './ActivityTicker';
import { Collapsible, Tooltip } from './controls';
import { useConfirm } from './Dialog';
import { ICON_SM } from './icons';
import { HealthBadge } from './observe/Health';
import { motion, useReducedMotion } from './motion';
import { ProgressBar } from './ProgressBar';
import { Spinner } from './Spinner';
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
      {status === 'running' ? <Spinner /> : <Icon {...ICON_SM} />}
      {label}
    </span>
  );
}

const DONE = new Set(['completed', 'failed', 'skipped', 'stopped', 'interrupted']);

/** A stage's head in the graph view: its name and its tasks as a segmented bar, "1 of 3 done, 1 failed". */
export function StageHead({ title, tasks }: { title: string; tasks: OrchestrationTaskState[] }) {
  const { t } = useTranslation('orchestration');
  const completed = tasks.filter((t) => t.status === 'completed').length;
  return (
    <div className="board-col-head">
      <h3 className="board-col-title">{title}</h3>
      <span className="count mono" aria-hidden>
        {completed}/{tasks.length}
      </span>
      <ProgressBar counts={orchestrationProgress(tasks)} unit={t('board.tasksUnit')} className="board-col-progress" />
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

/**
 * What a person can do to a task: the decisions a failed graph waits for, a re-run, a hint. The
 * buttons go on the card's foot line with its links; the hint form and any error open under the
 * card's body, where there is room for them.
 */
function useTaskActions(orch: Orchestration, task: OrchestrationTaskState): { buttons: ReactNode; panel: ReactNode } {
  const { t } = useTranslation('orchestration');
  const { t: tv } = useTranslation('orchestrationV2');
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
  // A finished graph starts over from a task, which retrying a failed one in a running graph does not
  const rerunnable = canRerun(orch);
  const rerun = useMutation({
    mutationFn: () => api.rerunOrchestrationTask(orch.id, task.id),
    onSuccess: (next) => queryClient.setQueryData(keys.orchestration(orch.id), next),
  });
  const name = task.name || task.id;
  const behind = orch.tasks.filter((t) => t.status === 'blocked').length;
  // The task itself is not counted among what depends on it
  const dependants = dependantsOf(orch.tasks, task.id).length - 1;

  const buttons = (
    <>
      {decisions.hint && !hinting && (
        <button type="button" className="btn btn-small btn-quiet" onClick={() => setHinting(true)}>
          <Send {...ICON_SM} /> {t('board.sendAHint')}
        </button>
      )}
      {decisions.skip && (
        <button
          type="button"
          className="btn btn-small btn-quiet"
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
      {rerunnable && (
        <button
          type="button"
          className="btn btn-small"
          disabled={rerun.isPending}
          onClick={() =>
            void confirm({
              title: tv('rerun.title', { name }),
              body: dependants > 0 ? tv('rerun.bodyWithDependants', { count: dependants }) : tv('rerun.bodyAlone'),
              confirmLabel: tv('rerun.confirm'),
              danger: true,
            }).then((ok) => {
              if (ok) rerun.mutate();
            })
          }
        >
          <RefreshCcw {...ICON_SM} /> {tv('rerun.button')}
        </button>
      )}
      {decisions.retry && (
        <button type="button" className="btn btn-small btn-primary" disabled={decide.isPending} title={t('board.retryTitle')} onClick={() => decide.mutate('retry')}>
          <RotateCcw {...ICON_SM} /> {t('board.retry')}
        </button>
      )}
    </>
  );
  const panel = (
    <>
      {hinting && decisions.hint && <HintForm orchId={orch.id} task={task} onDone={() => setHinting(false)} />}
      <ErrorBox error={decide.error ?? rerun.error} />
    </>
  );
  return { buttons, panel };
}

/** How long a task has taken, read again every second while it runs. */
export function TaskDuration({ task }: { task: OrchestrationTaskState }) {
  // Only a running task's duration moves; an hour between reads of a finished one costs nothing
  useClockTick(task.status === 'running' ? 1000 : 3_600_000);
  return <>{task.startedAt ? durationBetween(task.startedAt, task.endedAt) : ''}</>;
}

/** The task's name, which opens its chat beside the page when it has one: following a worker should not mean leaving the graph. */
function TaskName({ task, id, className, level: Heading }: { task: OrchestrationTaskState; id: string; className: string; level: 'h3' | 'h4' }) {
  const { t } = useTranslation('orchestration');
  const { open } = useDetailPanel();
  const name = task.name || task.id;
  const chatId = task.sessionId;
  return (
    <Heading id={id} className={className}>
      {chatId ? (
        <Tooltip content={t('board.openChatBeside')}>
          <button type="button" className="link-btn task-name-btn" onClick={() => open({ kind: 'chat', chatId })}>
            {name}
          </button>
        </Tooltip>
      ) : (
        name
      )}
    </Heading>
  );
}

function TaskCost({ task }: { task: OrchestrationTaskState }) {
  const { t } = useTranslation('orchestration');
  return <span title={t('board.costTitle')}>{formatCost(task.costUsd)}</span>;
}

/** A task's state as a mark beside its name: the ring while it runs, a shape once it has an outcome. The word is in its status box. */
function TaskMark({ status }: { status: OrchestrationTaskState['status'] }) {
  if (status === 'running') return <Spinner variant="ring" />;
  const { icon: Icon, tone } = STATUS[status];
  return (
    <span className={`task-mark is-${tone}`} aria-hidden>
      <Icon size={12} strokeWidth={2.25} />
    </span>
  );
}

/**
 * The one line that says where a task stands, in words: what a running worker is doing (its
 * command, in mono), how a finished one ended, what a blocked one waits for.
 */
function TaskStatusBox({ orch, task }: { orch: Orchestration; task: OrchestrationTaskState }) {
  const { t } = useTranslation(['orchestration', 'primitives']);
  const attempt = attemptLabel(orch, task);
  const behind = task.status === 'blocked' ? blockedBy(orch, task) : [];
  switch (task.status) {
    case 'running':
      return task.activity ? (
        <div className="task-box is-live">
          <ActivityTicker activity={task.activity} className="task-ticker" />
        </div>
      ) : (
        <div className="task-box is-live">
          <Spinner variant="dots" />
          <span className="shimmer">{t('primitives:activity.thinking')}</span>
        </div>
      );
    case 'completed':
      return (
        <div className="task-box is-ok">
          <CircleCheck {...ICON_SM} />
          <span>{attempt ?? t('board.box.completed')}</span>
        </div>
      );
    case 'failed':
      return (
        <div className="task-box is-bad">
          <CircleAlert {...ICON_SM} />
          <div className="task-box-text">
            <span className="strong">{attempt ?? t('board.box.failed')}</span>
            {task.error && <span className="task-box-detail">{task.error}</span>}
          </div>
        </div>
      );
    case 'blocked':
      return (
        <div className="task-box is-warn">
          <CirclePause {...ICON_SM} />
          <span>
            {t('board.blockedNote')}
            {behind.length > 0 && <> {t('board.cannotStart', { count: behind.length, names: behind.map((b) => b.name || b.id).join(', ') })}</>}
          </span>
        </div>
      );
    case 'skipped':
      return (
        <div className="task-box">
          <Ban {...ICON_SM} />
          <span>{t('board.givenUp')}</span>
        </div>
      );
    case 'stopped':
    case 'interrupted':
      return (
        <div className="task-box is-warn">
          {task.status === 'stopped' ? <Square {...ICON_SM} /> : <Zap {...ICON_SM} />}
          <span>{t(`board.box.${task.status}`)}</span>
        </div>
      );
    case 'pending':
      return (
        <div className="task-box">
          <CircleDashed {...ICON_SM} />
          <span>{t('board.box.pending')}</span>
        </div>
      );
  }
}

/** Everything a task says beyond its head line, the same in a stage's card and in a graph node. */
function TaskBody({ orch, task, inspected, onInspect }: { orch: Orchestration; task: OrchestrationTaskState; inspected: boolean; onInspect?: () => void }) {
  const { t } = useTranslation('orchestration');
  const previousError = usePreviousError(task);
  const chat = chatPath(task);
  const finished = DONE.has(task.status);
  const actions = useTaskActions(orch, task);
  return (
    <>
      <TaskStatusBox orch={orch} task={task} />
      {task.status === 'running' && task.health && task.health.level !== 'ok' && (
        <div className="stack-tight">
          <HealthBadge health={task.health} />
          <div className="small">{healthReason(task.health)}</div>
        </div>
      )}
      {previousError && (
        <div className="alert alert-warn small">
          <CircleAlert className="alert-icon" {...ICON_SM} />
          <div className="alert-body">
            <span className="strong">{t('board.previousFailed')}</span> {previousError}
          </div>
        </div>
      )}
      {task.error && task.status !== 'running' && task.status !== 'failed' && (
        <div className="alert alert-bad small">
          <CircleAlert className="alert-icon" {...ICON_SM} />
          <div className="alert-body">{task.error}</div>
        </div>
      )}
      <Collapsible className="fold" title={t('board.prompt')}>
        <div className="prose small">{task.prompt}</div>
      </Collapsible>
      {task.result && (
        <Collapsible className="fold" title={t('board.result')}>
          <RichText text={task.result} />
        </Collapsible>
      )}
      {actions.panel}
      <div className="task-foot">
        <span className="task-foot-facts">
          <span className="badge task-id">{task.id}</span>
          {(task.dependsOn?.length ?? 0) > 0 && (
            <span className="meta-icon">
              <CornerDownRight size={12} strokeWidth={1.75} aria-hidden /> {t('board.after', { deps: task.dependsOn?.join(', ') })}
            </span>
          )}
          {task.model && <span className="mono">{task.model}</span>}
          {/* The branch is how the work is found afterwards, so it is worth the space */}
          {task.branch && (
            <span className="mono ellipsis" title={task.worktree ?? undefined}>
              {task.branch}
            </span>
          )}
        </span>
        <div className="task-actions">
          {actions.buttons}
          {onInspect && task.status !== 'pending' && task.status !== 'blocked' && (
            <button type="button" className="btn btn-small btn-quiet" aria-pressed={inspected} onClick={onInspect}>
              <ListChecks {...ICON_SM} /> {t('board.work')}
            </button>
          )}
          {chat && finished && (
            <Link to={chat} className="btn btn-small btn-quiet" title={t('board.forkTitle')}>
              <GitFork {...ICON_SM} /> {t('board.fork')}
            </Link>
          )}
          {chat && (
            <Link to={chat} className="btn btn-small">
              <MessageSquare {...ICON_SM} /> {t('board.openChat')}
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * A task as a node of the graph view. It fills as it goes — a live stripe while it runs, full once
 * it has an outcome — so a wide graph can be read at a glance before a word of it is.
 */
export function TaskCard({
  orch,
  task,
  inspected = false,
  onInspect,
}: {
  orch: Orchestration;
  task: OrchestrationTaskState;
  /** Its work is open under the board */
  inspected?: boolean;
  onInspect?: () => void;
}) {
  const reduced = useReducedMotion();
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
      <span className="board-task-fill" aria-hidden />
      <div className="board-task-head">
        <BoardStatusBadge status={task.status} />
        <span className="muted small mono board-task-facts">
          <TaskDuration task={task} />
          {task.costUsd > 0 && (
            <>
              {task.startedAt ? ' · ' : ''}
              <TaskCost task={task} />
            </>
          )}
        </span>
      </div>
      <TaskName task={task} id={titleId} className="board-task-name" level="h4" />
      <TaskBody orch={orch} task={task} inspected={inspected} onInspect={onInspect} />
    </motion.article>
  );
}

/**
 * A task's state in the one line a phone's summary card has for it: what a running worker is doing,
 * else how it ended or what it waits for, in its status colour and always in words.
 */
function TaskSummaryLine({ orch, task }: { orch: Orchestration; task: OrchestrationTaskState }) {
  const { t } = useTranslation(['orchestration', 'primitives']);
  const attempt = attemptLabel(orch, task);
  if (task.status === 'running')
    return task.activity ? (
      <ActivityTicker activity={task.activity} showElapsed={false} className="task-row-summary is-live" />
    ) : (
      <span className="task-row-summary shimmer">{t('primitives:activity.thinking')}</span>
    );
  let tone = 'muted';
  let text = t('board.box.pending');
  switch (task.status) {
    case 'completed':
      tone = 'ok';
      text = attempt ?? t('board.box.completed');
      break;
    case 'failed':
      tone = 'bad';
      text = attempt ?? t('board.box.failed');
      break;
    case 'blocked':
      tone = 'warn';
      text = t('board.summary.blocked');
      break;
    case 'skipped':
      text = t('board.summary.skipped');
      break;
    case 'stopped':
    case 'interrupted':
      tone = 'warn';
      text = t(`board.box.${task.status}`);
      break;
  }
  return <span className={`task-row-summary is-${tone}`}>{text}</span>;
}

/**
 * A task as a card of the selected stage: its mark, name and numbers on one line, the box that says
 * what it is doing, then what a graph node says. The stage's most active task takes the page's
 * energy border (`energy`); any other running one takes the live rail.
 *
 * On a phone every other task is one line, as the reference draws it: its name, where it stands and
 * its numbers. Its box, its prompt and its actions open under it from the chevron.
 */
export function TaskRow({
  orch,
  task,
  inspected = false,
  onInspect,
  energy = false,
}: {
  orch: Orchestration;
  task: OrchestrationTaskState;
  inspected?: boolean;
  onInspect?: () => void;
  energy?: boolean;
}) {
  const { t } = useTranslation('orchestration');
  const titleId = useId();
  const bodyId = useId();
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const summary = narrow && !energy;
  const live = energy ? 'live-energy' : task.status === 'running' ? 'live-rail' : '';
  const facts = (
    <span className="task-row-facts mono small muted">
      <TaskDuration task={task} />
      {task.costUsd > 0 && (
        <>
          {task.startedAt ? ' · ' : ''}
          <TaskCost task={task} />
        </>
      )}
    </span>
  );
  return (
    <li className="task-row-item">
      <article className={`task-row status-${task.status} ${live} ${summary ? 'is-summary' : ''}`.replace(/\s+/g, ' ').trim()} aria-labelledby={titleId}>
        <div className="task-row-head">
          <TaskMark status={task.status} />
          {summary ? (
            <div className="task-row-title">
              <TaskName task={task} id={titleId} className="task-row-name" level="h3" />
              <TaskSummaryLine orch={orch} task={task} />
            </div>
          ) : (
            <TaskName task={task} id={titleId} className="task-row-name" level="h3" />
          )}
          {facts}
          {summary && (
            <button
              type="button"
              className="icon-btn task-row-toggle"
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              aria-label={t('board.taskDetails', { name: task.name || task.id })}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronDown {...ICON_SM} />
            </button>
          )}
        </div>
        {summary ? (
          open && (
            <div id={bodyId} className="task-row-body">
              <TaskBody orch={orch} task={task} inspected={inspected} onInspect={onInspect} />
            </div>
          )
        ) : (
          <TaskBody orch={orch} task={task} inspected={inspected} onInspect={onInspect} />
        )}
      </article>
    </li>
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
