import type { WorkflowDefinition } from '@agentry/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys, useProjects, useWorkflows } from '../api';
import { Combobox } from '../components/controls';
import { ICON_SM } from '../components/icons';
import { Card, Empty, ErrorBox, Field, Loading, MODEL_OPTIONS, PageHeader, Tag } from '../components/ui';
import { WorkflowCard } from '../components/WorkflowCard';

/** Runs one saved workflow: the CLI only runs them from inside a session, so this starts a run for it. */
function RunForm({ workflow, cwd, onCancel }: { workflow: WorkflowDefinition; cwd: string; onCancel: () => void }) {
  const { t } = useTranslation(['work', 'common']);
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
      <Field label={t('workflows.args')} hint={t('workflows.argsHint')}>
        <textarea rows={2} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="{ &quot;target&quot;: &quot;src/&quot; }" />
      </Field>
      <Field label={t('shared.model')} hint={t('workflows.modelHint')}>
        <Combobox aria-label={t('shared.model')} placeholder={t('shared.default')} value={model} onChange={setModel} options={MODEL_OPTIONS} />
      </Field>
      <ErrorBox error={run.error} title={t('workflows.startFailed')} />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={run.isPending}>
          <Play {...ICON_SM} /> {run.isPending ? t('shared.starting') : t('workflows.runNamed', { name: workflow.name })}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('common:actions.cancel')}
        </button>
      </div>
    </form>
  );
}

function SavedWorkflows() {
  const { t } = useTranslation(['work', 'common']);
  const projects = useProjects(false);
  const [cwd, setCwd] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const saved = useQuery({ queryKey: keys.savedWorkflows(cwd), queryFn: () => api.savedWorkflows(cwd || undefined) });

  return (
    <Card title={t('workflows.saved')}>
      <p className="muted small">
        <Trans t={t} i18nKey="workflows.savedIntro" components={{ code: <code /> }} />
      </p>
      <Field label={t('shared.project')} hint={t('workflows.projectHint')}>
        <Combobox
          aria-label={t('shared.project')}
          placeholder={t('workflows.onlyYours')}
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
        <Empty title={t('workflows.noSaved')}>
          <Trans t={t} i18nKey="workflows.noSavedHint" components={{ code: <code /> }} />
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
                    <Play {...ICON_SM} /> {t('workflows.run')}
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
  const { t } = useTranslation(['work', 'common']);
  const { data, error, isLoading } = useWorkflows();
  const workflows = data ?? [];
  const running = workflows.filter((w) => w.status === 'running').length;
  return (
    <>
      <PageHeader
        title={t('workflows.title')}
        subtitle={t('workflows.subtitle', { running, total: workflows.length })}
      />
      <ErrorBox error={error} />
      <Card title={t('workflows.runsCard', { n: workflows.length })}>
        {isLoading ? (
          <Loading />
        ) : workflows.length === 0 ? (
          <Empty title={t('workflows.empty')}>{t('workflows.emptyHint')}</Empty>
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
