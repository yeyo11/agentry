import type { Chat, PermissionMode } from '@agentry/shared';
import * as RadixPopover from '@radix-ui/react-popover';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, GitFork, Play, Square } from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ToolChoices } from '../../components/ChatToolsPicker';
import { AttachButton, AttachmentTray, useAttachments } from '../../components/Attachments';
import { LAYER_ATTR } from '../../components/controls/layer';
import { Sheet } from '../../components/controls/Sheet';
import { Tooltip } from '../../components/controls/Tooltip';
import { ICON_SM } from '../../components/icons';
import { SlashMenu, useSlashMenu } from '../../components/SlashMenu';
import { ErrorBox } from '../../components/ui';
import { api, keys } from '../../api';
import { NARROW, useMediaQuery } from '../../lib/media';

// Its Select and Combobox are Radix controls kept out of the shell bundle this page lives in
const StartOptions = lazy(() => import('./Controls').then((m) => ({ default: m.StartOptions })));
const LiveOptions = lazy(() => import('./Controls').then((m) => ({ default: m.LiveOptions })));

/** What a message does: reaches a live process, resumes the chat in place, or continues a copy of it. */
export type ComposerKind = 'send' | 'resume' | 'fork';

export interface StartChoices extends ToolChoices {
  permissionMode?: PermissionMode;
  model?: string;
}

/**
 * The status line's words: model · mode · preset · servers, each what the next message will run
 * with. A choice made for a resume or a fork wins over what the chat last ran with.
 */
function useStatusWords(chat: Chat, kind: ComposerKind, choices: StartChoices): string[] {
  const { t } = useTranslation(['chat', 'work']);
  const last = chat.execution ?? chat.executions.at(-1) ?? null;
  const starting = kind !== 'send';
  const model = (starting ? choices.model : undefined) ?? last?.model ?? chat.model ?? t('work:shared.default');
  const mode = (starting ? choices.permissionMode : undefined) ?? last?.permissionMode ?? t('controls.default');
  const presetChoice = starting ? choices.toolPreset : undefined;
  const preset =
    presetChoice === null
      ? t('status.noPreset')
      : presetChoice !== undefined
        ? presetChoice
        : (chat.tools?.preset?.name ?? t('status.noPreset'));
  const mcpChoice = starting ? choices.mcp : undefined;
  const servers = mcpChoice === undefined ? (chat.tools?.mcp ?? null) : mcpChoice;
  const mcp = servers ? t('status.mcpChosen', { count: servers.servers.length }) : t('status.mcpDefault');
  return [model, mode, preset, mcp];
}

/** A popover by the line on a wide screen, a sheet from the bottom on a phone. */
export function OptionsPanel({ trigger, title, open, onOpenChange, children }: { trigger: ReactNode; title: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const narrow = useMediaQuery(NARROW);
  if (narrow) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={onOpenChange} title={title}>
          <div className="composer-options">{children}</div>
        </Sheet>
      </>
    );
  }
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className="popover composer-options" side="top" align="start" sideOffset={6} collisionPadding={8} aria-label={title} {...LAYER_ATTR}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/**
 * The mono line under the message box, `opus · bypassPermissions · no preset · MCP: CLI default ⌄`,
 * which opens what used to be four labelled fields under it: the permission mode and model of the
 * live process, or everything a resume or a fork may start with.
 */
function StatusLine({ chat, kind, choices, onChoices }: { chat: Chat; kind: ComposerKind; choices: StartChoices; onChoices: (next: StartChoices) => void }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const words = useStatusWords(chat, kind, choices);
  const narrow = useMediaQuery(NARROW);
  const title = kind === 'send' ? t('status.liveTitle') : kind === 'resume' ? t('status.resumeTitle') : t('status.forkTitle');
  const changed = kind !== 'send' && Object.values(choices).some((v) => v !== undefined);
  const trigger = (
    <button
      type="button"
      className={`composer-status ${changed ? 'is-changed' : ''}`.trim()}
      aria-label={t('status.open', { status: words.join(' · ') })}
      aria-expanded={open}
      onClick={narrow ? () => setOpen(true) : undefined}
    >
      <span className="composer-status-words">
        {words.map((word, i) => (
          <span key={i} className="composer-status-word">
            {word}
          </span>
        ))}
      </span>
      <ChevronDown size={12} strokeWidth={2} aria-hidden />
    </button>
  );
  return (
    <OptionsPanel trigger={trigger} title={title} open={open} onOpenChange={setOpen}>
      <Suspense fallback={null}>
        {kind === 'send' ? <LiveOptions chat={chat} /> : <StartOptions chat={chat} value={choices} onChange={onChoices} forking={kind === 'fork'} />}
      </Suspense>
    </OptionsPanel>
  );
}

/**
 * The message box, with its own text state: the transcript above it can be thousands of nodes, and
 * re-rendering the page on every character typed here is enough to lock the tab up.
 */
export function Composer({
  chat,
  kind,
  onSent,
  interrupt,
  restore,
}: {
  chat: Chat;
  kind: ComposerKind;
  /** The message left for the chat: the page holds it until the transcript shows it */
  onSent: (sent: { text: string; files: number }) => void;
  /** While the chat works, an empty box's button stops the turn instead of sending */
  interrupt?: { run: () => void; pending: boolean };
  /** Words handed back to the box: a message the chat never read (see `chat/queued.ts`) */
  restore?: { text: string; at: number } | null;
}) {
  const { t } = useTranslation(['chat', 'work']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<StartChoices>({});
  const files = useAttachments();
  const box = useRef<HTMLTextAreaElement>(null);
  const working = chat.state === 'working';
  const slash = useSlashMenu({ text, setText, commands: chat.environment?.slashCommands ?? [], skills: chat.environment?.skills, box });

  const submit = useMutation({
    mutationFn: (message: string) => {
      const attachments = files.ids.length ? { attachments: files.ids } : {};
      if (kind === 'send') return api.sendMessage(chat.id, { text: message, ...attachments });
      // A chat resumed or forked from here is answered here: permissions would otherwise be denied unasked
      const request = { prompt: message, ...attachments, permissionPrompts: 'host' as const, ...choices };
      return kind === 'resume' ? api.resumeChat(chat.id, request) : api.forkChat(chat.id, request);
    },
    onSuccess: (result, message) => {
      setText('');
      const sentFiles = files.ids.length;
      files.clear();
      onSent({ text: message, files: sentFiles });
      void queryClient.invalidateQueries({ queryKey: keys.chats });
      void queryClient.invalidateQueries({ queryKey: keys.chatScope(chat.id) });
      if (kind === 'fork') navigate(`/chats/${result.id}`);
    },
  });

  // A message that was never delivered comes back here, after whatever is half-typed
  const restoredAt = useRef(0);
  useEffect(() => {
    if (!restore || restore.at === restoredAt.current) return;
    restoredAt.current = restore.at;
    setText((held) => (held.trim() ? `${held.replace(/\s+$/, '')}\n\n${restore.text}` : restore.text));
    box.current?.focus();
  }, [restore]);

  // Auto-growing composer
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = () => {
    const message = text.trim();
    // A file on its own is a message too; one still uploading is not sent without it
    if (!(message || files.ids.length) || files.uploading || submit.isPending) return;
    // On a phone the keyboard covers half the screen, and what happens next is worth watching: the
    // box lets go once the message is away, and a tap on it brings the keyboard back
    if (window.matchMedia('(pointer: coarse)').matches) box.current?.blur();
    submit.mutate(message);
  };
  const label = {
    send: { idle: t('work:runView.send'), pending: t('work:runView.sending') },
    resume: { idle: t('composer.resume'), pending: t('composer.resuming') },
    fork: { idle: t('composer.fork'), pending: t('composer.forking') },
  }[kind];
  const placeholder =
    kind === 'fork'
      ? t('composer.placeholderFork')
      : kind === 'resume'
        ? t('composer.placeholderResume')
        : working
          ? t('work:runView.placeholderQueued')
          : t('work:runView.placeholderFollowUp');
  const Icon = kind === 'fork' ? GitFork : kind === 'resume' ? Play : ArrowUp;
  const empty = !text.trim() && files.ids.length === 0;
  const stopping = Boolean(interrupt) && kind === 'send' && working && empty;
  const sendName = submit.isPending ? label.pending : files.uploading ? t('work:shared.uploading') : label.idle;

  return (
    <div className="composer-wrap">
      <div {...files.dropProps}>
        <AttachmentTray state={files} />
        <SlashMenu state={slash}>
          <form
            className={`composer ${working ? 'live-energy is-working' : ''}`.trim()}
            aria-label={kind === 'fork' ? t('work:sessionView.continueCopy') : t('composer.message')}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <AttachButton state={files} compact disabled={submit.isPending} />
            <textarea
              aria-label={kind === 'fork' ? t('composer.firstMessage') : t('composer.message')}
              autoFocus={kind === 'fork'}
              onPaste={files.onPaste}
              ref={box}
              rows={1}
              placeholder={placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              {...slash.inputProps}
              onKeyDown={(e) => {
                if (slash.onKeyDown(e)) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {stopping && interrupt ? (
              <Tooltip content={t('view.interruptHint')}>
                <button type="button" className="composer-send is-interrupt" aria-label={t('work:runView.interrupt')} disabled={interrupt.pending} onClick={interrupt.run}>
                  <Square size={14} strokeWidth={2.5} aria-hidden />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content={sendName}>
                <button type="submit" className="composer-send" aria-label={sendName} disabled={empty || files.uploading || submit.isPending}>
                  <Icon {...ICON_SM} />
                </button>
              </Tooltip>
            )}
          </form>
        </SlashMenu>
      </div>
      <StatusLine chat={chat} kind={kind} choices={choices} onChoices={setChoices} />
      <ErrorBox error={submit.error} title={kind === 'send' ? t('work:runView.notSent') : kind === 'resume' ? t('composer.couldNotResume') : t('composer.couldNotFork')} />
    </div>
  );
}
