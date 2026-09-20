import type { AgentTranscript, ChatBackgroundTask } from '@agentry/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAgentDetail, useChatTasks, useTaskOutput, type AgentRef } from '../lib/chats';
import { useDetailPanel, type DetailRef } from '../lib/detail';
import { durationBetween, formatDateTime, formatDuration } from '../lib/format';
import { CodeBlock } from './CodeBlock';
import { Collapsible } from './controls/Collapsible';
import { Dialog } from './Dialog';
import { ScrollJump } from './ScrollJump';
import { RichText, Transcript } from './Transcript';
import { BranchStatus } from './ChatBadges';
import { ErrorBox, Loading, Tag } from './ui';

/** A transcript can run to thousands of entries; the newest are what a panel is opened for. */
const RENDERED_ENTRIES = 300;

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

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
          <dt>Status</dt>
          <dd>
            <BranchStatus status={task.status} />
            {task.byPerson && (
              <>
                {' '}
                <Tag tone="muted">by you</Tag>
              </>
            )}
          </dd>
          <dt>Type</dt>
          <dd>{task.kind}</dd>
          <dt>Duration</dt>
          <dd>{durationBetween(task.startedAt, task.endedAt)}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(task.startedAt)}</dd>
          <dt>Started by</dt>
          <dd>
            {task.ownerId ? (
              <>
                <Tag tone="info">a subagent</Tag>{' '}
                <button type="button" className="link-btn" onClick={() => open({ kind: 'subagent', chatId, agentId: task.ownerId ?? '' })}>
                  open it
                </button>
              </>
            ) : (
              <Link to={`/chats/${chatId}`}>the chat</Link>
            )}
          </dd>
        </Facts>
      ) : (
        <div className="muted small">This task is no longer listed; what it wrote is still shown below.</div>
      )}
      {task?.description && <div>{task.description}</div>}
      {task?.command && task.command !== task.description && <CodeBlock code={task.command} lang="bash" />}
      {task?.summary && <div className="muted small">{task.summary}</div>}

      <section className="detail-section detail-section-fill">
        <h3 className="dialog-section">
          Output {running && <span className="detail-live">live</span>}
        </h3>
        {output.isLoading ? (
          <Loading />
        ) : output.error ? (
          <ErrorBox error={output.error} title="No output to show" />
        ) : (
          <div className="detail-output" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root>
            {output.data?.cutHead && <div className="muted small">Showing the end of {Math.round((output.data.bytes ?? 0) / 1024)} KiB of output.</div>}
            <pre className="task-output">{output.data?.text.trim() || '(no output yet)'}</pre>
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
  const { open } = useDetailPanel();
  const { data, error, isLoading } = useAgentDetail(agentRef(target), false);
  const running = data?.status === 'running';
  useTick(running);
  const follow = useFollow<HTMLDivElement>(data?.total, running);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} title="Could not read this agent" />;

  const hidden = showAll ? 0 : Math.max(0, data.entries.length - RENDERED_ENTRIES);
  const { usage } = data;
  return (
    <div className="detail-scroll" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root>
      <Facts>
        <dt>Status</dt>
        <dd>
          <BranchStatus status={data.status} />
          {data.background && (
            <>
              {' '}
              <Tag tone="muted">background</Tag>
            </>
          )}
        </dd>
        <dt>Type</dt>
        <dd>{data.subagentType ?? (data.kind === 'workflow' ? 'workflow agent' : '—')}</dd>
        {data.kind === 'workflow' && (
          <>
            <dt>Workflow</dt>
            <dd className="mono">{data.workflowRunId}</dd>
            {data.workflowPhase && (
              <>
                <dt>Phase</dt>
                <dd>{data.workflowPhase}</dd>
              </>
            )}
          </>
        )}
        <dt>Duration</dt>
        <dd>{agentDuration(data)}</dd>
        <dt>Tokens</dt>
        <dd>
          {tokens(usage.total)}
          <span className="muted small">
            {' '}
            · in {tokens(usage.input)} · out {tokens(usage.output)} · cache read {tokens(usage.cacheRead)} · cache write {tokens(usage.cacheCreation)}
          </span>
        </dd>
        <dt>Tool calls</dt>
        <dd>{data.toolCalls}</dd>
        {data.model && (
          <>
            <dt>Model</dt>
            <dd>{data.model}</dd>
          </>
        )}
        {data.cwd && (
          <>
            <dt>Directory</dt>
            <dd className="mono break">{data.cwd}</dd>
          </>
        )}
        <dt>Started</dt>
        <dd>{formatDateTime(data.startedAt)}</dd>
        <dt>Chat</dt>
        <dd className="mono break">
          <Link to={`/chats/${data.sessionId}`}>{data.sessionId}</Link>
        </dd>
      </Facts>

      {data.prompt && (
        <section className="detail-section">
          <Collapsible className="fold" defaultOpen title={<span className="tool-name">Prompt</span>}>
            <RichText text={data.prompt} />
          </Collapsible>
        </section>
      )}

      {data.tasks.length > 0 && (
        <section className="detail-section">
          <h3 className="dialog-section">Background tasks it launched ({data.tasks.length})</h3>
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
          <h3 className="dialog-section">Result</h3>
          <RichText text={data.result} />
        </section>
      )}

      <section className="detail-section">
        <h3 className="dialog-section">
          Transcript ({data.total}) {running && <span className="detail-live">live</span>}
        </h3>
        {data.entries.length === 0 ? (
          <div className="muted small">Nothing written yet.</div>
        ) : (
          <div className="detail-transcript">
            {hidden > 0 && (
              <button type="button" className="btn btn-small" onClick={() => setShowAll(true)}>
                Show {hidden} earlier {hidden === 1 ? 'entry' : 'entries'}
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

function TaskTitle({ chatId, taskId }: { chatId: string; taskId: string }) {
  const { task } = useTask(chatId, taskId);
  return <span className="ellipsis">{task?.description || 'Background task'}</span>;
}

function AgentTitle({ target }: { target: AgentTarget }) {
  const { data } = useAgentDetail(agentRef(target), false);
  return (
    <span className="ellipsis">
      {target.kind === 'subagent' ? 'Subagent' : 'Workflow agent'}
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
    <Dialog title={target.kind === 'task' ? <TaskTitle chatId={target.chatId} taskId={target.taskId} /> : <AgentTitle target={target} />} onClose={onClose} variant="drawer" width={760}>
      {target.kind === 'task' ? (
        <TaskBody key={`${target.chatId}:${target.taskId}`} chatId={target.chatId} taskId={target.taskId} />
      ) : (
        <AgentBody key={`${target.chatId}:${target.agentId}`} target={target} />
      )}
    </Dialog>
  );
}
