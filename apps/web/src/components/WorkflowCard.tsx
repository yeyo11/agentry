import type { ChatWorkflow, ChatWorkflowAgent } from '@agentry/shared';
import { CircleCheck, CircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useDetailPanel } from '../lib/detail';
import { durationBetween, formatDuration, formatNumber, truncate } from '../lib/format';
import { BranchStatus } from './ChatBadges';
import { CodeBlock } from './CodeBlock';
// Direct import: the chat page that renders this is in the shell bundle
import { Collapsible } from './controls/Collapsible';

// Ungrouped, as before: 1234.5k tokens, never 1,234.5k
const tokens = (n: number | null) =>
  n === null
    ? null
    : n >= 1000
      ? i18n.t('components:workflowCard.tokensThousands', { n: formatNumber(n / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) })
      : i18n.t('components:workflowCard.tokens', { n: formatNumber(n, { useGrouping: false }) });

/** The status is this icon and the word beside it, never a coloured dot alone. */
function AgentIcon({ status }: { status: ChatWorkflowAgent['status'] }) {
  if (status === 'completed') return <CircleCheck className="wf-agent-icon text-ok" size={12} strokeWidth={2} aria-hidden />;
  if (status === 'failed') return <CircleX className="wf-agent-icon text-bad" size={12} strokeWidth={2} aria-hidden />;
  return <span className="spinner spinner-xs wf-agent-icon" aria-hidden />;
}

/** `open` is set when the agent's transcript can be read. */
function AgentRow({ agent, open }: { agent: ChatWorkflowAgent; open: (() => void) | null }) {
  const preview = agent.status === 'completed' ? agent.resultPreview : agent.promptPreview;
  return (
    <li className="wf-agent">
      <AgentIcon status={agent.status} />
      {open ? (
        <button type="button" className="link-btn wf-agent-label" onClick={open}>
          {agent.label}
        </button>
      ) : (
        <span className="wf-agent-label">{agent.label}</span>
      )}
      <span className="muted small wf-agent-meta">
        {[agent.status, agent.durationMs !== null ? formatDuration(agent.durationMs) : null, tokens(agent.tokens)].filter(Boolean).join(' · ')}
      </span>
      {preview && <span className="wf-agent-preview">{agent.status === 'completed' ? '→ ' : ''}{truncate(preview.replace(/\s+/g, ' '), 140)}</span>}
    </li>
  );
}

/** Agents under the phase they ran in, in the order the script declared the phases. */
function byPhase(workflow: ChatWorkflow): Array<[string | null, ChatWorkflowAgent[]]> {
  const groups = new Map<string | null, ChatWorkflowAgent[]>();
  for (const phase of workflow.phases) groups.set(phase, []);
  for (const agent of workflow.agents) {
    const list = groups.get(agent.phase) ?? [];
    list.push(agent);
    groups.set(agent.phase, list);
  }
  return [...groups.entries()].filter(([, agents]) => agents.length > 0);
}

/** One run of a Claude Code workflow inside a chat: its phases, where each agent is, and what it returned. */
export function WorkflowCard({
  workflow,
  chatId,
  phase,
}: {
  workflow: ChatWorkflow;
  chatId: string;
  /** Only the agents of this phase (`null`: those the CLI reported without one); every phase when absent */
  phase?: string | null;
}) {
  const { t } = useTranslation('components');
  const { open } = useDetailPanel();
  const done = workflow.agents.filter((a) => a.status === 'completed').length;
  const total = workflow.agents.length;
  const hasResult = workflow.result !== undefined && workflow.result !== null;
  return (
    <article className="wf-card">
      <header className="wf-head">
        <BranchStatus status={workflow.status} />
        <strong className="wf-name">{workflow.name ?? t('workflowCard.workflow')}</strong>
        <span className="muted small break">{workflow.description !== workflow.name ? workflow.description : ''}</span>
      </header>
      <div className="meta">
        <span>{t('workflowCard.agentsDone', { done, total })}</span>
        <span>{durationBetween(workflow.startedAt, workflow.endedAt)}</span>
        {workflow.totalTokens !== null && <span>{tokens(workflow.totalTokens)}</span>}
      </div>
      {total > 0 && (
        <div className="wf-progress" role="progressbar" aria-label={t('workflowCard.agentsDoneLabel')} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${(done / total) * 100}%` }} />
        </div>
      )}
      {byPhase(workflow)
        .filter(([name]) => phase === undefined || name === phase)
        .map(([name, agents]) => (
          <section key={name ?? ''} className="wf-phase">
            {name && <div className="wf-phase-title">{name}</div>}
            <ul className="wf-agents">
              {agents.map((agent) => (
                <AgentRow
                  key={`${agent.index}:${agent.id ?? agent.label}`}
                  agent={agent}
                  open={agent.id && workflow.id.startsWith('wf_') ? () => open({ kind: 'workflow-agent', chatId, workflowId: workflow.id, agentId: agent.id ?? '' }) : null}
                />
              ))}
            </ul>
          </section>
        ))}
      {(workflow.script || hasResult) && (
        <div className="wf-details">
          {hasResult && (
            <Collapsible className="fold" title={<span className="tool-name">{t('workflowCard.result')}</span>}>
              <CodeBlock code={typeof workflow.result === 'string' ? workflow.result : JSON.stringify(workflow.result, null, 2)} lang={typeof workflow.result === 'string' ? undefined : 'json'} />
            </Collapsible>
          )}
          {workflow.script && (
            <Collapsible className="fold" title={<span className="tool-name">{t('workflowCard.script')}</span>}>
              <CodeBlock code={workflow.script.trim()} lang="js" />
            </Collapsible>
          )}
        </div>
      )}
    </article>
  );
}
