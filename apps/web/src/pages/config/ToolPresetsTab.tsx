import type { ToolPreset } from '@agentry/shared';
import { Plus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { useConfirm } from '../../components/Dialog';
import { StringListEditor } from '../../components/editors';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, Field, Skeleton, Tag } from '../../components/ui';
import { useDirty } from '../../lib/dirty';

/** `Docs only` → `docs-only`: the id is what a chat request names, so it stays readable. */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

interface PresetForm {
  id: string;
  name: string;
  description: string;
  allowedTools: string[];
  disallowedTools: string[];
}

const fromPreset = (p: ToolPreset): PresetForm => ({
  id: p.id,
  name: p.name,
  description: p.description ?? '',
  allowedTools: p.allowedTools,
  disallowedTools: p.disallowedTools ?? [],
});

function PresetEditor({ initial, isNew, existingIds, onClose }: { initial: PresetForm; isNew: boolean; existingIds: Set<string>; onClose: () => void }) {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  useDirty('tools', touched);

  const patch = (next: Partial<PresetForm>) => {
    setForm((f) => ({ ...f, ...next }));
    setTouched(true);
  };
  const id = isNew ? slug(form.name) : form.id;
  const clash = isNew && existingIds.has(id);
  const valid = form.name.trim() !== '' && id !== '' && !clash;

  const save = useMutation({
    mutationFn: () =>
      api.putToolPreset(id, {
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        allowedTools: form.allowedTools,
        disallowedTools: form.disallowedTools,
      }),
    onSuccess: (preset) => {
      setTouched(false);
      void queryClient.invalidateQueries({ queryKey: keys.toolPresets });
      toast.success(t('toolPresets.saved', { name: preset.name }));
      onClose();
    },
    onError: (err) => toast.error(t('toolPresets.saveFailed'), err),
  });

  return (
    <Card title={isNew ? t('toolPresets.new') : t('toolPresets.edit', { name: initial.name })}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <Field label={t('toolPresets.name')} hint={isNew && id ? t('toolPresets.idHint', { id }) : undefined}>
          <input value={form.name} maxLength={80} onChange={(e) => patch({ name: e.target.value })} className={clash ? 'is-invalid' : ''} />
          {clash && <span className="field-hint text-err">{t('toolPresets.clash', { id })}</span>}
        </Field>
        <Field label={t('toolPresets.description')} hint={t('toolPresets.descriptionHint')}>
          <input value={form.description} maxLength={300} onChange={(e) => patch({ description: e.target.value })} />
        </Field>
        <Field label={t('toolPresets.allowed')} hint={t('toolPresets.allowedHint')}>
          <StringListEditor
            values={form.allowedTools}
            placeholder="Bash(git status:*)"
            addLabel={t('toolPresets.addRule')}
            label={t('toolPresets.allowed')}
            emptyText={t('toolPresets.noRules')}
            onChange={(allowedTools) => patch({ allowedTools })}
          />
        </Field>
        <Field label={t('toolPresets.disallowed')} hint={t('toolPresets.disallowedHint')}>
          <StringListEditor
            values={form.disallowedTools}
            placeholder="WebFetch"
            addLabel={t('toolPresets.addRule')}
            label={t('toolPresets.disallowed')}
            emptyText={t('toolPresets.noRules')}
            onChange={(disallowedTools) => patch({ disallowedTools })}
          />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!valid || save.isPending}>
            {save.isPending ? t('shared.saving') : t('toolPresets.save')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
        </div>
      </form>
    </Card>
  );
}

/** The named tool sets a chat can start or resume with; the shipped ones are edited like any other. */
export function ToolPresetsTab() {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, isLoading } = useQuery({ queryKey: keys.toolPresets, queryFn: api.toolPresets });
  const [editing, setEditing] = useState<{ form: PresetForm; isNew: boolean } | null>(null);
  const presets = data?.presets ?? [];
  const blank: PresetForm = { id: '', name: '', description: '', allowedTools: [], disallowedTools: [] };

  const remove = useMutation({
    mutationFn: (preset: ToolPreset) => api.deleteToolPreset(preset.id),
    onSuccess: (_result, preset) => {
      void queryClient.invalidateQueries({ queryKey: keys.toolPresets });
      toast.success(t('toolPresets.removed', { name: preset.name }));
    },
    onError: (err) => toast.error(t('toolPresets.removeFailed'), err),
  });

  if (editing) {
    return (
      <PresetEditor
        key={`${editing.form.id}:${String(editing.isNew)}`}
        initial={editing.form}
        isNew={editing.isNew}
        existingIds={new Set(presets.map((p) => p.id))}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <Card
      title={t('config.tabs.tools')}
      actions={
        <button type="button" className="btn btn-small btn-primary" onClick={() => setEditing({ form: blank, isNew: true })}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          {t('toolPresets.add')}
        </button>
      }
    >
      <p className="small muted">{t('toolPresets.intro')}</p>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={3} />
      ) : presets.length === 0 ? (
        <Empty title={t('toolPresets.empty')}>{t('toolPresets.emptyHint')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('toolPresets.name')}</th>
                <th scope="col">{t('toolPresets.allowed')}</th>
                <th scope="col">{t('toolPresets.disallowed')}</th>
                <th scope="col">
                  <span className="sr-only">{t('mcp.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {presets.map((preset) => (
                <tr key={preset.id}>
                  <td>
                    <div className="strong">
                      {preset.name} {preset.builtIn && <Tag tone="muted">{t('toolPresets.shipped')}</Tag>}
                    </div>
                    <div className="small muted mono">{preset.id}</div>
                    {preset.description && <div className="small muted">{preset.description}</div>}
                  </td>
                  <td className="small mono break">{preset.allowedTools.join(', ') || '—'}</td>
                  <td className="small mono break">{preset.disallowedTools?.join(', ') || '—'}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={t('toolPresets.editNamed', { name: preset.name })}
                        onClick={() => setEditing({ form: fromPreset(preset), isNew: false })}
                      >
                        {t('shared.edit')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        aria-label={t('toolPresets.removeNamed', { name: preset.name })}
                        disabled={remove.isPending}
                        onClick={() =>
                          void confirm({
                            title: t('toolPresets.removeTitle', { name: preset.name }),
                            body: preset.builtIn ? t('toolPresets.removeShippedBody') : t('toolPresets.removeBody'),
                            confirmLabel: t('common:actions.remove'),
                            danger: true,
                          }).then((ok) => ok && remove.mutate(preset))
                        }
                      >
                        {t('common:actions.remove')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
