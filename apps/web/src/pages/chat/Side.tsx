import type { Chat, Execution, HealthLevel } from '@agentry/shared';
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { BranchStatus, ContextMeter, OutcomeBadge } from '../../components/ChatBadges';
import { Collapsible } from '../../components/controls/Collapsible';
import { EnvironmentBody } from '../../components/EnvironmentPanel';
import { ICON_SM } from '../../components/icons';
import { Card } from '../../components/ui';
import { WorkflowCard } from '../../components/WorkflowCard';
import { formatTokens } from '../../lib/chat-model';
import { useDetailPanel } from '../../lib/detail';
import { durationBetween, formatCost, formatDateTime, formatNumber, timeAgo } from '../../lib/format';

// Its Select and Combobox are Radix controls kept out of the shell bundle this page lives in
const LiveSettings = lazy(() => import('./Controls').then((m) => ({ default: m.LiveSettings })));

/** Dollars, or the words for a cost nobody reported: it is never estimated, so it is never zero either. */
function useMoney(): (usd: number | null) => string {
  const { t } = useTranslation('chat');
  return (usd) => (usd === null ? t('side.notAvailable') : formatCost(usd));
}

// ---------- context, tokens and cost ----------

export function UsageCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const money = useMoney();
  const { context, cost } = chat;
  // A placeholder message carries no model and no tokens: nothing to show for it
  const rows = cost.tokens.filter((entry) => entry.total > 0);
  return (
    <Card title={t('side.usage.title')}>
      <div className="stack-tight">
        <div>
          <div className="small muted">{t('badges.context.inUse')}</div>
          <ContextMeter chat={chat} wide />
          {context && (
            <div className="small muted">
              {context.window !== null
                ? t('side.usage.tokensOf', { used: formatNumber(context.used), window: formatNumber(context.window) })
                : t('side.usage.tokensUnknownWindow', { used: formatNumber(context.used) })}
            </div>
          )}
        </div>
        <dl className="kv kv-narrow">
          <dt>{t('work:runView.cost')}</dt>
          <dd>
            {money(cost.usd)}
            {cost.usd === null && <div className="small muted">{t('side.usage.costNotReported')}</div>}
          </dd>
        </dl>
        {rows.length > 0 && (
          <table className="chat-tokens">
            <caption className="sr-only">{t('side.usage.tokensCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('work:shared.model')}</th>
                <th scope="col">{t('side.usage.input')}</th>
                <th scope="col">{t('side.usage.output')}</th>
                <th scope="col">{t('side.usage.cache')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.model ?? 'unknown'}>
                  <th scope="row" className="mono">
                    {row.model ?? t('common:status.unknown')}
                  </th>
                  <td>{formatTokens(row.input)}</td>
                  <td>{formatTokens(row.output)}</td>
                  <td>{formatTokens(row.cacheRead + row.cacheCreation)}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row">{t('side.usage.total')}</th>
                  <td>{formatTokens(cost.total.input)}</td>
                  <td>{formatTokens(cost.total.output)}</td>
                  <td>{formatTokens(cost.total.cacheRead + cost.total.cacheCreation)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
        <div className="small muted">{t('side.usage.subagentsNote')}</div>
      </div>
    </Card>
  );
}

// ---------- executions ----------

function ExecutionRow({ execution }: { execution: Execution }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const money = useMoney();
  return (
    <li className="side-item exec">
      <div className="side-item-head">
        <OutcomeBadge outcome={execution.outcome} />
        <span className="small strong">{money(execution.costUsd)}</span>
      </div>
      <div className="meta">
        <span title={formatDateTime(execution.startedAt)}>{timeAgo(execution.startedAt)}</span>
        <span>{execution.endedAt
            ? t('side.executions.lasted', { duration: durationBetween(execution.startedAt, execution.endedAt) })
            : t('side.executions.up', { duration: durationBetween(execution.startedAt, null) })}</span>
        <span>{t('side.executions.turns', { count: execution.turns })}</span>
        <span>{execution.permissionMode}</span>
        {execution.model && <span className="mono">{execution.model}</span>}
        {execution.account && <span>{t('side.executions.account', { name: execution.account })}</span>}
        {execution.maxBudgetUsd !== null && <span>{t('side.executions.budget', { amount: money(execution.maxBudgetUsd) })}</span>}
      </div>
      {execution.error && (
        <div className="alert alert-bad small">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <span className="sr-only">{t('side.executions.errorPrefix')} </span>
            {execution.error}
          </div>
        </div>
      )}
    </li>
  );
}

export function ExecutionsCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const newestFirst = [...chat.executions].reverse();
  return (
    <Card title={t('side.executions.title', { n: chat.executions.length })}>
      {newestFirst.length === 0 ? (
        <div className="muted small">{t('side.executions.empty')}</div>
      ) : (
        <ol className="stack-tight list-plain">
          {newestFirst.map((execution) => (
            <ExecutionRow key={execution.id} execution={execution} />
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------- branches ----------

export function BranchesCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const { open } = useDetailPanel();
  const { subagents, backgroundTasks, workflows } = chat.children;
  const count = subagents.length + backgroundTasks.length + workflows.length;
  return (
    <Card title={t('side.branches.title', { n: count })}>
      {count === 0 ? (
        <div className="muted small">{t('side.branches.empty')}</div>
      ) : (
        <div className="stack">
          {subagents.length > 0 && (
            <section aria-label={t('side.branches.subagents')} className="stack-tight">
              <h3 className="dialog-section">{t('work:runView.subagents', { n: subagents.length })}</h3>
              {subagents.map((sub) => (
                <div key={sub.id} className="side-item">
                  <div className="side-item-head">
                    <BranchStatus status={sub.status} />
                    <span className="muted small">
                      {sub.kind} · {durationBetween(sub.startedAt, sub.endedAt)}
                    </span>
                  </div>
                  <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'subagent', chatId: chat.id, agentId: sub.id })}>
                    {sub.description || sub.kind}
                  </button>
                  {sub.cwd && <span className="mono small muted break">{sub.cwd}</span>}
                  {/* What it launched hangs off it: the chat's own background tasks are only the ones the chat started */}
                  {sub.tasks.map((task) => (
                    <div key={task.id} className="side-item-head">
                      <BranchStatus status={task.status} />
                      <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'task', chatId: chat.id, taskId: task.id })}>
                        {task.description || task.id}
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}
          {backgroundTasks.length > 0 && (
            <section aria-label={t('side.branches.backgroundTasks')} className="stack-tight">
              <h3 className="dialog-section">{t('work:runView.backgroundTasks', { n: backgroundTasks.length })}</h3>
              {backgroundTasks.map((task) => (
                <div key={task.id} className="side-item">
                  <div className="side-item-head">
                    <BranchStatus status={task.status} />
                    <span className="muted small">
                      {task.kind} · {durationBetween(task.startedAt, task.endedAt)}
                      {task.ownerId ? ` · ${t('side.branches.fromSubagent')}` : ''}
                    </span>
                  </div>
                  <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'task', chatId: chat.id, taskId: task.id })}>
                    {task.description || task.id}
                  </button>
                  {task.summary && <div className="muted small">{task.summary}</div>}
                </div>
              ))}
            </section>
          )}
          {workflows.length > 0 && (
            <section aria-label={t('side.branches.workflows')} className="stack-tight">
              <h3 className="dialog-section">{t('work:runView.workflows', { n: workflows.length })}</h3>
              {workflows.map((workflow) => (
                <WorkflowCard key={workflow.id} workflow={workflow} chatId={chat.id} />
              ))}
            </section>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------- health ----------

const NOTE_ICON: Record<HealthLevel, typeof Info> = { ok: CircleCheck, warn: TriangleAlert, bad: TriangleAlert };
// The icon is decorative, so the level is also said in words (side.health.level)

/** What core says of the chat's health: every signal that fired, or the reason it is fine. */
export function HealthCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const { health } = chat;
  const notes: Array<{ kind: string; level: HealthLevel; reason: string }> = health.signals.length > 0 ? health.signals : [{ kind: 'ok', level: 'ok', reason: health.reason }];
  return (
    <Card title={t('side.health.title')}>
      <ul className="chat-notes">
        {notes.map((note) => {
          const Icon = NOTE_ICON[note.level];
          return (
            <li key={note.kind} className={`chat-note chat-note-${note.level}`}>
              <Icon {...ICON_SM} />
              <span>
                <span className="sr-only">{t('side.health.levelSaid', { level: t(`side.health.level.${note.level}`) })} </span>
                {note.reason}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------- facts ----------

export function FactsCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const live = chat.execution;
  const interactive = chat.control.mode === 'interactive';
  return (
    <Card title={t('side.facts.title')}>
      <dl className="kv kv-narrow">
        {interactive ? (
          <Suspense
            fallback={
              <>
                <dt>{t('work:runView.permissions')}</dt>
                <dd>{live?.permissionMode}</dd>
                <dt>{t('work:shared.model')}</dt>
                <dd>{live?.model ?? chat.model ?? t('work:shared.default')}</dd>
              </>
            }
          >
            <LiveSettings chat={chat} />
          </Suspense>
        ) : (
          chat.model && (
            <>
              <dt>{t('work:shared.model')}</dt>
              <dd>{chat.model}</dd>
            </>
          )
        )}
        <dt>{t('work:shared.project')}</dt>
        <dd>{chat.project ? chat.project.name : t('side.facts.noProject')}</dd>
        <dt>{t('work:runView.directory')}</dt>
        <dd className="mono break">{chat.cwd || '—'}</dd>
        {chat.worktree && (
          <>
            <dt>{t('side.facts.worktree')}</dt>
            <dd className="mono break">{chat.worktree.branch ?? chat.worktree.name ?? chat.worktree.path}</dd>
          </>
        )}
        <dt>{t('work:runView.session')}</dt>
        <dd className="mono break">{chat.id}</dd>
        {live && (
          <>
            <dt>{t('work:runView.prompts')}</dt>
            <dd>{t('work:runView.promptsHost')}</dd>
          </>
        )}
        {chat.derivedFrom && (
          <>
            <dt>{t('side.facts.forkedFrom')}</dt>
            <dd>
              <Link to={`/chats/${chat.derivedFrom.chatId}`} className="mono">
                {chat.derivedFrom.chatId.slice(0, 8)}
              </Link>{' '}
              <span className="muted small">{timeAgo(chat.derivedFrom.at)}</span>
            </dd>
          </>
        )}
        {chat.orchestration && (
          <>
            <dt>{t('work:runView.orchestration')}</dt>
            <dd>
              <Link to={`/orchestration/${chat.orchestration.id}`}>{chat.orchestration.name}</Link>
              <div className="small muted">{chat.orchestration.taskName ?? t('view.synthesis')}</div>
            </dd>
          </>
        )}
        <dt>{t('work:runView.started')}</dt>
        <dd>{formatDateTime(chat.startedAt)}</dd>
        <dt>{t('side.facts.updated')}</dt>
        <dd>{formatDateTime(chat.updatedAt)}</dd>
        {chat.cliVersion && (
          <>
            <dt>CLI</dt>
            <dd>{chat.cliVersion}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

export function EnvironmentCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  return (
    <Collapsible
      className="card fold-card"
      title={
        <>
          <span className="fold-card-title">{t('work:runView.loadedByClaude')}</span>
          <span className="small muted">{t('work:runView.loadedHint')}</span>
        </>
      }
    >
      {chat.environment ? <EnvironmentBody env={chat.environment} /> : <div className="small muted">{t('side.facts.environmentEmpty')}</div>}
    </Collapsible>
  );
}
