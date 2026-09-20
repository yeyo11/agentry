import type { ChatWorkflow, ChatWorkflowAgent } from '@agentry/shared';
import { useDetailPanel } from '../lib/detail';
import { durationBetween, formatDuration, truncate } from '../lib/format';
import { BranchStatus } from './ChatBadges';
import { CodeBlock } from './CodeBlock';
// Direct import: the chat page that renders this is in the shell bundle
import { Collapsible } from './controls/Collapsible';

const tokens = (n: number | null) => (n === null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`);

const TONE: Record<ChatWorkflowAgent['status'], string> = { completed: 'ok', failed: 'bad', running: 'active' };

/** `open` is set when the agent's transcript can be read. */
function AgentRow({ agent, open }: { agent: ChatWorkflowAgent; open: (() => void) | null }) {
  const preview = agent.status === 'completed' ? agent.resultPreview : agent.promptPreview;
  return (
    <li className="wf-agent">
      <span className={`wf-dot wf-dot-${TONE[agent.status]}`} aria-hidden />
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
export function WorkflowCard({ workflow, chatId }: { workflow: ChatWorkflow; chatId: string }) {
  const { open } = useDetailPanel();
  const done = workflow.agents.filter((a) => a.status === 'completed').length;
  const total = workflow.agents.length;
  const hasResult = workflow.result !== undefined && workflow.result !== null;
  return (
    <article className="wf-card">
      <header className="wf-head">
        <BranchStatus status={workflow.status} />
        <strong className="wf-name">{workflow.name ?? 'workflow'}</strong>
        <span className="muted small ellipsis">{workflow.description !== workflow.name ? workflow.description : ''}</span>
      </header>
      <div className="meta">
        <span>
          {done}/{total} agents done
        </span>
        <span>{durationBetween(workflow.startedAt, workflow.endedAt)}</span>
        {workflow.totalTokens !== null && <span>{tokens(workflow.totalTokens)}</span>}
      </div>
      {total > 0 && (
        <div className="wf-progress" role="progressbar" aria-label="Agents done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${(done / total) * 100}%` }} />
        </div>
      )}
      {byPhase(workflow).map(([phase, agents]) => (
        <section key={phase ?? ''} className="wf-phase">
          {phase && <div className="wf-phase-title">{phase}</div>}
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
