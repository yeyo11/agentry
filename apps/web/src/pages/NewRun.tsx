import type { PermissionMode, RunOptions } from '@agentry/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useAccounts, useOverview, useProjects } from '../api';
import { Card, ErrorBox, Field, ModelDatalist, PageHeader, PERMISSION_MODES } from '../components/ui';

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
              <input
                list="cwd-options"
                placeholder="/path/to/project"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <datalist id="cwd-options">
                {(projects.data ?? []).filter((p) => p.exists).map((p) => (
                  <option key={p.id} value={p.path} />
                ))}
              </datalist>
            </Field>
            <Field label="Model" hint="Alias or full model id. Empty = CLI default">
              <input list="model-options" placeholder="default" value={model} onChange={(e) => setModel(e.target.value)} />
              <ModelDatalist id="model-options" />
            </Field>
            <Field label="Permission mode" hint="Prompts cannot be answered headless: whatever would ask is denied">
              <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode | '')}>
                <option value="">Default ({system?.defaultPermissionMode ?? '…'})</option>
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name" hint="Optional display name">
              <input placeholder="auto" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {(accounts.data?.accounts.length ?? 0) > 1 && (
              <Field label="Account" hint="Pins the run to one claude-swap account instead of the active one">
                <select value={account} onChange={(e) => setAccount(e.target.value)}>
                  <option value="">Active account</option>
                  {accounts.data?.accounts.map((a) => (
                    <option key={a.number} value={String(a.number)}>
                      {a.alias ?? a.email}
                      {a.headroomPct !== null ? ` · ${a.headroomPct}% left` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <Field label="Append to system prompt" hint="Optional">
            <textarea rows={2} value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={keepAlive} onChange={(e) => setKeepAlive(e.target.checked)} /> Keep the
            process alive between turns (faster follow-ups)
          </label>
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
