import type { WorkflowAgentState, WorkflowRun } from '@agentry/shared';
import { Link } from 'react-router-dom';
import { durationBetween, formatDuration, truncate } from '../lib/format';
import { CodeBlock } from './CodeBlock';
// Direct import: the run view that renders this is in the shell bundle
import { Collapsible } from './controls/Collapsible';
import { Location } from './Location';
import { StatusBadge } from './ui';

const tokens = (n: number | null) => (n === null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`);

/** The CLI's agent states, in the tones the rest of the panel uses. */
const tone = (state: string) => (state === 'done' ? 'ok' : state === 'error' ? 'bad' : 'active');

function AgentRow({ agent }: { agent: WorkflowAgentState }) {
  const preview = agent.state === 'done' ? agent.resultPreview : agent.promptPreview;
  return (
    <li className="wf-agent">
      <span className={`wf-dot wf-dot-${tone(agent.state)}`} aria-label={agent.state} />
      <span className="wf-agent-label">{agent.label}</span>
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
export function WorkflowCard({ workflow, compact = false }: { workflow: WorkflowRun; compact?: boolean }) {
  const done = workflow.agents.filter((a) => a.state === 'done').length;
  const total = workflow.agents.length;
  const hasResult = workflow.result !== undefined && workflow.result !== null;
  return (
    <article className="wf-card">
      <header className="wf-head">
        <StatusBadge status={workflow.status} />
        <strong className="wf-name">{workflow.name ?? 'workflow'}</strong>
        <span className="muted small ellipsis">{workflow.description !== workflow.name ? workflow.description : ''}</span>
      </header>
      <div className="meta">
        {!compact &&
          (workflow.runId ? (
            <Link to={`/runs/${workflow.runId}`}>{workflow.runName}</Link>
          ) : (
            <Link to={`/sessions/${workflow.sessionId ?? ''}`}>{workflow.runName || 'CLI session'}</Link>
          ))}
        {!compact && <Location location={workflow.location} />}
        <span>
          {done}/{total} agents done
        </span>
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
              <AgentRow key={`${agent.index}:${agent.agentId ?? agent.label}`} agent={agent} />
            ))}
          </ul>
        </section>
      ))}
      {(workflow.script || hasResult) && (
        <div className="wf-details">
          {hasResult && (
            <Collapsible className="fold" title={<span className="tool-name">Result</span>}>
              <CodeBlock code={typeof workflow.result === 'string' ? workflow.result : JSON.stringify(workflow.result, null, 2)} lang={typeof workflow.result === 'string' ? undefined : 'json'} />
            </Collapsible>
          )}
          {workflow.script && (
            <Collapsible className="fold" title={<span className="tool-name">Script</span>}>
              <CodeBlock code={workflow.script.trim()} lang="js" />
            </Collapsible>
          )}
        </div>
      )}
    </article>
  );
}
