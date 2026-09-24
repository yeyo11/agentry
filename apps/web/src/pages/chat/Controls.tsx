import type { Chat, PermissionMode } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatToolsPicker } from '../../components/ChatToolsPicker';
import { Select } from '../../components/controls';
import { ErrorBox, ModelCombobox, PERMISSION_MODES, Tag } from '../../components/ui';
import { api, keys } from '../../api';
import type { StartChoices } from './Composer';

/*
 * The controls built on Radix selects, in one module so the chat page can load them lazily.
 */

/** Permission mode and model of a live execution, changed in place: it switches at once. */
export function LiveSettings({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['work', 'components']);
  const queryClient = useQueryClient();
  const [model, setModel] = useState('');
  const update = useMutation({
    mutationFn: (change: { permissionMode?: PermissionMode; model?: string }) => api.updateChat(chat.id, change),
    onSuccess: () => {
      setModel('');
      void queryClient.invalidateQueries({ queryKey: keys.chatScope(chat.id) });
    },
  });
  const current = chat.execution;
  return (
    <>
      <dt>{t('work:runView.permissions')}</dt>
      <dd>
        <Select<PermissionMode>
          aria-label={t('components:runSettings.permissionMode')}
          value={current?.permissionMode ?? 'manual'}
          disabled={update.isPending}
          onChange={(permissionMode) => update.mutate({ permissionMode })}
          options={PERMISSION_MODES.map((m) => ({ value: m, label: m }))}
        />
      </dd>
      <dt>{t('work:shared.model')}</dt>
      <dd>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim()) update.mutate({ model: model.trim() });
          }}
        >
          <ModelCombobox aria-label={t('work:shared.model')} placeholder={current?.model ?? chat.model ?? t('work:shared.default')} value={model} onChange={setModel} />
          {model.trim() && (
            <button type="submit" className="btn btn-small" disabled={update.isPending}>
              {t('components:runSettings.set')}
            </button>
          )}
        </form>
      </dd>
      {update.error && (
        <dd className="kv-full">
          <ErrorBox error={update.error} />
        </dd>
      )}
    </>
  );
}

/**
 * What the status line opens on a live chat: what can be switched in place, and the tools it was
 * started with, which a live process keeps until it is resumed.
 */
export function LiveOptions({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work']);
  const { tools } = chat;
  return (
    <div className="stack-tight">
      <dl className="kv kv-narrow">
        <LiveSettings chat={chat} />
        <dt>{t('tools.preset')}</dt>
        <dd>{tools?.preset ? <Tag tone="info">{tools.preset.name}</Tag> : <span className="muted">{t('tools.card.noPreset')}</span>}</dd>
        <dt>{t('tools.servers')}</dt>
        <dd className="mono">{tools?.mcp ? (tools.mcp.servers.length > 0 ? tools.mcp.servers.join(', ') : t('tools.card.noServers')) : t('tools.card.serversDefault')}</dd>
      </dl>
      <p className="small muted">{t('status.liveHint')}</p>
    </div>
  );
}

/** What a resume or a fork may start with; left alone, it starts as the chat last ran. */
export function StartOptions({ chat, value, onChange, forking }: { chat: Chat; value: StartChoices; onChange: (next: StartChoices) => void; forking: boolean }) {
  const { t } = useTranslation(['chat', 'work']);
  const last = chat.executions.at(-1);
  return (
    <div className="chat-options">
      <label>
        {t('work:runView.permissions')}
        <Select<PermissionMode | ''>
          aria-label={t('controls.permissionModeNew')}
          value={value.permissionMode ?? ''}
          onChange={(permissionMode) => onChange({ ...value, permissionMode: permissionMode || undefined })}
          options={[{ value: '', label: last ? t('controls.asBefore', { mode: last.permissionMode }) : t('controls.default') }, ...PERMISSION_MODES.map((m) => ({ value: m, label: m }))]}
        />
      </label>
      <label>
        {t('work:shared.model')}
        <ModelCombobox
          aria-label={t('controls.modelNew')}
          placeholder={last?.model ?? chat.model ?? t('work:shared.default')}
          value={value.model ?? ''}
          onChange={(model) => onChange({ ...value, model: model.trim() ? model : undefined })}
        />
      </label>
      <ChatToolsPicker value={value} onChange={(tools) => onChange({ ...value, ...tools })} scope={{ projectId: chat.project?.id }} current={chat.tools ?? null} forking={forking} />
    </div>
  );
}
