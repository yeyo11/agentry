import type { NewChatRequest, PermissionMode } from '@agentry/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, ChevronLeft, FolderOpen } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, keys, useAccounts, useOverview, useProjects } from '../api';
import { AttachButton, AttachmentTray, useAttachments } from '../components/Attachments';
import { ChatToolsPicker, type ToolChoices } from '../components/ChatToolsPicker';
import { Combobox, Select, Switch } from '../components/controls';
import { Tooltip } from '../components/controls/Tooltip';
import { BrandMark, ICON, ICON_SM } from '../components/icons';
import { SlashMenu, useSlashMenu } from '../components/SlashMenu';
import { useProjectScope } from '../lib/project-scope';
import { ErrorBox, Field, ModelCombobox, PERMISSION_MODES, usePageTitle } from '../components/ui';
import { OptionsPanel } from './chat/Composer';

/**
 * Where a chat starts, shaped like the chat it becomes: the same box at the bottom with the same
 * line of settings under it, and above it what a conversation would be — here, what this is for and
 * a few things worth knowing before the first message. Nothing is a form to fill in: the defaults
 * start a chat, and everything that can be chosen is one press away on that line.
 */
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
  const box = useRef<HTMLTextAreaElement>(null);
  const ready = (prompt.trim() || files.ids.length > 0) && !files.uploading;
  const [cwd, setCwd] = useState(params.get('cwd') ?? scope.project?.path ?? '');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [askHere, setAskHere] = useState(true);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [account, setAccount] = useState('');
  const accounts = useAccounts();
  const [tools, setTools] = useState<ToolChoices>({});
  const [options, setOptions] = useState(false);
  usePageTitle(t('new.title'));
  // The servers offered are the ones the chat will see from its directory
  const toolScope = { projectId: (projects.data ?? []).find((p) => p.path === cwd.trim())?.id };

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

  // The box grows with what is typed, as the chat's does
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [prompt]);

  const system = overview.data?.system;
  const directory = cwd.trim() || system?.workspaceDir || t('new.wrapperWorkspace');
  // What the CLI reported the last time a chat started in that directory: a new chat gets the same
  const where = cwd.trim() || system?.workspaceDir || '';
  const environment = useQuery({ queryKey: keys.environments(where), queryFn: () => api.environments(where), enabled: Boolean(where) });
  const slash = useSlashMenu({ text: prompt, setText: setPrompt, commands: environment.data?.[0]?.slashCommands ?? [], skills: environment.data?.[0]?.skills, box });
  // The status line: where it runs, with what — the same words the chat's line shows
  const words = [directory, model.trim() || tc('newChat.defaultModel'), permissionMode || tc('newChat.defaultMode', { mode: system?.defaultPermissionMode ?? '…' })];
  const examples = [t('new.welcome.examples.one'), t('new.welcome.examples.two'), t('new.welcome.examples.three')];

  const send = () => {
    if (ready && !start.isPending) start.mutate();
  };

  return (
    <div className="run-layout">
      <section className="run-main" aria-label={t('new.title')}>
        <header className="chat-head">
          <Tooltip content={tc('view.back')}>
            <Link to="/chats" className="icon-btn chat-back" aria-label={tc('view.back')}>
              <ChevronLeft {...ICON} />
            </Link>
          </Tooltip>
          <h1 className="chat-title ellipsis">{t('new.title')}</h1>
        </header>

        <div className="run-stage">
          <div className="run-scroll" data-scroll-root>
            <div className="new-welcome">
              <BrandMark size={40} />
              <h2 className="new-welcome-title">{t('new.welcome.title')}</h2>
              <p className="new-welcome-lead">{t('new.welcome.lead')}</p>
              <ul className="new-welcome-tips">
                <li>{t('new.welcome.tips.send')}</li>
                <li>{t('new.welcome.tips.files')}</li>
                <li>{t('new.welcome.tips.options')}</li>
              </ul>
              <div className="new-welcome-examples">
                <span className="new-welcome-examples-title">{t('new.welcome.examples.title')}</span>
                {examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="new-welcome-example"
                    onClick={() => {
                      setPrompt(example);
                      box.current?.focus();
                    }}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="composer-wrap">
          <ErrorBox error={start.error} title={t('new.startError')} />
          <div {...files.dropProps}>
            <AttachmentTray state={files} />
            <SlashMenu state={slash}>
              <form
                className="composer"
                aria-label={t('new.prompt')}
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <AttachButton state={files} compact disabled={start.isPending} />
                <textarea
                  ref={box}
                  autoFocus
                  rows={1}
                  aria-label={t('new.prompt')}
                  placeholder={t('new.promptPlaceholder')}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onPaste={files.onPaste}
                  {...slash.inputProps}
                  onKeyDown={(e) => {
                    if (slash.onKeyDown(e)) return;
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <Tooltip content={start.isPending ? t('new.starting') : files.uploading ? t('new.uploading') : t('new.start')}>
                  <button type="submit" className="composer-send" aria-label={t('new.start')} disabled={!ready || start.isPending}>
                    <ArrowUp {...ICON_SM} />
                  </button>
                </Tooltip>
              </form>
            </SlashMenu>
          </div>
          <OptionsPanel
            title={t('new.title')}
            open={options}
            onOpenChange={setOptions}
            trigger={
              <button type="button" className="composer-status" aria-label={t('new.options', { status: words.join(' · ') })} aria-expanded={options} onClick={() => setOptions(true)}>
                <FolderOpen size={12} strokeWidth={2} aria-hidden />
                <span className="composer-status-words">
                  {words.map((word, i) => (
                    <span key={i} className="composer-status-word">
                      {word}
                    </span>
                  ))}
                </span>
                <ChevronDown size={12} strokeWidth={2} aria-hidden />
              </button>
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
                  <ModelCombobox aria-label={t('new.model')} placeholder={t('new.modelPlaceholder')} value={model} onChange={setModel} />
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
          </OptionsPanel>
        </div>
      </section>
    </div>
  );
}
