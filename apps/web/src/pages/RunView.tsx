import type { TranscriptSearchHit } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ChevronLeft, CircleSlash, Play, SendHorizontal, Square, Trash2 } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, keys, useRuns, useRunStream } from '../api';
// Direct imports: this page is in the shell bundle, and the barrel would pull the lazy form controls into it
import { Collapsible } from '../components/controls/Collapsible';
import { Switch } from '../components/controls/Toggle';
import { Tooltip } from '../components/controls/Tooltip';
import { AttachButton, AttachmentTray, useAttachments } from '../components/Attachments';
import { EnvironmentPanel } from '../components/EnvironmentPanel';
import { PermissionPrompts } from '../components/PermissionPrompts';
import { isRunLive } from '../components/RunCard';
import { ICON, ICON_SM } from '../components/icons';
import { AnimatePresence, motion, StatusDot, ThinkingDots } from '../components/motion';
import { RunTimeline, StreamingEntry } from '../components/Transcript';
import { FindBar, FindButton, useFindFocus, useFindHighlight, useTranscriptFind } from '../components/TranscriptSearch';
import { WorkflowCard } from '../components/WorkflowCard';
import { Card, Empty, ErrorBox, Loading, StatusBadge, Tag, usePageTitle } from '../components/ui';
import { useDetailPanel } from '../lib/detail';
import { durationBetween, formatCost, formatDateTime } from '../lib/format';

// Its Select and Combobox are Radix controls kept out of the shell bundle this page lives in
const RunSettings = lazy(() => import('../components/RunSettings'));

/**
 * The message box, with its own text state: the transcript above it can be thousands of nodes, and
 * re-rendering the page on every character typed here is enough to lock the tab up.
 */
function Composer({ runId, live, busy, onSent }: { runId: string; live: boolean; busy: boolean; onSent: () => void }) {
  const { t } = useTranslation(['work', 'common']);
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const files = useAttachments();
  const box = useRef<HTMLTextAreaElement>(null);

  const send = useMutation({
    mutationFn: (message: string) => api.sendMessage(runId, message, files.ids),
    onSuccess: () => {
      setText('');
      files.clear();
      onSent();
      void queryClient.invalidateQueries({ queryKey: keys.runs });
    },
  });

  // Auto-growing composer
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    const message = text.trim();
    // A file on its own is a message too; one still uploading is not sent without it
    if ((message || files.ids.length) && !files.uploading && !send.isPending) send.mutate(message);
  };

  return (
    <>
      <div {...files.dropProps}>
        <AttachmentTray state={files} />
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <AttachButton state={files} compact disabled={send.isPending} />
          <textarea
            onPaste={files.onPaste}
            ref={box}
            rows={1}
            placeholder={
              live
                ? busy
                  ? t('runView.placeholderQueued')
                  : t('runView.placeholderFollowUp')
                : t('runView.placeholderResume')
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
          <button
            type="submit"
            className="btn btn-primary"
            disabled={(!text.trim() && files.ids.length === 0) || files.uploading || send.isPending}
          >
            {live ? <SendHorizontal {...ICON_SM} /> : <Play {...ICON_SM} />}
            {send.isPending
              ? t('runView.sending')
              : files.uploading
                ? t('shared.uploading')
                : live
                  ? t('runView.send')
                  : t('runView.resume')}
          </button>
        </form>
      </div>
      <ErrorBox error={send.error} title={t('runView.notSent')} />
    </>
  );
}

export function RunView() {
  const { t } = useTranslation(['work', 'common']);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runs = useRuns();
  const run = runs.data?.find((r) => r.id === id);
  usePageTitle(run ? t('runView.pageTitle', { name: run.name }) : t('runView.pageTitleFallback'));
  const notFound = runs.isSuccess && !run;
  const { events, connected, partial, from, more, loadingMore, loadEarlier, reach } = useRunStream(id, !notFound);
  const { open: openDetail } = useDetailPanel();
  const [showNoise, setShowNoise] = useState(false);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const find = useTranscriptFind({
    scope: ['run', id],
    search: useCallback((q: string) => api.searchRun(id, q), [id]),
    keep: useCallback((hit: TranscriptSearchHit) => showNoise || (hit.kind !== 'other' && hit.kind !== 'task'), [showNoise]),
  });
  const focus = useFindFocus(find.target, events, from, reach);
  useFindHighlight(scroller, find);
  // Jumping to a hit is the reader moving: the bottom must not pull them back
  useEffect(() => {
    if (find.target) setFollow(false);
  }, [find.target]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.runs });
  const stop = useMutation({ mutationFn: () => api.stopRun(id), onSuccess: invalidate });
  const interrupt = useMutation({ mutationFn: () => api.interruptRun(id), onSuccess: invalidate });
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

  const visible = useMemo(
    () => (showNoise ? events : events.filter((e) => e.kind !== 'other' && e.kind !== 'task')),
    [events, showNoise],
  );

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
        <Empty title={t('runView.notFound')}>
          <Trans t={t} i18nKey="runView.notFoundHint" components={{ link: <Link to="/sessions" /> }} />
        </Empty>
      </>
    );
  }

  const live = isRunLive(run);
  const busy = run.status === 'busy' || run.status === 'starting';

  return (
    <div className="run-layout">
      <section className="run-main">
        <header className="run-head">
          <div className="run-title">
            <Tooltip content={t('runView.backToAgents')}>
              <Link to="/agents" className="icon-btn" aria-label={t('runView.backToAgents')}>
                <ChevronLeft {...ICON} />
              </Link>
            </Tooltip>
            <h1 className="ellipsis">{run.name}</h1>
            <StatusBadge status={run.status} />
            <StatusDot tone={connected ? 'ok' : 'warn'} live={connected && live} title={connected ? t('runView.streamConnected') : t('runView.streamReconnecting')} />
          </div>
          <div className="page-actions">
            <FindButton find={find} />
            <Switch checked={showNoise} onChange={setShowNoise}>
              {t('runView.allEvents')}
            </Switch>
            {busy && run.pid !== null && (
              <Tooltip content={t('runView.interruptHint')}>
                <button className="btn" disabled={interrupt.isPending} onClick={() => interrupt.mutate()}>
                  <CircleSlash {...ICON_SM} />
                  {t('runView.interrupt')}
                </button>
              </Tooltip>
            )}
            {live ? (
              <button className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
                <Square {...ICON_SM} />
                {t('common:actions.stop')}
              </button>
            ) : (
              <button className="btn" disabled={remove.isPending} onClick={() => remove.mutate()}>
                <Trash2 {...ICON_SM} />
                {t('common:actions.remove')}
              </button>
            )}
          </div>
        </header>
        <ErrorBox error={stop.error ?? interrupt.error ?? remove.error} />
        <FindBar find={find} />

        <div className="run-stage">
        <div
          className="run-scroll"
          data-scroll-root
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
        >
          {more && (
            <div className="transcript-earlier">
              <button type="button" className="btn btn-small" onClick={loadEarlier} disabled={loadingMore}>
                {loadingMore ? t('common:loading') : t('runView.loadEarlier', { n: from })}
              </button>
            </div>
          )}
          {visible.length === 0 ? (
            <Loading label={t('runView.waiting')} />
          ) : (
            <RunTimeline events={visible} follow={follow} onReachTop={loadEarlier} focus={focus} />
          )}
          {/* Pinned under the transcript: a run waiting on a decision is stuck until it gets one */}
          {run && <PermissionPrompts runId={id} live={isRunLive(run)} />}
          {partial && partial.text ? (
            <StreamingEntry block={partial.block} text={partial.text} />
          ) : (
            busy && (
              <div className="evt evt-working">
                <ThinkingDots /> {t('runView.working')}
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
              <ArrowDown {...ICON_SM} /> {t('runView.jumpToLatest')}
            </motion.button>
          )}
        </AnimatePresence>
        </div>

        <Composer runId={id} live={live} busy={busy} onSent={() => setFollow(true)} />
      </section>

      <aside className="run-side">
        <Card title={t('runView.runCard')}>
          <dl className="kv kv-narrow">
            <Suspense
              fallback={
                <>
                  <dt>{t('runView.permissions')}</dt>
                  <dd>{run.permissionMode}</dd>
                  <dt>{t('shared.model')}</dt>
                  <dd>{run.model ?? t('shared.default')}</dd>
                </>
              }
            >
              <RunSettings run={run} />
            </Suspense>
            <dt>{t('runView.prompts')}</dt>
            <dd>{run.permissionPrompts === 'host' ? t('runView.promptsHost') : t('runView.promptsNone')}</dd>
            <dt>{t('runView.directory')}</dt>
            <dd className="mono break">{run.cwd}</dd>
            <dt>{t('runView.session')}</dt>
            <dd className="mono break">
              {run.sessionId ? <Link to={`/sessions/${run.sessionId}`}>{run.sessionId}</Link> : '—'}
            </dd>
            <dt>{t('runView.pid')}</dt>
            <dd>{run.pid ?? '—'}</dd>
            <dt>{t('runView.turns')}</dt>
            <dd>{run.turns}</dd>
            <dt>{t('runView.cost')}</dt>
            <dd>{formatCost(run.costUsd)}</dd>
            <dt>{t('runView.started')}</dt>
            <dd>{formatDateTime(run.createdAt)}</dd>
            <dt>{run.endedAt ? t('runView.lasted') : t('runView.uptime')}</dt>
            <dd>{durationBetween(run.createdAt, run.endedAt)}</dd>
            {run.orchestrationId && (
              <>
                <dt>{t('runView.orchestration')}</dt>
                <dd>
                  <Link to={`/orchestration/${run.orchestrationId}`}>{run.orchestrationTaskId ?? t('runView.openOrchestration')}</Link>
                </dd>
              </>
            )}
          </dl>
          {run.error && <div className="alert alert-bad small">{run.error}</div>}
        </Card>

        <Card title={t('runView.backgroundTasks', { n: run.backgroundTasks.length })}>
          {run.backgroundTasks.length === 0 ? (
            <div className="muted small">{t('runView.noTasks')}</div>
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
                  <div className="mono small break">
                    {run.sessionId ? (
                      <button type="button" className="link-btn detail-task-link" onClick={() => openDetail({ kind: 'task', sessionId: task.sessionId ?? run.sessionId ?? '', taskId: task.id })}>
                        {task.description || task.id}
                      </button>
                    ) : (
                      task.description
                    )}
                    {task.fromSubagent && (
                      <>
                        {' '}
                        <Tag tone="info">{t('shared.fromSubagent')}</Tag>
                      </>
                    )}
                  </div>
                  {task.summary && <div className="muted small">{task.summary}</div>}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title={t('runView.subagents', { n: run.subagents.length })}>
          {run.subagents.length === 0 ? (
            <div className="muted small">{t('runView.noSubagents')}</div>
          ) : (
            <div className="stack-tight">
              {run.subagents.map((sub) => (
                <div key={sub.toolUseId} className="side-item">
                  <div className="side-item-head">
                    <StatusBadge status={sub.status} />
                    <span className="muted small">
                      {sub.subagentType}
                      {sub.background ? ` · ${t('shared.background')}` : ''} · {durationBetween(sub.startedAt, sub.endedAt)}
                    </span>
                  </div>
                  <div className="small">
                    {/* The agent id arrives with its first task event, a moment after the tool call */}
                    {run.sessionId && sub.agentId ? (
                      <button
                        type="button"
                        className="link-btn detail-task-link"
                        onClick={() => openDetail({ kind: 'subagent', sessionId: sub.sessionId ?? run.sessionId ?? '', agentId: sub.agentId ?? '' })}
                      >
                        {sub.description || sub.subagentType}
                      </button>
                    ) : (
                      sub.description || '—'
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {(run.workflows?.length ?? 0) > 0 && (
          <Card title={t('runView.workflows', { n: run.workflows?.length ?? 0 })}>
            <div className="stack-tight">
              {(run.workflows ?? []).map((workflow) => (
                <WorkflowCard key={workflow.id} workflow={workflow} compact sessionId={run.sessionId ?? undefined} />
              ))}
            </div>
          </Card>
        )}

        <Collapsible
          className="card fold-card"
          title={
            <>
              <span className="fold-card-title">{t('runView.loadedByClaude')}</span>
              <span className="small muted">{t('runView.loadedHint')}</span>
            </>
          }
        >
          <EnvironmentPanel cwd={run.cwd} live={isRunLive(run)} />
        </Collapsible>
      </aside>
    </div>
  );
}
