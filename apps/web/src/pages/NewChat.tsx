import type { NewChatRequest, PermissionMode } from '@agentry/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useAccounts, useOverview, useProjects } from '../api';
import { AttachButton, AttachmentTray, useAttachments } from '../components/Attachments';
import { ChatToolsPicker, type ToolChoices } from '../components/ChatToolsPicker';
import { Collapsible, Combobox, Select, Switch } from '../components/controls';
import { useProjectScope } from '../lib/project-scope';
import { ErrorBox, Field, MODEL_OPTIONS, PageHeader, PERMISSION_MODES } from '../components/ui';

export function NewChat() {
  const { t } = useTranslation('chats');
  const { t: tc } = useTranslation('chat');
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
  const [tools, setTools] = useState<ToolChoices>({});
  // The servers offered are the ones the chat will see from its directory
  const toolScope = { projectId: (projects.data ?? []).find((p) => p.path === cwd.trim())?.id };
  // A directory handed in the link is a choice someone made, unless it is the project's own, where
  // a chat from the project starts anyway: then the options stay folded like everything else
  const [advanced, setAdvanced] = useState(() => {
    const asked = params.get('cwd');
    return Boolean(asked) && asked !== scope.project?.path;
  });

  const start = useMutation({
    mutationFn: () => {
      const opts: NewChatRequest = { prompt: prompt.trim(), permissionPrompts: askHere ? 'host' : 'none' };
      if (files.ids.length) opts.attachments = files.ids;
      if (cwd.trim()) opts.cwd = cwd.trim();
      if (model.trim()) opts.model = model.trim();
      if (permissionMode) opts.permissionMode = permissionMode;
      if (appendSystemPrompt.trim()) opts.appendSystemPrompt = appendSystemPrompt.trim();
      if (account) opts.account = account;
      if (tools.toolPreset !== undefined) opts.toolPreset = tools.toolPreset;
      if (tools.mcp) opts.mcp = tools.mcp;
      return api.createChat(opts);
    },
    onSuccess: (chat) => navigate(`/chats/${chat.id}`),
  });

  const system = overview.data?.system;
  // What the folded options come to, so nobody has to open them to know where the chat will run
  const summary = [
    cwd.trim() || system?.workspaceDir || t('new.wrapperWorkspace'),
    model.trim() || tc('newChat.defaultModel'),
    permissionMode || tc('newChat.defaultMode', { mode: system?.defaultPermissionMode ?? '…' }),
  ];

  return (
    <>
      <PageHeader title={t('new.title')} subtitle={t('new.subtitle')} />
      <form
        className="new-chat"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) start.mutate();
        }}
      >
        <div className="new-chat-prompt" {...files.dropProps}>
          <textarea
            autoFocus
            rows={7}
            aria-label={t('new.prompt')}
            placeholder={t('new.promptPlaceholder')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={files.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) start.mutate();
            }}
          />
          <AttachmentTray state={files} />
          <div className="new-chat-bar">
            <AttachButton state={files} compact disabled={start.isPending} />
            <span className="muted small new-chat-hint">{t('new.promptHint')}</span>
            <span className="muted small mono new-chat-keys" aria-hidden>
              Ctrl/⌘ + Enter
            </span>
            <button type="submit" className="btn btn-primary" disabled={!ready || start.isPending}>
              {start.isPending ? t('new.starting') : files.uploading ? t('new.uploading') : t('new.start')}
            </button>
          </div>
        </div>
        <ErrorBox error={start.error} title={t('new.startError')} />
        <Collapsible
          className="fold new-chat-advanced"
          open={advanced}
          onOpenChange={setAdvanced}
          title={
            <>
              <span className="new-chat-advanced-title">{tc('newChat.advanced')}</span>
              <span className="mono small muted new-chat-advanced-summary">{summary.join(' · ')}</span>
            </>
          }
        >
          <div className="form new-chat-options">
            <div className="form-grid">
              <Field label={t('new.workingDirectory')} hint={t('new.workingDirectoryHint', { dir: system?.workspaceDir ?? t('new.wrapperWorkspace') })}>
                <Combobox
                  aria-label={t('new.workingDirectory')}
                  placeholder="/path/to/project"
                  value={cwd}
                  onChange={setCwd}
                  options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
                />
              </Field>
              <Field label={t('new.model')} hint={t('new.modelHint')}>
                <Combobox aria-label={t('new.model')} placeholder={t('new.modelPlaceholder')} value={model} onChange={setModel} options={MODEL_OPTIONS} />
              </Field>
              <Field label={t('new.permissionMode')} hint={t('new.permissionModeHint')}>
                <Select<PermissionMode | ''>
                  aria-label={t('new.permissionMode')}
                  value={permissionMode}
                  onChange={setPermissionMode}
                  options={[
                    { value: '', label: t('new.permissionModeDefault', { mode: system?.defaultPermissionMode ?? '…' }) },
                    ...PERMISSION_MODES.map((m) => ({ value: m, label: m })),
                  ]}
                />
              </Field>
              {(accounts.data?.accounts.length ?? 0) > 1 && (
                <Field label={t('new.account')} hint={t('new.accountHint')}>
                  <Select
                    aria-label={t('new.account')}
                    value={account}
                    onChange={setAccount}
                    options={[
                      { value: '', label: t('new.activeAccount') },
                      ...(accounts.data?.accounts ?? []).map((a) => ({
                        value: String(a.number),
                        label: a.headroomPct !== null ? t('new.accountHeadroom', { name: a.alias ?? a.email, pct: a.headroomPct }) : (a.alias ?? a.email),
                      })),
                    ]}
                  />
                </Field>
              )}
            </div>
            <Field label={t('new.appendSystemPrompt')} hint={t('new.optional')}>
              <textarea rows={2} value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
            </Field>
            <ChatToolsPicker value={tools} onChange={setTools} scope={toolScope} />
            <Switch checked={askHere} onChange={setAskHere}>
              {t('new.askHere')}
            </Switch>
          </div>
        </Collapsible>
      </form>
    </>
  );
}
