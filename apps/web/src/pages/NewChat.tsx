import type { NewChatRequest, PermissionMode } from '@agentry/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useAccounts, useOverview, useProjects } from '../api';
import { AttachButton, AttachmentTray, useAttachments } from '../components/Attachments';
import { Combobox, Select, Switch } from '../components/controls';
import { useProjectScope } from '../lib/project-scope';
import { Card, ErrorBox, Field, MODEL_OPTIONS, PageHeader, PERMISSION_MODES } from '../components/ui';

export function NewChat() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects(false);
  const scope = useProjectScope();
  const overview = useOverview();
  const [prompt, setPrompt] = useState('');
  const files = useAttachments();
  const ready = (prompt.trim() || files.ids.length > 0) && !files.uploading;
  const [cwd, setCwd] = useState(params.get('cwd') ?? scope.project?.path ?? '');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [askHere, setAskHere] = useState(true);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [account, setAccount] = useState('');
  const accounts = useAccounts();

  const start = useMutation({
    mutationFn: () => {
      const opts: NewChatRequest = { prompt: prompt.trim(), permissionPrompts: askHere ? 'host' : 'none' };
      if (files.ids.length) opts.attachments = files.ids;
      if (cwd.trim()) opts.cwd = cwd.trim();
      if (model.trim()) opts.model = model.trim();
      if (permissionMode) opts.permissionMode = permissionMode;
      if (appendSystemPrompt.trim()) opts.appendSystemPrompt = appendSystemPrompt.trim();
      if (account) opts.account = account;
      return api.createChat(opts);
    },
    onSuccess: (chat) => navigate(`/chats/${chat.id}`),
  });

  const system = overview.data?.system;

  return (
    <>
      <PageHeader title="New chat" subtitle="Starts a Claude Code conversation that Agentry keeps" />
      <Card>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) start.mutate();
          }}
        >
          <Field label="Prompt" hint="Drop or paste files onto the prompt to attach them.">
            <div {...files.dropProps}>
              <textarea
                autoFocus
                rows={7}
                placeholder="What should Claude do?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={files.onPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) start.mutate();
                }}
              />
            </div>
          </Field>
          <div className="attach-row">
            <AttachButton state={files} disabled={start.isPending} />
            <AttachmentTray state={files} />
          </div>
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
            <Field label="Permission mode" hint="Can be changed while the chat works">
              <Select<PermissionMode | ''>
                value={permissionMode}
                onChange={setPermissionMode}
                options={[
                  { value: '', label: `Default (${system?.defaultPermissionMode ?? '…'})` },
                  ...PERMISSION_MODES.map((m) => ({ value: m, label: m })),
                ]}
              />
            </Field>
            {(accounts.data?.accounts.length ?? 0) > 1 && (
              <Field label="Account" hint="Pins the chat to one claude-swap account instead of the active one">
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
          <Switch checked={askHere} onChange={setAskHere}>
            Answer permission prompts, questions and plans from the panel (off: whatever would ask is denied)
          </Switch>
          <ErrorBox error={start.error} title="Could not start the chat" />
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!ready || start.isPending}>
              {start.isPending ? 'Starting…' : files.uploading ? 'Uploading…' : 'Start chat'}
            </button>
            <span className="muted small">Ctrl/⌘ + Enter</span>
          </div>
        </form>
      </Card>
    </>
  );
}
