import type { WorkflowDefinition } from '@agentry/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../api';
import { Dialog } from './Dialog';
import { Combobox } from './controls';
import { ICON_SM } from './icons';
import { Empty, ErrorBox, Field, Loading, MODEL_OPTIONS, Tag } from './ui';

/** Arguments for one saved workflow, and the chat that runs it. */
function RunForm({ workflow, cwd, onCancel }: { workflow: WorkflowDefinition; cwd: string | undefined; onCancel: () => void }) {
  const navigate = useNavigate();
  const [args, setArgs] = useState('');
  const [model, setModel] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api.runWorkflow({
        name: workflow.name,
        ...(cwd ? { cwd } : {}),
        ...(args.trim() ? { args: args.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      }),
    onSuccess: (chat) => navigate(`/chats/${encodeURIComponent(chat.id)}`),
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
        <textarea rows={2} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="{ &quot;target&quot;: &quot;src/&quot; }" data-autofocus />
      </Field>
      <Field label="Model" hint="For the chat that launches it; the script can pick its own per agent">
        <Combobox aria-label="Model" placeholder="default" value={model} onChange={setModel} options={MODEL_OPTIONS} />
      </Field>
      <ErrorBox error={run.error} title="Could not start the workflow" />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={run.isPending}>
          <Play {...ICON_SM} /> {run.isPending ? 'Starting…' : `Run ${workflow.name}`}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Back
        </button>
      </div>
    </form>
  );
}

/**
 * Runs a saved workflow. The CLI only runs one from inside a conversation, so this starts a chat
 * that launches it, which is why the button sits beside "new chat". Pass `workflow` to skip the
 * choice, e.g. from the project's resources.
 */
export function RunWorkflowDialog({
  cwd,
  workflow,
  onClose,
}: {
  /** The project directory whose `.claude/workflows/` is offered besides the user's own */
  cwd?: string | undefined;
  workflow?: WorkflowDefinition;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<WorkflowDefinition | null>(workflow ?? null);
  const saved = useQuery({ queryKey: keys.savedWorkflows(cwd ?? ''), queryFn: () => api.savedWorkflows(cwd), enabled: !workflow });

  return (
    <Dialog title={chosen ? `Run ${chosen.name}` : 'Run a saved workflow'} onClose={onClose} width={520}>
      {chosen ? (
        <RunForm workflow={chosen} cwd={cwd} onCancel={workflow ? onClose : () => setChosen(null)} />
      ) : (
        <>
          <p className="muted small">
            Scripts in the project&apos;s <code>.claude/workflows/</code> and in your own. Running one starts a chat that launches it, so
            its prompts come to this panel.
          </p>
          <ErrorBox error={saved.error} />
          {saved.isLoading ? (
            <Loading />
          ) : (saved.data ?? []).length === 0 ? (
            <Empty title="No saved workflows">
              Save one from a chat with the Workflow tool, or write a script in <code>.claude/workflows/</code>.
            </Empty>
          ) : (
            <ul className="wf-saved">
              {(saved.data ?? []).map((w) => (
                <li key={w.path} className="wf-saved-item">
                  <div className="wf-saved-head">
                    <strong>{w.name}</strong>
                    <Tag tone="muted">{w.scope}</Tag>
                    <span className="muted small ellipsis">{w.description}</span>
                    <button type="button" className="btn btn-small" onClick={() => setChosen(w)}>
                      <Play {...ICON_SM} /> Run
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  );
}
