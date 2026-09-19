import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ChevronLeft, Play, SendHorizontal, Square, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, keys, useRuns, useRunStream } from '../api';
import { Collapsible, Switch, Tooltip } from '../components/controls';
import { EnvironmentPanel } from '../components/EnvironmentPanel';
import { PermissionPrompts } from '../components/PermissionPrompts';
import { isRunLive } from '../components/RunCard';
import { ICON, ICON_SM } from '../components/icons';
import { AnimatePresence, motion, StatusDot, ThinkingDots } from '../components/motion';
import { RunTimeline, StreamingEntry } from '../components/Transcript';
import { Card, Empty, ErrorBox, Loading, StatusBadge, usePageTitle } from '../components/ui';
import { durationBetween, formatCost, formatDateTime } from '../lib/format';

export function RunView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runs = useRuns(1500);
  const run = runs.data?.find((r) => r.id === id);
  usePageTitle(run ? `${run.name} · run` : 'Run');
  const notFound = runs.isSuccess && !run;
  const { events, connected, partial } = useRunStream(id, !notFound);
  const [text, setText] = useState('');
  const [showNoise, setShowNoise] = useState(false);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.runs });
  const send = useMutation({
    mutationFn: (message: string) => api.sendMessage(id, message),
    onSuccess: () => {
      setText('');
      setFollow(true);
      void invalidate();
    },
  });
  const stop = useMutation({ mutationFn: () => api.stopRun(id), onSuccess: invalidate });
  const remove = useMutation({
    mutationFn: () => api.deleteRun(id),
    onSuccess: () => {
      void invalidate();
      navigate('/agents');
    },
  });

  // Stay pinned to the bottom while content grows (stored events and the streaming block alike)
  useEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [events, partial, follow]);

  // Auto-growing composer
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const jumpToLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setFollow(true);
  };

  if (runs.isLoading) return <Loading />;
  if (!run) {
    return (
      <>
        <ErrorBox error={runs.error} />
        <Empty title="Run not found">
          Runs live in memory and are lost when the wrapper restarts. <Link to="/sessions">Browse sessions</Link> to
          resume the conversation.
        </Empty>
      </>
    );
  }

  const live = isRunLive(run);
  const busy = run.status === 'busy' || run.status === 'starting';
  const visible = showNoise ? events : events.filter((e) => e.kind !== 'other' && e.kind !== 'task');
  const submit = () => {
    const message = text.trim();
    if (message && !send.isPending) send.mutate(message);
  };

  return (
    <div className="run-layout">
      <section className="run-main">
        <header className="run-head">
          <div className="run-title">
            <Tooltip content="Back to agents">
              <Link to="/agents" className="icon-btn" aria-label="Back to agents">
                <ChevronLeft {...ICON} />
              </Link>
            </Tooltip>
            <h1 className="ellipsis">{run.name}</h1>
            <StatusBadge status={run.status} />
            <StatusDot tone={connected ? 'ok' : 'warn'} live={connected && live} title={connected ? 'Stream connected' : 'Stream reconnecting…'} />
          </div>
          <div className="page-actions">
            <Switch checked={showNoise} onChange={setShowNoise}>
              All events
            </Switch>
            {live ? (
              <button className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
                <Square {...ICON_SM} />
                Stop
              </button>
            ) : (
              <button className="btn" disabled={remove.isPending} onClick={() => remove.mutate()}>
                <Trash2 {...ICON_SM} />
                Remove
              </button>
            )}
          </div>
        </header>
        <ErrorBox error={stop.error ?? remove.error} />

        <div className="run-stage">
        <div
          className="run-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
        >
          {visible.length === 0 ? <Loading label="Waiting for events…" /> : <RunTimeline events={visible} />}
          {/* Pinned under the transcript: a run waiting on a decision is stuck until it gets one */}
          {run && <PermissionPrompts runId={id} live={isRunLive(run)} />}
          {partial && partial.text ? (
            <StreamingEntry block={partial.block} text={partial.text} />
          ) : (
            busy && (
              <div className="evt evt-working">
                <ThinkingDots /> Claude is working…
              </div>
            )
          )}
        </div>
        <AnimatePresence>
          {!follow && (
            <motion.button
              type="button"
              className="jump-latest"
              onClick={jumpToLatest}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.16 }}
            >
              <ArrowDown {...ICON_SM} /> Jump to latest
            </motion.button>
          )}
        </AnimatePresence>
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={composer}
            rows={1}
            placeholder={
              live
                ? busy
                  ? 'Send a message (queued until the current turn ends)…'
                  : 'Send a follow-up message…'
                : 'Send a message — the session will be resumed…'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || send.isPending}>
            {live ? <SendHorizontal {...ICON_SM} /> : <Play {...ICON_SM} />}
            {send.isPending ? 'Sending…' : live ? 'Send' : 'Resume'}
          </button>
        </form>
        <ErrorBox error={send.error} title="Message not sent" />
      </section>

      <aside className="run-side">
        <Card title="Run">
          <dl className="kv kv-narrow">
            <dt>Model</dt>
            <dd>{run.model ?? 'default'}</dd>
            <dt>Permissions</dt>
            <dd>{run.permissionMode}</dd>
            <dt>Directory</dt>
            <dd className="mono break">{run.cwd}</dd>
            <dt>Session</dt>
            <dd className="mono break">
              {run.sessionId ? <Link to={`/sessions/${run.sessionId}`}>{run.sessionId}</Link> : '—'}
            </dd>
            <dt>PID</dt>
            <dd>{run.pid ?? '—'}</dd>
            <dt>Turns</dt>
            <dd>{run.turns}</dd>
            <dt>Cost</dt>
            <dd>{formatCost(run.costUsd)}</dd>
            <dt>Started</dt>
            <dd>{formatDateTime(run.createdAt)}</dd>
            <dt>{run.endedAt ? 'Lasted' : 'Uptime'}</dt>
            <dd>{durationBetween(run.createdAt, run.endedAt)}</dd>
            {run.orchestrationId && (
              <>
                <dt>Orchestration</dt>
                <dd>
                  <Link to={`/orchestration/${run.orchestrationId}`}>{run.orchestrationTaskId ?? 'open'}</Link>
                </dd>
              </>
            )}
          </dl>
          {run.error && <div className="alert alert-bad small">{run.error}</div>}
        </Card>

        <Card title={`Background tasks (${run.backgroundTasks.length})`}>
          {run.backgroundTasks.length === 0 ? (
            <div className="muted small">None</div>
          ) : (
            <div className="stack-tight">
              {run.backgroundTasks.map((task) => (
                <div key={task.id} className="side-item">
                  <div className="side-item-head">
                    <StatusBadge status={task.status} />
                    <span className="muted small">
                      {task.type} · {durationBetween(task.startedAt, task.endedAt)}
                    </span>
                  </div>
                  <div className="mono small break">{task.description}</div>
                  {task.summary && <div className="muted small">{task.summary}</div>}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title={`Subagents (${run.subagents.length})`}>
          {run.subagents.length === 0 ? (
            <div className="muted small">None</div>
          ) : (
            <div className="stack-tight">
              {run.subagents.map((sub) => (
                <div key={sub.toolUseId} className="side-item">
                  <div className="side-item-head">
                    <StatusBadge status={sub.status} />
                    <span className="muted small">
                      {sub.subagentType} · {durationBetween(sub.startedAt, sub.endedAt)}
                    </span>
                  </div>
                  <div className="small">{sub.description || '—'}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Collapsible
          className="card fold-card"
          title={
            <>
              <span className="fold-card-title">Loaded by Claude</span>
              <span className="small muted">tools, MCP servers, agents, skills…</span>
            </>
          }
        >
          <EnvironmentPanel cwd={run.cwd} live={isRunLive(run)} />
        </Collapsible>
      </aside>
    </div>
  );
}
