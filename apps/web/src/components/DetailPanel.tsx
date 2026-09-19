import type { AgentTranscript, BackgroundTask } from '@agentry/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAgentDetail, useTaskOutput, useTasks, type AgentRef } from '../api';
import { useDetailPanel, type DetailRef } from '../lib/detail';
import { durationBetween, formatDateTime, formatDuration, formatNumber } from '../lib/format';
import { CodeBlock } from './CodeBlock';
import { Collapsible } from './controls/Collapsible';
import { Dialog } from './Dialog';
import { Location } from './Location';
import { ScrollJump } from './ScrollJump';
import { RichText, Transcript } from './Transcript';
import { ErrorBox, Loading, StatusBadge, Tag } from './ui';

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

function useTask(sessionId: string, taskId: string): { task: BackgroundTask | undefined; loading: boolean } {
  const tasks = useTasks();
  return { task: tasks.data?.find((t) => t.id === taskId && t.sessionId === sessionId), loading: tasks.isLoading };
}

function TaskBody({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const { t } = useTranslation('components');
  const { open } = useDetailPanel();
  const { task, loading } = useTask(sessionId, taskId);
  const running = task?.status === 'running';
  const output = useTaskOutput(sessionId, taskId, running);
  useTick(running);
  const follow = useFollow<HTMLDivElement>(output.data?.text, true);

  if (loading) return <Loading />;
  return (
    <>
      {task ? (
        <Facts>
          <dt>{t('detail.status')}</dt>
          <dd>
            <StatusBadge status={task.status} />
            {task.backgroundedByUser && (
              <>
                {' '}
                <Tag tone="muted">{t('detail.byYou')}</Tag>
              </>
            )}
          </dd>
          <dt>{t('detail.type')}</dt>
          <dd>{task.type}</dd>
          <dt>{t('detail.duration')}</dt>
          <dd>{durationBetween(task.startedAt, task.endedAt)}</dd>
          <dt>{t('detail.started')}</dt>
          <dd>{formatDateTime(task.startedAt)}</dd>
          <dt>{t('detail.startedBy')}</dt>
          <dd>
            {task.fromSubagent && (
              <>
                <Tag tone="info">{t('detail.fromSubagent')}</Tag>{' '}
                {task.ownerAgentId && (
                  <button type="button" className="link-btn" onClick={() => open({ kind: 'subagent', sessionId, agentId: task.ownerAgentId ?? '' })}>
                    {t('detail.openSubagent')}
                  </button>
                )}{' '}
              </>
            )}
            {task.runId ? <Link to={`/runs/${task.runId}`}>{task.runName}</Link> : <Link to={`/sessions/${sessionId}`}>{task.runName || t('detail.cliSession')}</Link>}
          </dd>
          <dt>{t('detail.location')}</dt>
          <dd>
            <Location location={task.location} />
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
          <div className="detail-output" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root>
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
    ? { sessionId: target.sessionId, agentId: target.agentId }
    : { sessionId: target.sessionId, agentId: target.agentId, workflowRunId: target.runId };

function AgentBody({ target }: { target: AgentTarget }) {
  const { t } = useTranslation('components');
  const { open } = useDetailPanel();
  const { data, error, isLoading } = useAgentDetail(agentRef(target), false);
  const running = data?.status === 'running';
  useTick(running);
  const follow = useFollow<HTMLDivElement>(data?.total, running);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} title={t('detail.agentFailed')} />;

  const hidden = showAll ? 0 : Math.max(0, data.entries.length - RENDERED_ENTRIES);
  const { usage } = data;
  return (
    <div className="detail-scroll" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root>
      <Facts>
        <dt>{t('detail.status')}</dt>
        <dd>
          <StatusBadge status={data.status} />
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
        <dt>{t('detail.session')}</dt>
        <dd className="mono break">
          <Link to={`/sessions/${data.sessionId}`}>{data.sessionId}</Link>
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
                  <StatusBadge status={task.status} />
                  <span className="muted small">
                    {task.type} · {durationBetween(task.startedAt, task.endedAt)}
                  </span>
                </div>
                <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'task', sessionId: data.sessionId, taskId: task.id })}>
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
            <Transcript entries={hidden > 0 ? data.entries.slice(hidden) : data.entries} />
          </div>
        )}
      </section>
      <ScrollJump screens={1} label="transcript" />
    </div>
  );
}

// ---------- the panel ----------

function TaskTitle({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const { t } = useTranslation('components');
  const { task } = useTask(sessionId, taskId);
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
 * The side panel for one subagent, background task or workflow agent. One dialog serves all three,
 * so opening a task from a subagent's list swaps the content instead of stacking a second panel.
 */
export default function DetailPanel({ target, onClose }: { target: DetailRef; onClose: () => void }) {
  return (
    <Dialog title={target.kind === 'task' ? <TaskTitle sessionId={target.sessionId} taskId={target.taskId} /> : <AgentTitle target={target} />} onClose={onClose} variant="drawer" width={760}>
      {target.kind === 'task' ? (
        <TaskBody key={`${target.sessionId}:${target.taskId}`} sessionId={target.sessionId} taskId={target.taskId} />
      ) : (
        <AgentBody key={`${target.sessionId}:${target.agentId}`} target={target} />
      )}
    </Dialog>
  );
}
