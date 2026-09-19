import type { PermissionMode, RunOptions } from '@agentry/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useAccounts, useOverview, useProjects } from '../api';
import { Combobox, Select, Switch } from '../components/controls';
import { Card, ErrorBox, Field, MODEL_OPTIONS, PageHeader, PERMISSION_MODES } from '../components/ui';

export function NewRun() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects(false);
  const overview = useOverview();
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState(params.get('cwd') ?? '');
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [keepAlive, setKeepAlive] = useState(true);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [account, setAccount] = useState('');
  const accounts = useAccounts();

  const start = useMutation({
    mutationFn: () => {
      const opts: RunOptions = { prompt: prompt.trim(), keepAlive };
      if (cwd.trim()) opts.cwd = cwd.trim();
      if (model.trim()) opts.model = model.trim();
      if (name.trim()) opts.name = name.trim();
      if (permissionMode) opts.permissionMode = permissionMode;
      if (appendSystemPrompt.trim()) opts.appendSystemPrompt = appendSystemPrompt.trim();
      if (account) opts.account = account;
      return api.startRun(opts);
    },
    onSuccess: (run) => navigate(`/runs/${run.id}`),
  });

  const system = overview.data?.system;

  return (
    <>
      <PageHeader title="New run" subtitle="Starts a headless `claude -p` process managed by the wrapper" />
      <Card>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (prompt.trim()) start.mutate();
          }}
        >
          <Field label="Prompt">
            <textarea
              autoFocus
              required
              rows={7}
              placeholder="What should Claude do?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) start.mutate();
              }}
            />
          </Field>
          <div className="form-grid">
            <Field label="Working directory" hint={`Default: ${system?.workspaceDir ?? 'wrapper workspace'}`}>
              <Combobox
                aria-label="Working directory"
                placeholder="/path/to/project"
                value={cwd}
                onChange={setCwd}
                options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
              />
            </Field>
            <Field label="Model" hint="Alias or full model id. Empty = CLI default">
              <Combobox aria-label="Model" placeholder="default" value={model} onChange={setModel} options={MODEL_OPTIONS} />
            </Field>
            <Field label="Permission mode" hint="Prompts cannot be answered headless: whatever would ask is denied">
              <Select<PermissionMode | ''>
                value={permissionMode}
                onChange={setPermissionMode}
                options={[
                  { value: '', label: `Default (${system?.defaultPermissionMode ?? '…'})` },
                  ...PERMISSION_MODES.map((m) => ({ value: m, label: m })),
                ]}
              />
            </Field>
            <Field label="Name" hint="Optional display name">
              <input placeholder="auto" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {(accounts.data?.accounts.length ?? 0) > 1 && (
              <Field label="Account" hint="Pins the run to one claude-swap account instead of the active one">
                <Select
                  value={account}
                  onChange={setAccount}
                  options={[
                    { value: '', label: 'Active account' },
                    ...(accounts.data?.accounts ?? []).map((a) => ({
                      value: String(a.number),
                      label: `${a.alias ?? a.email}${a.headroomPct !== null ? ` · ${a.headroomPct}% left` : ''}`,
                    })),
                  ]}
                />
              </Field>
            )}
          </div>
          <Field label="Append to system prompt" hint="Optional">
            <textarea rows={2} value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
          </Field>
          <Switch checked={keepAlive} onChange={setKeepAlive}>
            Keep the process alive between turns (faster follow-ups)
          </Switch>
          <ErrorBox error={start.error} title="Could not start the run" />
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!prompt.trim() || start.isPending}>
              {start.isPending ? 'Starting…' : 'Start run'}
            </button>
            <span className="muted small">Ctrl/⌘ + Enter</span>
          </div>
        </form>
      </Card>
    </>
  );
}
