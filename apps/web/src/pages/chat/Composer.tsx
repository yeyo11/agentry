import type { Chat, PermissionMode } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GitFork, Play, SendHorizontal } from 'lucide-react';
import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ToolChoices } from '../../components/ChatToolsPicker';
import { AttachButton, AttachmentTray, useAttachments } from '../../components/Attachments';
import { ICON_SM } from '../../components/icons';
import { ErrorBox } from '../../components/ui';
import { api, keys } from '../../api';

// Its Select and Combobox are Radix controls kept out of the shell bundle this page lives in
const StartOptions = lazy(() => import('./Controls').then((m) => ({ default: m.StartOptions })));

/** What a message does: reaches a live process, resumes the chat in place, or continues a copy of it. */
export type ComposerKind = 'send' | 'resume' | 'fork';

export interface StartChoices extends ToolChoices {
  permissionMode?: PermissionMode;
  model?: string;
}

/**
 * The message box, with its own text state: the transcript above it can be thousands of nodes, and
 * re-rendering the page on every character typed here is enough to lock the tab up.
 */
export function Composer({ chat, kind, onSent }: { chat: Chat; kind: ComposerKind; onSent: () => void }) {
  const { t } = useTranslation(['chat', 'work']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<StartChoices>({});
  const files = useAttachments();
  const box = useRef<HTMLTextAreaElement>(null);
  const working = chat.state === 'working';

  const submit = useMutation({
    mutationFn: (message: string) => {
      const attachments = files.ids.length ? { attachments: files.ids } : {};
      if (kind === 'send') return api.sendMessage(chat.id, { text: message, ...attachments });
      // A chat resumed or forked from here is answered here: permissions would otherwise be denied unasked
      const request = { prompt: message, ...attachments, permissionPrompts: 'host' as const, ...choices };
      return kind === 'resume' ? api.resumeChat(chat.id, request) : api.forkChat(chat.id, request);
    },
    onSuccess: (result) => {
      setText('');
      files.clear();
      onSent();
      void queryClient.invalidateQueries({ queryKey: keys.chats });
      void queryClient.invalidateQueries({ queryKey: keys.chatScope(chat.id) });
      if (kind === 'fork') navigate(`/chats/${result.id}`);
    },
  });

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
    if ((message || files.ids.length) && !files.uploading && !submit.isPending) submit.mutate(message);
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
  const Icon = kind === 'fork' ? GitFork : kind === 'resume' ? Play : SendHorizontal;

  return (
    <>
      <div {...files.dropProps}>
        <AttachmentTray state={files} />
        <form
          className="composer"
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={(!text.trim() && files.ids.length === 0) || files.uploading || submit.isPending}>
            <Icon {...ICON_SM} />
            {submit.isPending ? label.pending : files.uploading ? t('work:shared.uploading') : label.idle}
          </button>
        </form>
        {kind !== 'send' && (
          <Suspense fallback={null}>
            <StartOptions chat={chat} value={choices} onChange={setChoices} />
          </Suspense>
        )}
      </div>
      <ErrorBox error={submit.error} title={kind === 'send' ? t('work:runView.notSent') : kind === 'resume' ? t('composer.couldNotResume') : t('composer.couldNotFork')} />
    </>
  );
}
