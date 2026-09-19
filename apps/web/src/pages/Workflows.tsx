import type { WorkflowDefinition } from '@agentry/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, keys, useProjects, useWorkflows } from '../api';
import { Combobox } from '../components/controls';
import { ICON_SM } from '../components/icons';
import { Card, Empty, ErrorBox, Field, Loading, MODEL_OPTIONS, PageHeader, Tag } from '../components/ui';
import { WorkflowCard } from '../components/WorkflowCard';

/** Runs one saved workflow: the CLI only runs them from inside a session, so this starts a run for it. */
function RunForm({ workflow, cwd, onCancel }: { workflow: WorkflowDefinition; cwd: string; onCancel: () => void }) {
  const navigate = useNavigate();
  const [args, setArgs] = useState('');
  const [model, setModel] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api.runWorkflow({ name: workflow.name, ...(cwd ? { cwd } : {}), ...(args.trim() ? { args: args.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) }),
    onSuccess: (started) => navigate(`/runs/${started.id}`),
  });
  return (
    <form
      className="form wf-run-form"
      onSubmit={(e) => {
        e.preventDefault();
        run.mutate();
      }}
    >
      <Field label="Args" hint="Optional: handed to the script as `args` (text or JSON)">
        <textarea rows={2} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="{ &quot;target&quot;: &quot;src/&quot; }" />
      </Field>
      <Field label="Model" hint="For the run that launches it; the script can pick its own per agent">
        <Combobox aria-label="Model" placeholder="default" value={model} onChange={setModel} options={MODEL_OPTIONS} />
      </Field>
      <ErrorBox error={run.error} title="Could not start the workflow" />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={run.isPending}>
          <Play {...ICON_SM} /> {run.isPending ? 'Starting…' : `Run ${workflow.name}`}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SavedWorkflows() {
  const projects = useProjects(false);
  const [cwd, setCwd] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const saved = useQuery({ queryKey: keys.savedWorkflows(cwd), queryFn: () => api.savedWorkflows(cwd || undefined) });

  return (
    <Card title="Saved workflows">
      <p className="muted small">
        Scripts in a project&apos;s <code>.claude/workflows/</code> and in your own, which Claude runs with the Workflow tool.
        Running one starts a run that launches it, so its prompts come to this panel.
      </p>
      <Field label="Project" hint="Its own workflows are listed first; yours are available everywhere">
        <Combobox
          aria-label="Project"
          placeholder="Only your own workflows"
          value={cwd}
          onChange={(v) => {
            setCwd(v);
            setOpen(null);
          }}
          options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
        />
      </Field>
      <ErrorBox error={saved.error} />
      {saved.isLoading ? (
        <Loading />
      ) : (saved.data ?? []).length === 0 ? (
        <Empty title="No saved workflows">
          Save one from a session with the Workflow tool, or write a script in <code>.claude/workflows/</code>.
        </Empty>
      ) : (
        <ul className="wf-saved">
          {(saved.data ?? []).map((workflow) => (
            <li key={workflow.path} className="wf-saved-item">
              <div className="wf-saved-head">
                <strong>{workflow.name}</strong>
                <Tag tone="muted">{workflow.scope}</Tag>
                <span className="muted small ellipsis">{workflow.description}</span>
                {open !== workflow.path && (
                  <button type="button" className="btn btn-small" onClick={() => setOpen(workflow.path)}>
                    <Play {...ICON_SM} /> Run
                  </button>
                )}
              </div>
              <div className="mono small muted ellipsis" title={workflow.path}>
                {workflow.path}
              </div>
              {open === workflow.path && <RunForm workflow={workflow} cwd={cwd} onCancel={() => setOpen(null)} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Workflows() {
  const { data, error, isLoading } = useWorkflows();
  const workflows = data ?? [];
  const running = workflows.filter((w) => w.status === 'running').length;
  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle={`${running} running · ${workflows.length} across runs and CLI sessions — scripts started with Claude Code's Workflow tool`}
      />
      <ErrorBox error={error} />
      <Card title={`Runs (${workflows.length})`}>
        {isLoading ? (
          <Loading />
        ) : workflows.length === 0 ? (
          <Empty title="No workflows">
            When a run, or a session started from a terminal, runs a workflow, it shows here with the progress of every
            agent it launched.
          </Empty>
        ) : (
          <div className="stack">
            {workflows.map((workflow) => (
              <WorkflowCard key={`${workflow.runId || workflow.sessionId}:${workflow.id}`} workflow={workflow} />
            ))}
          </div>
        )}
      </Card>
      <SavedWorkflows />
    </>
  );
}
