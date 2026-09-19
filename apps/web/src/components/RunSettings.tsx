import type { PermissionMode, RunSummary } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, keys } from '../api';
import { Combobox, Select } from './controls';
import { ErrorBox, MODEL_OPTIONS, PERMISSION_MODES } from './ui';

/**
 * Mode and model, changed in place: a live process switches at once, and one that has exited gets
 * them when the next message resumes it.
 */
export default function RunSettings({ run }: { run: RunSummary }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState('');
  const update = useMutation({
    mutationFn: (change: { permissionMode?: PermissionMode; model?: string }) => api.updateRun(run.id, change),
    onSuccess: () => {
      setModel('');
      void queryClient.invalidateQueries({ queryKey: keys.runs });
    },
  });
  return (
    <>
      <dt>Permissions</dt>
      <dd>
        <Select<PermissionMode>
          aria-label="Permission mode"
          value={run.permissionMode}
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
          <Combobox aria-label="Model" placeholder={run.model ?? 'default'} value={model} onChange={setModel} options={MODEL_OPTIONS} />
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
