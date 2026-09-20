import type { Chat, PermissionMode } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Combobox, Select } from '../../components/controls';
import { ErrorBox, MODEL_OPTIONS, PERMISSION_MODES } from '../../components/ui';
import { api, keys } from '../../api';
import type { StartChoices } from './Composer';

/*
 * The controls built on Radix selects, in one module so the chat page can load them lazily.
 */

/** Permission mode and model of a live execution, changed in place: it switches at once. */
export function LiveSettings({ chat }: { chat: Chat }) {
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
      <dt>Permissions</dt>
      <dd>
        <Select<PermissionMode>
          aria-label="Permission mode"
          value={current?.permissionMode ?? 'manual'}
          disabled={update.isPending}
          onChange={(permissionMode) => update.mutate({ permissionMode })}
          options={PERMISSION_MODES.map((m) => ({ value: m, label: m }))}
        />
      </dd>
      <dt>Model</dt>
      <dd>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim()) update.mutate({ model: model.trim() });
          }}
        >
          <Combobox aria-label="Model" placeholder={current?.model ?? chat.model ?? 'default'} value={model} onChange={setModel} options={MODEL_OPTIONS} />
          {model.trim() && (
            <button type="submit" className="btn btn-small" disabled={update.isPending}>
              Set
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

/** What a resume or a fork may start with; left alone, it starts as the chat last ran. */
export function StartOptions({ chat, value, onChange }: { chat: Chat; value: StartChoices; onChange: (next: StartChoices) => void }) {
  const last = chat.executions.at(-1);
  return (
    <div className="chat-options">
      <label>
        Permissions
        <Select<PermissionMode | ''>
          aria-label="Permission mode for the new execution"
          value={value.permissionMode ?? ''}
          onChange={(permissionMode) => onChange({ ...value, permissionMode: permissionMode || undefined })}
          options={[{ value: '', label: last ? `As before (${last.permissionMode})` : 'Default' }, ...PERMISSION_MODES.map((m) => ({ value: m, label: m }))]}
        />
      </label>
      <label>
        Model
        <Combobox
          aria-label="Model for the new execution"
          placeholder={last?.model ?? chat.model ?? 'default'}
          value={value.model ?? ''}
          onChange={(model) => onChange({ ...value, model: model.trim() ? model : undefined })}
          options={MODEL_OPTIONS}
        />
      </label>
    </div>
  );
}
