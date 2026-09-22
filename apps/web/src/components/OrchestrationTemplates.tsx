import type { OrchestrationSpec, OrchestrationTemplate } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Play, TextCursorInput, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys, useProjects } from '../api';
import { timeAgo } from '../lib/format';
import { Combobox, Tooltip } from './controls';
import { Dialog, useConfirm } from './Dialog';
import { ICON_SM } from './icons';
import { useToast } from './Toast';
import { Empty, ErrorBox, Field, Loading, MODEL_OPTIONS } from './ui';

/**
 * Saves a graph as a template. Given a spec (the launch form's, or a plan's) it takes the graph as
 * written; given an orchestration it takes the one that ran, corrections on resume included. Given
 * an existing template it updates that one instead, so editing a template never leaves a copy.
 */
export function SaveTemplateDialog({
  spec,
  fromOrchestration,
  existing,
  defaultName,
  onClose,
}: {
  spec?: OrchestrationSpec;
  fromOrchestration?: string;
  existing?: OrchestrationTemplate;
  defaultName?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['orchestrationV2', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const formId = useId();
  const [name, setName] = useState(existing?.name ?? defaultName ?? spec?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const save = useMutation({
    mutationFn: () => {
      const text = { name: name.trim(), description: description.trim() || undefined };
      if (existing) return api.updateOrchestrationTemplate(existing.id, { ...text, ...(spec ? { spec } : {}) });
      return api.saveOrchestrationTemplate({ ...text, ...(fromOrchestration ? { fromOrchestration } : { spec }) });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestrationTemplates });
      toast.success(existing ? t('templates.updatedToast', { name: saved.name }) : t('templates.saved', { name: saved.name }));
      onClose();
    },
  });

  return (
    <Dialog
      title={existing ? t('templates.updateTitle') : t('templates.saveTitle')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={save.isPending || !name.trim()}>
            {save.isPending ? t('templates.saving') : existing ? t('templates.update') : t('templates.save')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <p className="muted small">{fromOrchestration ? t('templates.saveFromHint') : t('templates.saveHint')}</p>
        <Field label={t('templates.name')} hint={t('templates.nameHint')}>
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('templates.description')}>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorBox error={save.error} title={t('templates.saveFailed')} />
      </form>
    </Dialog>
  );
}

/** A template runs on a new objective and directory; what is filled in here is for this run only. */
function LaunchTemplateDialog({ template, onClose }: { template: OrchestrationTemplate; onClose: () => void }) {
  const { t } = useTranslation(['orchestrationV2', 'config', 'common']);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useProjects(false);
  const formId = useId();
  const [objective, setObjective] = useState(template.spec.objective ?? '');
  const [cwd, setCwd] = useState(template.spec.cwd ?? '');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const launch = useMutation({
    mutationFn: () =>
      api.launchOrchestrationTemplate(template.id, {
        objective: objective.trim(),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      }),
    onSuccess: (orch) => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestrations });
      onClose();
      navigate(`/orchestration/${orch.id}`);
    },
  });

  return (
    <Dialog
      title={t('templates.launchTitle', { name: template.name })}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={launch.isPending}>
            {t('common:actions.cancel')}
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={launch.isPending || !objective.trim()}>
            <Play {...ICON_SM} /> {launch.isPending ? t('templates.launching') : t('templates.launch')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (objective.trim()) launch.mutate();
        }}
      >
        <p className="muted small">{t('templates.launchHint', { count: template.spec.tasks.length })}</p>
        <Field label={t('config:orchestration.objective')} hint={t('templates.objectiveHint')}>
          <textarea data-autofocus rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>
        <Field label={t('config:orchestration.cwd')}>
          <Combobox
            aria-label={t('config:orchestration.cwd')}
            placeholder={t('config:orchestration.cwdPlaceholder')}
            value={cwd}
            onChange={setCwd}
            options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
          />
        </Field>
        <div className="form-grid">
          <Field label={t('templates.runName')} hint={t('templates.runNameHint')}>
            <input value={name} placeholder={template.spec.name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('templates.model')}>
            <Combobox
              aria-label={t('templates.model')}
              placeholder={template.spec.model ?? t('templates.modelDefault')}
              value={model}
              onChange={setModel}
              options={MODEL_OPTIONS}
            />
          </Field>
        </div>
        <ErrorBox error={launch.error} title={t('templates.launchFailed')} />
      </form>
    </Dialog>
  );
}

/** Renames a template where it is listed: only the name is sent, so the graph is not reopened or rewritten. */
function RenameTemplate({ template, onDone }: { template: OrchestrationTemplate; onDone: () => void }) {
  const { t } = useTranslation(['orchestrationV2', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(template.name);
  const rename = useMutation({
    mutationFn: () => api.updateOrchestrationTemplate(template.id, { name: name.trim() }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestrationTemplates });
      toast.success(t('templates.renamed', { name: saved.name }));
      onDone();
    },
  });
  const unchanged = name.trim() === template.name;
  const submit = () => {
    if (unchanged) onDone();
    else if (name.trim()) rename.mutate();
  };
  return (
    <>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          autoFocus
          aria-label={t('templates.newName', { name: template.name })}
          value={name}
          maxLength={120}
          disabled={rename.isPending}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Escape ends the rename and nothing else: not a panel or dialog the page has open
              e.stopPropagation();
              onDone();
            }
          }}
        />
        <button type="submit" className="icon-btn" disabled={!name.trim() || rename.isPending} aria-label={t('templates.renameSave')}>
          <Check {...ICON_SM} />
        </button>
        <button type="button" className="icon-btn" disabled={rename.isPending} onClick={onDone} aria-label={t('templates.renameCancel')}>
          <X {...ICON_SM} />
        </button>
      </form>
      <ErrorBox error={rename.error} title={t('templates.renameFailed')} />
    </>
  );
}

/** The saved graphs: launch one on a new objective, open one in the form to edit, rename or delete it. */
export function TemplatesList({ onEdit }: { onEdit: (template: OrchestrationTemplate) => void }) {
  const { t } = useTranslation(['orchestrationV2', 'common']);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [launching, setLaunching] = useState<OrchestrationTemplate | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: keys.orchestrationTemplates, queryFn: api.orchestrationTemplates });
  const remove = useMutation({
    mutationFn: (template: OrchestrationTemplate) => api.deleteOrchestrationTemplate(template.id),
    onSuccess: (_, template) => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestrationTemplates });
      toast.success(t('templates.deleted', { name: template.name }));
    },
  });
  const list = data ?? [];

  return (
    <div className="stack">
      <ErrorBox error={error ?? remove.error} />
      {isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty title={t('templates.none')}>{t('templates.noneHint')}</Empty>
      ) : (
        <ul className="list">
          {list.map((template) => (
            <li key={template.id} className="list-row list-row-flow">
              <div className="list-row-main">
                {renaming === template.id ? (
                  <RenameTemplate template={template} onDone={() => setRenaming(null)} />
                ) : (
                  <div className="strong break">{template.name}</div>
                )}
                {template.description && <div className="muted small break">{template.description}</div>}
                <div className="muted small">
                  {t('templates.taskCount', { count: template.spec.tasks.length })} · {t('templates.updatedAgo', { ago: timeAgo(template.updatedAt) })}
                </div>
              </div>
              <span className="row-actions">
                <button type="button" className="btn btn-small btn-primary" onClick={() => setLaunching(template)} aria-label={t('templates.launchNamed', { name: template.name })}>
                  <Play {...ICON_SM} /> {t('templates.launch')}
                </button>
                <Tooltip content={t('templates.rename')}>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={renaming === template.id}
                    onClick={() => setRenaming(template.id)}
                    aria-label={t('templates.renameNamed', { name: template.name })}
                  >
                    <TextCursorInput {...ICON_SM} />
                  </button>
                </Tooltip>
                <Tooltip content={t('templates.edit')}>
                  <button type="button" className="btn btn-small" onClick={() => onEdit(template)} aria-label={t('templates.editNamed', { name: template.name })}>
                    <Pencil {...ICON_SM} />
                  </button>
                </Tooltip>
                <Tooltip content={t('common:actions.delete')}>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={remove.isPending}
                    aria-label={t('templates.deleteNamed', { name: template.name })}
                    onClick={() =>
                      void confirm({
                        title: t('templates.deleteTitle', { name: template.name }),
                        body: t('templates.deleteBody'),
                        confirmLabel: t('common:actions.delete'),
                        danger: true,
                      }).then((ok) => {
                        if (ok) remove.mutate(template);
                      })
                    }
                  >
                    <Trash2 {...ICON_SM} />
                  </button>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
      )}
      {launching && <LaunchTemplateDialog template={launching} onClose={() => setLaunching(null)} />}
    </div>
  );
}
