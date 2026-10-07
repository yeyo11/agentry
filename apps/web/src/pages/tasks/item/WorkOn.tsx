import type { Effort, PermissionMode, WorkItem, WorkOnWorkItemRequest } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys, useOverview } from '../../../api';
import { ChatToolsPicker, type ToolChoices } from '../../../components/ChatToolsPicker';
import { Select, Switch } from '@agentry/ui/components/controls';
import { Dialog } from '@agentry/ui/components/Dialog';
import { ICON_SM } from '@agentry/ui/components/icons';
import { ErrorBox, Field } from '@agentry/ui/components/ui';
import { EffortField } from '../../../components/EffortPicker';
import { ModelCombobox, PERMISSION_MODES } from '../../../components/ui';

/** The branch "Work on it" works on, as the API names it: `task/<key>` in lower case. */
export const taskBranch = (key: string) => `task/${key.toLowerCase()}`;

/**
 * "Work on it": a chat in the item's own worktree, prompted with its description and criteria, with
 * the options a new chat offers (the same fields and words as New chat's panel). It goes through the
 * API (`POST /work-items/:id/work`), never the CLI directly, and opens the chat once it starts.
 */
export function WorkOnDialog({ item, onClose }: { item: Pick<WorkItem, 'id' | 'key' | 'projectId'>; onClose: () => void }) {
  const { t } = useTranslation('workItem');
  const { t: tn } = useTranslation('chats');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const overview = useOverview();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [tools, setTools] = useState<ToolChoices>({});
  const [askHere, setAskHere] = useState(true);
  const defaultMode = overview.data?.system.defaultPermissionMode ?? '…';

  const start = useMutation({
    mutationFn: () => {
      const req: WorkOnWorkItemRequest = { permissionPrompts: askHere ? 'host' : 'none' };
      if (model.trim()) req.model = model.trim();
      if (effort) req.effort = effort;
      if (permissionMode) req.permissionMode = permissionMode;
      if (appendSystemPrompt.trim()) req.appendSystemPrompt = appendSystemPrompt.trim();
      if (tools.toolPreset !== undefined) req.toolPreset = tools.toolPreset;
      if (tools.mcp) req.mcp = tools.mcp;
      return api.workOnWorkItem(item.id, req);
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: keys.workItem(item.id) });
      navigate(`/chats/${result.chat.id}`);
    },
  });

  return (
    <Dialog
      title={t('workOn.title', { key: item.key })}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button type="button" className="btn btn-primary" data-autofocus onClick={() => start.mutate()} disabled={start.isPending}>
            <Play {...ICON_SM} />
            {start.isPending ? t('workOn.starting') : t('workOn.start')}
          </button>
        </>
      }
    >
      <div className="form workon-form">
        <p className="muted small">{t('workOn.intro', { branch: taskBranch(item.key) })}</p>
        <div className="form-grid">
          <Field label={tn('new.model')} hint={tn('new.modelHint')}>
            <ModelCombobox aria-label={tn('new.model')} placeholder={tn('new.modelPlaceholder')} value={model} onChange={setModel} />
          </Field>
          <EffortField value={effort} onChange={setEffort} model={model} use="work" />
          <Field label={tn('new.permissionMode')} hint={tn('new.permissionModeHint')}>
            <Select<PermissionMode | ''>
              aria-label={tn('new.permissionMode')}
              value={permissionMode}
              onChange={setPermissionMode}
              options={[{ value: '', label: tn('new.permissionModeDefault', { mode: defaultMode }) }, ...PERMISSION_MODES.map((m) => ({ value: m, label: m }))]}
            />
          </Field>
        </div>
        <Field label={tn('new.appendSystemPrompt')} hint={tn('new.optional')}>
          <textarea rows={2} value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
        </Field>
        <ChatToolsPicker value={tools} onChange={setTools} scope={{ projectId: item.projectId }} />
        <Switch checked={askHere} onChange={setAskHere}>
          {tn('new.askHere')}
        </Switch>
        <ErrorBox error={start.error} title={t('workOn.failed')} />
      </div>
    </Dialog>
  );
}
