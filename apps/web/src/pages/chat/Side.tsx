import type { Chat, Execution, HealthLevel } from '@agentry/shared';
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { BranchStatus, ContextMeter, OutcomeBadge } from '../../components/ChatBadges';
import { Collapsible } from '../../components/controls/Collapsible';
import { EnvironmentBody } from '../../components/EnvironmentPanel';
import { ICON_SM } from '../../components/icons';
import { Card } from '../../components/ui';
import { WorkflowCard } from '../../components/WorkflowCard';
import { formatTokens, formatUsd } from '../../lib/chat-model';
import { useDetailPanel } from '../../lib/detail';
import { durationBetween, formatDateTime, timeAgo } from '../../lib/format';

// Its Select and Combobox are Radix controls kept out of the shell bundle this page lives in
const LiveSettings = lazy(() => import('./Controls').then((m) => ({ default: m.LiveSettings })));

// ---------- context, tokens and cost ----------

export function UsageCard({ chat }: { chat: Chat }) {
  const { context, cost } = chat;
  // A placeholder message carries no model and no tokens: nothing to show for it
  const rows = cost.tokens.filter((t) => t.total > 0);
  return (
    <Card title="Context and cost">
      <div className="stack-tight">
        <div>
          <div className="small muted">Context in use</div>
          <ContextMeter chat={chat} wide />
          {context && (
            <div className="small muted">
              {context.used.toLocaleString()} tokens{context.window !== null ? ` of ${context.window.toLocaleString()}` : ' · the window of this model is not known yet'}
            </div>
          )}
        </div>
        <dl className="kv kv-narrow">
          <dt>Cost</dt>
          <dd>
            {formatUsd(cost.usd)}
            {cost.usd === null && <div className="small muted">Claude Code reports a cost only for what Agentry launched.</div>}
          </dd>
        </dl>
        {rows.length > 0 && (
          <table className="chat-tokens">
            <caption className="sr-only">Tokens spent, per model</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">In</th>
                <th scope="col">Out</th>
                <th scope="col">Cache</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.model ?? 'unknown'}>
                  <th scope="row" className="mono">
                    {t.model ?? 'unknown'}
                  </th>
                  <td>{formatTokens(t.input)}</td>
                  <td>{formatTokens(t.output)}</td>
                  <td>{formatTokens(t.cacheRead + t.cacheCreation)}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td>{formatTokens(cost.total.input)}</td>
                  <td>{formatTokens(cost.total.output)}</td>
                  <td>{formatTokens(cost.total.cacheRead + cost.total.cacheCreation)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
        <div className="small muted">Tokens include what its subagents spent.</div>
      </div>
    </Card>
  );
}

// ---------- executions ----------

function ExecutionRow({ execution }: { execution: Execution }) {
  return (
    <li className="side-item exec">
      <div className="side-item-head">
        <OutcomeBadge outcome={execution.outcome} />
        <span className="small strong">{formatUsd(execution.costUsd)}</span>
      </div>
      <div className="meta">
        <span title={formatDateTime(execution.startedAt)}>{timeAgo(execution.startedAt)}</span>
        <span>{execution.endedAt ? `lasted ${durationBetween(execution.startedAt, execution.endedAt)}` : `up ${durationBetween(execution.startedAt, null)}`}</span>
        <span>{execution.turns} turns</span>
        <span>{execution.permissionMode}</span>
        {execution.model && <span className="mono">{execution.model}</span>}
        {execution.account && <span>account {execution.account}</span>}
        {execution.maxBudgetUsd !== null && <span>budget {formatUsd(execution.maxBudgetUsd)}</span>}
      </div>
      {execution.error && (
        <div className="alert alert-bad small">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <span className="sr-only">Error: </span>
            {execution.error}
          </div>
        </div>
      )}
    </li>
  );
}

export function ExecutionsCard({ chat }: { chat: Chat }) {
  const newestFirst = [...chat.executions].reverse();
  return (
    <Card title={`Executions (${chat.executions.length})`}>
      {newestFirst.length === 0 ? (
        <div className="muted small">Agentry has not run this chat: it was written in a terminal.</div>
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
  const { open } = useDetailPanel();
  const { subagents, backgroundTasks, workflows } = chat.children;
  const count = subagents.length + backgroundTasks.length + workflows.length;
  return (
    <Card title={`Branches (${count})`}>
      {count === 0 ? (
        <div className="muted small">Nothing was delegated: no subagents, background tasks or workflows.</div>
      ) : (
        <div className="stack">
          {subagents.length > 0 && (
            <section aria-label="Subagents" className="stack-tight">
              <h3 className="dialog-section">Subagents ({subagents.length})</h3>
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
            <section aria-label="Background tasks" className="stack-tight">
              <h3 className="dialog-section">Background tasks ({backgroundTasks.length})</h3>
              {backgroundTasks.map((task) => (
                <div key={task.id} className="side-item">
                  <div className="side-item-head">
                    <BranchStatus status={task.status} />
                    <span className="muted small">
                      {task.kind} · {durationBetween(task.startedAt, task.endedAt)}
                      {task.ownerId ? ' · from a subagent' : ''}
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
            <section aria-label="Workflows" className="stack-tight">
              <h3 className="dialog-section">Workflows ({workflows.length})</h3>
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
// The icon is decorative, so the level is also said in words
const NOTE_LEVEL: Record<HealthLevel, string> = { ok: 'OK', warn: 'Warning', bad: 'Problem' };

/** What core says of the chat's health: every signal that fired, or the reason it is fine. */
export function HealthCard({ chat }: { chat: Chat }) {
  const { health } = chat;
  const notes: Array<{ kind: string; level: HealthLevel; reason: string }> = health.signals.length > 0 ? health.signals : [{ kind: 'ok', level: 'ok', reason: health.reason }];
  return (
    <Card title="Health">
      <ul className="chat-notes">
        {notes.map((note) => {
          const Icon = NOTE_ICON[note.level];
          return (
            <li key={note.kind} className={`chat-note chat-note-${note.level}`}>
              <Icon {...ICON_SM} />
              <span>
                <span className="sr-only">{NOTE_LEVEL[note.level]}: </span>
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
  const live = chat.execution;
  const interactive = chat.control.mode === 'interactive';
  return (
    <Card title="Chat">
      <dl className="kv kv-narrow">
        {interactive ? (
          <Suspense
            fallback={
              <>
                <dt>Permissions</dt>
                <dd>{live?.permissionMode}</dd>
                <dt>Model</dt>
                <dd>{live?.model ?? chat.model ?? 'default'}</dd>
              </>
            }
          >
            <LiveSettings chat={chat} />
          </Suspense>
        ) : (
          chat.model && (
            <>
              <dt>Model</dt>
              <dd>{chat.model}</dd>
            </>
          )
        )}
        <dt>Project</dt>
        <dd>{chat.project ? chat.project.name : 'none: loose chat'}</dd>
        <dt>Directory</dt>
        <dd className="mono break">{chat.cwd || '—'}</dd>
        {chat.worktree && (
          <>
            <dt>Worktree</dt>
            <dd className="mono break">{chat.worktree.branch ?? chat.worktree.name ?? chat.worktree.path}</dd>
          </>
        )}
        <dt>Session</dt>
        <dd className="mono break">{chat.id}</dd>
        {live && (
          <>
            <dt>Prompts</dt>
            <dd>answered here</dd>
          </>
        )}
        {chat.derivedFrom && (
          <>
            <dt>Forked from</dt>
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
            <dt>Orchestration</dt>
            <dd>
              <Link to={`/orchestration/${chat.orchestration.id}`}>{chat.orchestration.name}</Link>
              <div className="small muted">{chat.orchestration.taskName ?? 'synthesis'}</div>
            </dd>
          </>
        )}
        <dt>Started</dt>
        <dd>{formatDateTime(chat.startedAt)}</dd>
        <dt>Updated</dt>
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
  return (
    <Collapsible
      className="card fold-card"
      title={
        <>
          <span className="fold-card-title">Loaded by Claude</span>
          <span className="small muted">tools, MCP servers, agents, skills…</span>
        </>
      }
    >
      {chat.environment ? <EnvironmentBody env={chat.environment} /> : <div className="small muted">Nothing has reported what Claude loaded for this chat yet.</div>}
    </Collapsible>
  );
}
