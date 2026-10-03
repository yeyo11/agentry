import type { NewChatRequest, PermissionMode } from '@agentry/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowUp, Check, FolderOpen, MessageSquare, Network, Search, X, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, keys, useOverview, useProjects } from '../api';
import { AttachButton, AttachmentTray, useAttachments } from '@agentry/chat-ui/components/Attachments';
import { ChatToolsPicker, type ToolChoices } from '../components/ChatToolsPicker';
import { NEW_ORCHESTRATION_PATH } from '../components/CommandPalette';
import { Combobox, Select, Switch } from '@agentry/ui/components/controls';
import { Tooltip } from '@agentry/ui/components/controls/Tooltip';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { Illustration } from '@agentry/ui/components/illustrations';
import { SlashMenu, useSlashMenu } from '@agentry/chat-ui/components/SlashMenu';
import { useProjectScope } from '../lib/project-scope';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { ErrorBox, Field, Segmented, usePageTitle } from '@agentry/ui/components/ui';
import { PERMISSION_MODES, useModelOptions } from '../components/ui';
import { useNewChatProviders, useProviderModels } from '../lib/provider-status';
import { ProviderMark } from '@agentry/ui/components/ProviderMark';
import { upperFirst } from '@agentry/chat-ui/lib/agent';
import { modeLabel } from '@agentry/chat-ui/lib/wire-words';
import { KeysHint, OptionsPanel, StatusChips } from '@agentry/chat-ui/composer/Composer';

type Kind = 'chat' | 'orchestration';

/** Each example with the tint of what it asks for: reading, searching, fixing. */
const EXAMPLES: ReadonlyArray<{ key: 'one' | 'two' | 'three'; icon: LucideIcon; tone: 'info' | 'idle' | 'ok' }> = [
  { key: 'one', icon: MessageSquare, tone: 'info' },
  { key: 'two', icon: Search, tone: 'idle' },
  { key: 'three', icon: Check, tone: 'ok' },
];

/**
 * Where a chat starts: what it is for, the box to write the first message in, and a few things to
 * ask. Nothing is a form to fill in: the defaults start a chat, and everything that can be chosen
 * is one press away on the chips of the box. On a phone the box sits at the bottom, where the
 * chat's own box will be once it starts.
 */
export function NewChat() {
  const { t } = useTranslation('chats');
  const { t: tc } = useTranslation('chat');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects(false);
  const scope = useProjectScope();
  const overview = useOverview();
  const narrow = useMediaQuery(NARROW);
  // A prompt another page prepared (the fix of failing checks, with the project's flow off) arrives in the route's state
  const handed = (useLocation().state as { prompt?: unknown } | null)?.prompt;
  const [prompt, setPrompt] = useState(typeof handed === 'string' ? handed : '');
  const files = useAttachments();
  const box = useRef<HTMLTextAreaElement>(null);
  const ready = (prompt.trim() || files.ids.length > 0) && !files.uploading;
  const [cwd, setCwd] = useState(params.get('cwd') ?? scope.project?.path ?? '');
  const [model, setModel] = useState('');
  const [chosenProvider, setChosenProvider] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [askHere, setAskHere] = useState(true);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [tools, setTools] = useState<ToolChoices>({});
  const [options, setOptions] = useState(false);
  usePageTitle(t('new.title'));
  // The default provider leads the list; until the person picks, it is the one that starts the chat
  const providers = useNewChatProviders();
  const provider = providers.find((p) => p.id === chosenProvider) ?? providers[0];
  const providerId = provider?.id ?? '';
  const hasMcp = !provider || provider.capabilities.includes('mcp');
  const claude = providerId === '' || providerId === 'claude-code';
  const agent = provider?.label ?? tc('agent.generic');
  const providerModels = useProviderModels(claude ? '' : providerId);
  const claudeModels = useModelOptions();
  const modelOptions = claude
    ? claudeModels
    : (providerModels.data ?? []).filter((m) => !m.disabled).map((m) => ({ value: m.value, label: m.label ?? m.value, hint: m.description }));
  // Every agent takes a model when the chat starts (Copilot as `--model`); one without `setModel`
  // only cannot change it afterwards, which the hint says
  const modelFixed = Boolean(provider) && !provider?.capabilities.includes('setModel');
  const modes: readonly PermissionMode[] = provider?.permissionModes ?? PERMISSION_MODES;
  const pickProvider = (id: string) => {
    setChosenProvider(id);
    // A model or a mode of the other agent means nothing to this one
    setModel('');
    setPermissionMode('');
  };
  const known = (projects.data ?? []).find((p) => p.path === cwd.trim());
  // The servers offered are the ones the chat will see from its directory
  const toolScope = { projectId: known?.id };

  const start = useMutation({
    mutationFn: () => {
      const opts: NewChatRequest = { prompt: prompt.trim(), permissionPrompts: askHere ? 'host' : 'none' };
      if (files.ids.length) opts.attachments = files.ids;
      if (providerId) opts.provider = providerId;
      if (cwd.trim()) opts.cwd = cwd.trim();
      if (model.trim()) opts.model = model.trim();
      if (permissionMode) opts.permissionMode = permissionMode;
      if (appendSystemPrompt.trim()) opts.appendSystemPrompt = appendSystemPrompt.trim();
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
  const systemMode = system?.defaultPermissionMode;
  const defaultMode = systemMode && modes.includes(systemMode) ? systemMode : modes[0];
  const defaultModeWord = defaultMode ? modeLabel(defaultMode) : '…';
  const directory = cwd.trim() || system?.workspaceDir || t('new.wrapperWorkspace');
  // What the CLI reported the last time a chat started in that directory: a new chat gets the same
  const where = cwd.trim() || system?.workspaceDir || '';
  const environment = useQuery({ queryKey: keys.environments(where), queryFn: () => api.environments(where), enabled: Boolean(where) });
  const slash = useSlashMenu({ text: prompt, setText: setPrompt, commands: environment.data?.[0]?.slashCommands ?? [], skills: environment.data?.[0]?.skills, box });
  // The chips: where it runs, with what — the same words the chat's own chips show
  const place = known?.name ?? directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
  const words = [place, ...(providers.length > 1 ? [agent] : []), model.trim() || tc('newChat.defaultModel'), permissionMode ? modeLabel(permissionMode) : tc('newChat.defaultMode', { mode: defaultModeWord })];

  const send = () => {
    if (ready && !start.isPending) start.mutate();
  };
  const pick = (example: string) => {
    setPrompt(example);
    box.current?.focus();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };
  const startName = start.isPending ? t('new.starting') : files.uploading ? t('new.uploading') : t('new.start');

  const kind = (
    <Segmented<Kind>
      label={tc('newChat.kind')}
      value="chat"
      onChange={(next) => next === 'orchestration' && navigate(NEW_ORCHESTRATION_PATH)}
      options={[
        { value: 'chat', label: <KindLabel icon={MessageSquare}>{tc('newChat.kindChat')}</KindLabel> },
        { value: 'orchestration', label: <KindLabel icon={Network}>{tc('newChat.kindOrchestration')}</KindLabel> },
      ]}
    />
  );

  const chips = (
    <OptionsPanel
      title={t('new.title')}
      open={options}
      onOpenChange={setOptions}
      trigger={
        <button type="button" className="composer-status" aria-label={t('new.options', { status: words.join(' · ') })} aria-expanded={options} onClick={() => setOptions(true)}>
          <StatusChips words={words} accent={-1} icon={<FolderOpen size={13} strokeWidth={1.75} aria-hidden />} />
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
          {providers.length > 1 && (
            <Field label={t('new.agent')} hint={t('new.agentHint')}>
              <Select
                aria-label={t('new.agent')}
                value={providerId}
                onChange={pickProvider}
                options={providers.map((p) => ({
                  value: p.id,
                  label: (
                    <span className="new-agent-option">
                      <ProviderMark provider={p.id} label={p.label} decorative />
                      {p.label}
                    </span>
                  ),
                }))}
              />
            </Field>
          )}
          <Field label={t('new.model')} hint={modelFixed ? t('new.modelFixed', { agent }) : t('new.modelHint')}>
            <Combobox aria-label={t('new.model')} placeholder={t('new.modelPlaceholder')} value={model} onChange={setModel} options={modelOptions} />
          </Field>
          <Field label={t('new.permissionMode')} hint={t('new.permissionModeHint')}>
            <Select<PermissionMode | ''>
              aria-label={t('new.permissionMode')}
              value={permissionMode}
              onChange={setPermissionMode}
              options={[
                { value: '', label: t('new.permissionModeDefault', { mode: defaultModeWord }) },
                ...modes.map((m) => ({ value: m, label: modeLabel(m) })),
              ]}
            />
          </Field>
        </div>
        <Field label={t('new.appendSystemPrompt')} hint={t('new.optional')}>
          <textarea rows={2} value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
        </Field>
        {hasMcp && <ChatToolsPicker value={tools} onChange={setTools} scope={toolScope} />}
        <Switch checked={askHere} onChange={setAskHere}>
          {t('new.askHere')}
        </Switch>
      </div>
    </OptionsPanel>
  );

  const textarea = (
    <textarea
      ref={box}
      autoFocus={!narrow}
      rows={narrow ? 1 : 4}
      aria-label={t('new.prompt')}
      placeholder={narrow ? t('new.promptPlaceholder', { agent }) : tc('newChat.placeholder')}
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
  );

  const hero = (
    <div className="new-hero">
      <Illustration name="welcome" size={narrow ? 'sm' : 'md'} />
      <h1 className="new-hero-title text-display">
        <Trans t={tc} i18nKey={narrow ? 'newChat.heroShort' : 'newChat.hero'} components={{ grad: <span className="grad-text" /> }} />
      </h1>
      <p className="new-hero-lead">{tc('newChat.lead', { agent: upperFirst(agent) })}</p>
    </div>
  );

  const examples = (
    <section className="new-welcome-examples" aria-labelledby="new-examples">
      <h2 id="new-examples" className="section-label">
        {tc('newChat.examples')}
      </h2>
      <div className="new-welcome-grid">
        {EXAMPLES.map(({ key, icon: Icon, tone }) => {
          const example = t(`new.welcome.examples.${key}`);
          return (
            <button key={key} type="button" className="new-welcome-example" onClick={() => pick(example)}>
              <span className={`new-welcome-example-icon tone-${tone}`} aria-hidden>
                <Icon {...ICON_SM} />
              </span>
              <span className="new-welcome-example-text">{example}</span>
            </button>
          );
        })}
      </div>
    </section>
  );

  if (narrow) {
    return (
      <div className="run-layout new-chat is-narrow glow-top">
        <section className="run-main" aria-label={t('new.title')}>
          <header className="new-chat-head">
            <Tooltip content={tc('newChat.close')}>
              <Link to="/chats" className="icon-btn" aria-label={tc('newChat.close')}>
                <X {...ICON} />
              </Link>
            </Tooltip>
            {kind}
          </header>
          <div className="run-stage">
            <div className="run-scroll new-chat-scroll" data-scroll-root>
              {hero}
              {examples}
            </div>
          </div>
          <div className="composer-wrap new-composer-wrap">
            <ErrorBox error={start.error} title={t('new.startError')} />
            {chips}
            <div {...files.dropProps}>
              <AttachmentTray state={files} />
              <SlashMenu state={slash}>
                <form className="composer grad-border" aria-label={t('new.prompt')} onSubmit={submit}>
                  <AttachButton state={files} compact disabled={start.isPending} />
                  {textarea}
                  <button type="submit" className="composer-send" aria-label={startName} disabled={!ready || start.isPending}>
                    <ArrowUp {...ICON_SM} />
                  </button>
                </form>
              </SlashMenu>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="run-layout new-chat">
      <section className="run-main" aria-label={t('new.title')}>
        <div className="run-stage">
          <div className="run-scroll new-chat-scroll glow-top" data-scroll-root>
            {hero}
            {kind}
            <div className="new-composer-wrap">
              <div {...files.dropProps}>
                <AttachmentTray state={files} />
                <SlashMenu state={slash}>
                  <form className="composer new-composer grad-border" aria-label={t('new.prompt')} onSubmit={submit}>
                    {textarea}
                    <div className="new-composer-foot">
                      <AttachButton state={files} compact disabled={start.isPending} />
                      {chips}
                      <KeysHint>
                        {tc('newChat.keys')
                          .split(' ')
                          .map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                      </KeysHint>
                      <Tooltip content={startName}>
                        <button type="submit" className="btn btn-primary new-start" aria-label={t('new.start')} disabled={!ready || start.isPending}>
                          {tc('newChat.start')}
                          <ArrowRight {...ICON_SM} />
                        </button>
                      </Tooltip>
                    </div>
                  </form>
                </SlashMenu>
              </div>
              <ErrorBox error={start.error} title={t('new.startError')} />
              <p className="new-where">{tc('newChat.where', { dir: directory })}</p>
            </div>
            {examples}
          </div>
        </div>
      </section>
    </div>
  );
}

function KindLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="new-kind">
      <Icon size={13} strokeWidth={1.75} aria-hidden />
      {children}
    </span>
  );
}
