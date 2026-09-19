import type { WorkflowAgentState, WorkflowRun } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import i18n from '../i18n';
import { useDetailPanel } from '../lib/detail';
import { durationBetween, formatDuration, formatNumber, truncate } from '../lib/format';
import { CodeBlock } from './CodeBlock';
// Direct import: the run view that renders this is in the shell bundle
import { Collapsible } from './controls/Collapsible';
import { Location } from './Location';
import { StatusBadge } from './ui';

// Ungrouped, as before: 1234.5k tokens, never 1,234.5k
const tokens = (n: number | null) =>
  n === null
    ? null
    : n >= 1000
      ? i18n.t('components:workflowCard.tokensThousands', { n: formatNumber(n / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) })
      : i18n.t('components:workflowCard.tokens', { n: formatNumber(n, { useGrouping: false }) });

/** The CLI's agent states, in the tones the rest of the panel uses. */
const tone = (state: string) => (state === 'done' ? 'ok' : state === 'error' ? 'bad' : 'active');

/** `open` is set when the agent's transcript can be read: it needs the session and the workflow's `wf_…` id. */
function AgentRow({ agent, open }: { agent: WorkflowAgentState; open: (() => void) | null }) {
  const preview = agent.state === 'done' ? agent.resultPreview : agent.promptPreview;
  return (
    <li className="wf-agent">
      <span className={`wf-dot wf-dot-${tone(agent.state)}`} aria-label={agent.state} />
      {open ? (
        <button type="button" className="link-btn wf-agent-label" onClick={open}>
          {agent.label}
        </button>
      ) : (
        <span className="wf-agent-label">{agent.label}</span>
      )}
      <span className="muted small wf-agent-meta">
        {[agent.state === 'done' || agent.state === 'error' ? null : agent.state, agent.durationMs !== null ? formatDuration(agent.durationMs) : null, tokens(agent.tokens)]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {preview && <span className="wf-agent-preview">{agent.state === 'done' ? '→ ' : ''}{truncate(preview.replace(/\s+/g, ' '), 140)}</span>}
    </li>
  );
}

/** Agents under the phase they ran in, in the order the script declared the phases. */
function byPhase(workflow: WorkflowRun): Array<[string | null, WorkflowAgentState[]]> {
  const groups = new Map<string | null, WorkflowAgentState[]>();
  for (const phase of workflow.phases) groups.set(phase, []);
  for (const agent of workflow.agents) {
    const list = groups.get(agent.phaseTitle) ?? [];
    list.push(agent);
    groups.set(agent.phaseTitle, list);
  }
  return [...groups.entries()].filter(([, agents]) => agents.length > 0);
}

/**
 * One run of a Claude Code workflow: its phases, where each agent is, and what it returned.
 * `compact` drops who started it, for places that already say so, like the run's own page.
 */
export function WorkflowCard({ workflow, compact = false, sessionId }: { workflow: WorkflowRun; compact?: boolean; sessionId?: string }) {
  const { t } = useTranslation('components');
  const { open } = useDetailPanel();
  // A run's workflows carry no session of their own; the page that knows the run passes it
  const session = workflow.sessionId ?? sessionId;
  const done = workflow.agents.filter((a) => a.state === 'done').length;
  const total = workflow.agents.length;
  const hasResult = workflow.result !== undefined && workflow.result !== null;
  return (
    <article className="wf-card">
      <header className="wf-head">
        <StatusBadge status={workflow.status} />
        <strong className="wf-name">{workflow.name ?? t('workflowCard.workflow')}</strong>
        <span className="muted small ellipsis">{workflow.description !== workflow.name ? workflow.description : ''}</span>
      </header>
      <div className="meta">
        {!compact &&
          (workflow.runId ? (
            <Link to={`/runs/${workflow.runId}`}>{workflow.runName}</Link>
          ) : (
            <Link to={`/sessions/${workflow.sessionId ?? ''}`}>{workflow.runName || t('workflowCard.cliSession')}</Link>
          ))}
        {!compact && <Location location={workflow.location} />}
        <span>{t('workflowCard.agentsDone', { done, total })}</span>
        <span>{durationBetween(workflow.startedAt, workflow.endedAt)}</span>
        {workflow.totalTokens !== null && <span>{tokens(workflow.totalTokens)}</span>}
      </div>
      {total > 0 && (
        <div className="wf-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${(done / total) * 100}%` }} />
        </div>
      )}
      {byPhase(workflow).map(([phase, agents]) => (
        <section key={phase ?? ''} className="wf-phase">
          {phase && <div className="wf-phase-title">{phase}</div>}
          <ul className="wf-agents">
            {agents.map((agent) => (
              <AgentRow
                key={`${agent.index}:${agent.agentId ?? agent.label}`}
                agent={agent}
                open={
                  session && agent.agentId && workflow.id.startsWith('wf_')
                    ? () => open({ kind: 'workflow-agent', sessionId: session, runId: workflow.id, agentId: agent.agentId ?? '' })
                    : null
                }
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
