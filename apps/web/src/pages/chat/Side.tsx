import type { Chat, Execution, HealthLevel } from '@agentry/shared';
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AnimatedNumber } from '../../components/AnimatedNumber';
import { BranchStatus, ControlBadge, LastOutcome, OriginBadge, OutcomeBadge, StateBadge } from '../../components/ChatBadges';
import { Collapsible } from '../../components/controls/Collapsible';
import { HealthBadge, HealthPanel, isStepIn } from '../../components/observe/Health';
import { EnvironmentBody } from '../../components/EnvironmentPanel';
import { ICON_SM } from '../../components/icons';
import { ProgressRing } from '../../components/motion';
import { CopyButton } from '../../components/ui';
import { WorkflowCard } from '../../components/WorkflowCard';
import { api } from '../../api';
import { contextLevel, contextShare, formatPercent, formatTokens } from '../../lib/chat-model';
import { useDetailPanel } from '../../lib/detail';
import { durationBetween, formatCost, formatDateTime, formatNumber, timeAgo } from '../../lib/format';
import { healthReason, signalReason } from '../../lib/server-strings';

/**
 * One part of the inspector: a heading and what it says, with a rule above instead of a card
 * around it. The heading names the section for a screen reader too.
 */
export function Section({ title, actions, children, className = '' }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`insp-section ${className}`.trim()} aria-labelledby={id}>
      <header className="insp-head">
        <h2 id={id}>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

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
    <>
      <Section title={t('badges.context.inUse')} className="insp-context">
        <div className="insp-context-body">
          <ContextGauge chat={chat} />
          {context ? (
            <div className="small">
              <AnimatedNumber className="mono" value={context.used} format={formatNumber} />{' '}
              {context.window !== null
                ? t('side.usage.tokensOfWindow', { window: formatNumber(context.window) })
                : t('side.usage.tokensWindowUnknown')}
            </div>
          ) : (
            <div className="small muted">{t('badges.context.none')}</div>
          )}
        </div>
      </Section>
      <Section
        title={t('work:runView.cost')}
        actions={
          cost.usd === null ? (
            <span className="small muted">{money(null)}</span>
          ) : (
            <AnimatedNumber className="insp-cost grad-text" value={cost.usd} format={formatCost} />
          )
        }
      >
        {cost.usd === null && <div className="small muted">{t('side.usage.costNotReported')}</div>}
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
      </Section>
    </>
  );
}

/**
 * The context window as a ring with the share in it: the brand's sweep while there is room, and
 * the warning colours as it fills, with the words for them in its accessible value.
 */
function ContextGauge({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const share = contextShare(chat);
  if (share === null || !chat.context) return null;
  const level = contextLevel(share);
  const clamped = Math.min(1, Math.max(0, share));
  const detail = t('badges.context.detail', { used: formatNumber(chat.context.used), window: chat.context.window === null ? '?' : formatNumber(chat.context.window) });
  const note = level === 'full' ? t('badges.context.aboutToCompact') : level === 'warn' ? t('badges.context.fillingUp') : '';
  return (
    <span
      className="insp-context-ring"
      role="meter"
      aria-label={t('badges.context.inUse')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={note ? `${detail}, ${note}` : detail}
    >
      <ProgressRing value={clamped} size={60} stroke={5} tone={level === 'full' ? 'bad' : level === 'warn' ? 'warn' : 'accent'}>
        {formatPercent(share)}
      </ProgressRing>
    </span>
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
    <Section title={t('side.executions.title', { n: chat.executions.length })}>
      {newestFirst.length === 0 ? (
        <div className="muted small">{t('side.executions.empty')}</div>
      ) : (
        <ol className="stack-tight list-plain">
          {newestFirst.map((execution) => (
            <ExecutionRow key={execution.id} execution={execution} />
          ))}
        </ol>
      )}
    </Section>
  );
}

// ---------- branches ----------

export function BranchesCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const { open } = useDetailPanel();
  const { subagents, backgroundTasks, workflows } = chat.children;
  const count = subagents.length + backgroundTasks.length + workflows.length;
  return (
    <Section title={t('side.branches.title', { n: count })}>
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
    </Section>
  );
}

// ---------- health ----------

const NOTE_ICON: Record<HealthLevel, typeof Info> = { ok: CircleCheck, warn: TriangleAlert, bad: TriangleAlert };
// The icon is decorative, so the level is also said in words (side.health.level)

/**
 * What core says of the chat's health: the facts of the chat itself as notes, and the signals a
 * person can step in on with their actions (cancel the command, send a written hint, interrupt).
 */
export function HealthCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const { health } = chat;
  const facts = health.signals.filter((s) => !isStepIn(s));
  const notes: Array<{ kind: string; level: HealthLevel; reason: string }> =
    health.signals.length > 0
      ? facts.map((signal) => ({ kind: signal.kind, level: signal.level, reason: signalReason(signal) }))
      : [{ kind: 'ok', level: 'ok', reason: healthReason(health) }];
  return (
    <Section title={t('side.health.title')} actions={<HealthBadge health={health} />}>
      <HealthPanel health={health} chatId={chat.id} live={Boolean(chat.execution)} badge={false} sendHint={(text) => api.hintChat(chat.id, { text })} />
      {notes.length > 0 && (
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
      )}
    </Section>
  );
}

// ---------- facts ----------

export function FactsCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const live = chat.execution;
  const origin = chat.orchestration ? `${chat.orchestration.name} · ${chat.orchestration.taskName ?? t('view.synthesis')}` : t(`badges.origin.${chat.origin}`);
  return (
    <Section title={t('side.facts.title')}>
      {/* What the header's pill merges, said one by one, with the outcome of the last execution */}
      <div className="chips">
        <StateBadge state={chat.state} />
        <ControlBadge control={chat.control} />
        <LastOutcome chat={chat} />
        <OriginBadge origin={chat.origin} label={origin} />
      </div>
      <dl className="insp-facts">
        <dt>{t('work:runView.permissions')}</dt>
        <dd>
          <span className="badge insp-mode">{live?.permissionMode ?? chat.executions.at(-1)?.permissionMode ?? t('work:shared.default')}</span>
        </dd>
        <dt>{t('work:shared.model')}</dt>
        <dd className="mono">{live?.model ?? chat.model ?? t('work:shared.default')}</dd>
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
        <dd className="mono insp-id">
          <span className="ellipsis">{chat.id}</span> <CopyButton text={chat.id} label={t('view.copyId')} />
        </dd>
        <dt>{t('side.facts.messages')}</dt>
        <dd>{t('view.messages', { count: chat.messageCount })}</dd>
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
    </Section>
  );
}

export function EnvironmentCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  return (
    <Collapsible
      className="fold insp-fold"
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
