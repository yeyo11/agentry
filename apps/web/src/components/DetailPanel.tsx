import type { AgentTranscript, ChatBackgroundTask } from '@agentry/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAgentDetail, useChatTasks, useChatTranscript, useTaskOutput, type AgentRef } from '../lib/chats';
import { useDetailPanel, type DetailRef } from '../lib/detail';
import { durationBetween, formatCost, formatDateTime, formatDuration, formatNumber } from '../lib/format';
import { ActivityTicker } from './ActivityTicker';
import { CodeBlock } from './CodeBlock';
import { Collapsible } from './controls/Collapsible';
import { Dialog } from './Dialog';
import { ScrollJump } from './ScrollJump';
import { RichText, Transcript } from './Transcript';
import { BranchStatus, StateBadge } from './ChatBadges';
import { ErrorBox, Loading, Tag } from './ui';

/** A transcript can run to thousands of entries; the newest are what a panel is opened for. */
const RENDERED_ENTRIES = 300;

// Ungrouped, as before: 1234.5k, never 1,234.5k
const tokens = (n: number) =>
  n >= 1000 ? `${formatNumber(n / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })}k` : formatNumber(n, { useGrouping: false });

/** Re-renders every second while `active`, so a running duration ticks. */
function useTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

/**
 * Keeps a scroller pinned to its end while `enabled` and the reader has not scrolled away from it:
 * the same contract as the run's own transcript, so reading upwards is never fought.
 */
function useFollow<T extends HTMLElement>(dependency: unknown, enabled: boolean) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (enabled && pinned.current && el) el.scrollTop = el.scrollHeight;
  }, [dependency, enabled]);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  return { ref, onScroll };
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="kv kv-narrow detail-facts">{children}</dl>;
}

// ---------- background task ----------

function useTask(chatId: string, taskId: string): { task: ChatBackgroundTask | undefined; loading: boolean } {
  const tasks = useChatTasks(chatId);
  return { task: tasks.data?.find((t) => t.id === taskId), loading: tasks.isLoading };
}

function TaskBody({ chatId, taskId }: { chatId: string; taskId: string }) {
  const { t } = useTranslation('components');
  const { open } = useDetailPanel();
  const { task, loading } = useTask(chatId, taskId);
  const running = task?.status === 'running';
  const output = useTaskOutput(chatId, taskId, running);
  useTick(running);
  const follow = useFollow<HTMLDivElement>(output.data?.text, true);

  if (loading) return <Loading />;
  return (
    <>
      {task ? (
        <Facts>
          <dt>{t('detail.status')}</dt>
          <dd>
            <BranchStatus status={task.status} />
            {task.byPerson && (
              <>
                {' '}
                <Tag tone="muted">{t('detail.byYou')}</Tag>
              </>
            )}
          </dd>
          <dt>{t('detail.type')}</dt>
          <dd>{task.kind}</dd>
          <dt>{t('detail.duration')}</dt>
          <dd>{durationBetween(task.startedAt, task.endedAt)}</dd>
          <dt>{t('detail.started')}</dt>
          <dd>{formatDateTime(task.startedAt)}</dd>
          <dt>{t('detail.startedBy')}</dt>
          <dd>
            {task.ownerId ? (
              <>
                <Tag tone="info">{t('detail.fromSubagent')}</Tag>{' '}
                <button type="button" className="link-btn" onClick={() => open({ kind: 'subagent', chatId, agentId: task.ownerId ?? '' })}>
                  {t('detail.openSubagent')}
                </button>
              </>
            ) : (
              <Link to={`/chats/${chatId}`}>{t('detail.theChat')}</Link>
            )}
          </dd>
        </Facts>
      ) : (
        <div className="muted small">{t('detail.taskGone')}</div>
      )}
      {task?.description && <div>{task.description}</div>}
      {task?.command && task.command !== task.description && <CodeBlock code={task.command} lang="bash" />}
      {task?.summary && <div className="muted small">{task.summary}</div>}

      <section className="detail-section detail-section-fill">
        <h3 className="dialog-section">
          {t('detail.output')} {running && <span className="detail-live">{t('detail.live')}</span>}
        </h3>
        {output.isLoading ? (
          <Loading />
        ) : output.error ? (
          <ErrorBox error={output.error} title={t('detail.noOutput')} />
        ) : (
          <div className="detail-output" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root role="region" aria-label={t('detail.taskOutput')} tabIndex={0}>
            {output.data?.cutHead && <div className="muted small">{t('detail.outputCut', { size: Math.round((output.data.bytes ?? 0) / 1024) })}</div>}
            <pre className="task-output">{output.data?.text.trim() || t('detail.noOutputYet')}</pre>
            <ScrollJump screens={1} label="output" />
          </div>
        )}
      </section>
    </>
  );
}

// ---------- subagent and workflow agent ----------

function agentDuration(agent: AgentTranscript): string {
  if (agent.status === 'running') return durationBetween(agent.startedAt, null);
  if (agent.durationMs !== null) return formatDuration(agent.durationMs);
  return durationBetween(agent.startedAt, agent.endedAt);
}

type AgentTarget = Extract<DetailRef, { kind: 'subagent' | 'workflow-agent' }>;

const agentRef = (target: AgentTarget): AgentRef =>
  target.kind === 'subagent'
    ? { chatId: target.chatId, agentId: target.agentId }
    : { chatId: target.chatId, agentId: target.agentId, workflowId: target.workflowId };

function AgentBody({ target }: { target: AgentTarget }) {
  const { t } = useTranslation('components');
  const { open } = useDetailPanel();
  const { data, error, isLoading } = useAgentDetail(agentRef(target), false);
  const running = data?.status === 'running';
  useTick(running);
  const follow = useFollow<HTMLDivElement>(data?.total, running);
  const [showAll, setShowAll] = useState(false);
  const hidden = data && !showAll ? Math.max(0, data.entries.length - RENDERED_ENTRIES) : 0;
  // Held across the tick above: a new array every second would fold the whole transcript again
  const shown = useMemo(() => (data ? (hidden > 0 ? data.entries.slice(hidden) : data.entries) : []), [data, hidden]);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} title={t('detail.agentFailed')} />;

  const { usage } = data;
  return (
    <div className="detail-scroll" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root>
      <Facts>
        <dt>{t('detail.status')}</dt>
        <dd>
          <BranchStatus status={data.status} />
          {data.background && (
            <>
              {' '}
              <Tag tone="muted">{t('detail.background')}</Tag>
            </>
          )}
        </dd>
        <dt>{t('detail.type')}</dt>
        <dd>{data.subagentType ?? (data.kind === 'workflow' ? t('detail.workflowAgentType') : '—')}</dd>
        {data.kind === 'workflow' && (
          <>
            <dt>{t('detail.workflow')}</dt>
            <dd className="mono">{data.workflowRunId}</dd>
            {data.workflowPhase && (
              <>
                <dt>{t('detail.phase')}</dt>
                <dd>{data.workflowPhase}</dd>
              </>
            )}
          </>
        )}
        <dt>{t('detail.duration')}</dt>
        <dd>{agentDuration(data)}</dd>
        <dt>{t('detail.tokens')}</dt>
        <dd>
          {tokens(usage.total)}
          <span className="muted small">
            {' '}
            {t('detail.tokenBreakdown', {
              input: tokens(usage.input),
              output: tokens(usage.output),
              cacheRead: tokens(usage.cacheRead),
              cacheWrite: tokens(usage.cacheCreation),
            })}
          </span>
        </dd>
        <dt>{t('detail.toolCalls')}</dt>
        <dd>{data.toolCalls}</dd>
        {data.model && (
          <>
            <dt>{t('detail.model')}</dt>
            <dd>{data.model}</dd>
          </>
        )}
        {data.cwd && (
          <>
            <dt>{t('detail.directory')}</dt>
            <dd className="mono break">{data.cwd}</dd>
          </>
        )}
        <dt>{t('detail.started')}</dt>
        <dd>{formatDateTime(data.startedAt)}</dd>
        <dt>{t('detail.chat')}</dt>
        <dd className="mono break">
          <Link to={`/chats/${data.sessionId}`}>{data.sessionId}</Link>
        </dd>
      </Facts>

      {data.prompt && (
        <section className="detail-section">
          <Collapsible className="fold" defaultOpen title={<span className="tool-name">{t('detail.prompt')}</span>}>
            <RichText text={data.prompt} />
          </Collapsible>
        </section>
      )}

      {data.tasks.length > 0 && (
        <section className="detail-section">
          <h3 className="dialog-section">{t('detail.tasksLaunched', { count: data.tasks.length })}</h3>
          <div className="stack-tight">
            {data.tasks.map((task) => (
              <div key={task.id} className="side-item">
                <div className="side-item-head">
                  <BranchStatus status={task.status} />
                  <span className="muted small">
                    {task.kind} · {durationBetween(task.startedAt, task.endedAt)}
                  </span>
                </div>
                <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'task', chatId: data.sessionId, taskId: task.id })}>
                  {task.description || task.id}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.result && (
        <section className="detail-section">
          <h3 className="dialog-section">{t('detail.result')}</h3>
          <RichText text={data.result} />
        </section>
      )}

      <section className="detail-section">
        <h3 className="dialog-section">
          {t('detail.transcript', { total: data.total })} {running && <span className="detail-live">{t('detail.live')}</span>}
        </h3>
        {data.entries.length === 0 ? (
          <div className="muted small">{t('detail.nothingYet')}</div>
        ) : (
          <div className="detail-transcript">
            {hidden > 0 && (
              <button type="button" className="btn btn-small" onClick={() => setShowAll(true)}>
                {t('detail.showEarlier', { count: hidden })}
              </button>
            )}
            <Transcript entries={shown} />
          </div>
        )}
      </section>
      <ScrollJump screens={1} label="transcript" />
    </div>
  );
}

// ---------- a whole chat ----------

/**
 * A chat read beside the page that links to it, so following an orchestration's worker does not
 * mean leaving the orchestration. The newest entries only: the chat's own page is one link away.
 */
function ChatBody({ chatId }: { chatId: string }) {
  const { t } = useTranslation('components');
  const { query, chat } = useChatTranscript(chatId, false);
  const working = chat?.state === 'working';
  const follow = useFollow<HTMLDivElement>(query.data?.total, working);
  const held = query.data?.entries;
  const entries = useMemo(() => (held ? held.slice(-RENDERED_ENTRIES) : []), [held]);

  if (query.isLoading) return <Loading />;
  if (!chat || !query.data) return <ErrorBox error={query.error} title={t('detail.chatFailed')} />;

  const path = `/chats/${encodeURIComponent(chat.id)}`;
  return (
    <div className="detail-scroll" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root>
      <Facts>
        <dt>{t('detail.status')}</dt>
        <dd>
          <StateBadge state={chat.state} />
        </dd>
        {chat.model && (
          <>
            <dt>{t('detail.model')}</dt>
            <dd className="mono">{chat.model}</dd>
          </>
        )}
        <dt>{t('detail.directory')}</dt>
        <dd className="mono break">{chat.cwd}</dd>
        {chat.cost.usd !== null && chat.cost.usd > 0 && (
          <>
            <dt>{t('detail.cost')}</dt>
            <dd className="mono">{formatCost(chat.cost.usd)}</dd>
          </>
        )}
        <dt>{t('detail.chat')}</dt>
        <dd>
          <Link to={path}>{t('detail.openChat')}</Link>
        </dd>
      </Facts>
      {chat.activity && <ActivityTicker activity={chat.activity} className="detail-ticker" />}

      <section className="detail-section">
        <h3 className="dialog-section">
          {t('detail.transcript', { total: query.data.total })} {working && <span className="detail-live">{t('detail.live')}</span>}
        </h3>
        {entries.length === 0 ? (
          <div className="muted small">{t('detail.nothingYet')}</div>
        ) : (
          <div className="detail-transcript">
            {query.data.total > entries.length && (
              <Link className="btn btn-small" to={path}>
                {t('detail.earlierInChat', { count: query.data.total - entries.length })}
              </Link>
            )}
            <Transcript entries={entries} />
          </div>
        )}
      </section>
      <ScrollJump screens={1} label="transcript" />
    </div>
  );
}

// ---------- the panel ----------

function ChatTitle({ chatId }: { chatId: string }) {
  const { t } = useTranslation('components');
  const { chat } = useChatTranscript(chatId, false);
  return <span className="ellipsis">{chat?.title || t('detail.chat')}</span>;
}

function TaskTitle({ chatId, taskId }: { chatId: string; taskId: string }) {
  const { t } = useTranslation('components');
  const { task } = useTask(chatId, taskId);
  return <span className="ellipsis">{task?.description || t('detail.backgroundTask')}</span>;
}

function AgentTitle({ target }: { target: AgentTarget }) {
  const { t } = useTranslation('components');
  const { data } = useAgentDetail(agentRef(target), false);
  return (
    <span className="ellipsis">
      {target.kind === 'subagent' ? t('detail.subagent') : t('detail.workflowAgent')}
      {data?.description ? ` · ${data.description}` : ''}
    </span>
  );
}

/**
 * The side panel for one chat, subagent, background task or workflow agent. One dialog serves them
 * all, so opening a task from a subagent's list swaps the content instead of stacking a second panel.
 */
export default function DetailPanel({ target, onClose }: { target: DetailRef; onClose: () => void }) {
  if (target.kind === 'chat') {
    return (
      <Dialog title={<ChatTitle chatId={target.chatId} />} onClose={onClose} variant="drawer" width={760}>
        <ChatBody key={target.chatId} chatId={target.chatId} />
      </Dialog>
    );
  }
  return (
    <Dialog title={target.kind === 'task' ? <TaskTitle chatId={target.chatId} taskId={target.taskId} /> : <AgentTitle target={target} />} onClose={onClose} variant="drawer" width={760}>
      {target.kind === 'task' ? (
        <TaskBody key={`${target.chatId}:${target.taskId}`} chatId={target.chatId} taskId={target.taskId} />
      ) : (
        <AgentBody key={`${target.chatId}:${target.agentId}`} target={target} />
      )}
    </Dialog>
  );
}
