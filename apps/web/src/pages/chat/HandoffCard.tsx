import { useQuery } from '@tanstack/react-query';
import type { Chat } from '@agentry/shared';
import { ChevronRight, CornerDownRight, FileText, Hourglass, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { formatHour } from '@agentry/ui/lib/format';
import { displayTitle } from '@agentry/chat-ui/lib/chat-model';
import { useChatUi } from '@agentry/chat-ui/lib/context';
import { api } from '../../api';
import { useProviderLabel } from '../../lib/provider-status';
import { HandoffText, kib } from './MoveSheet';

/**
 * The first message of a chat that continues another: the handoff the agent received, collapsed so
 * the conversation starts at what the new agent did. It is the user entry the move wrote, shown as a
 * card of its own rather than as a person's message.
 */
export function HandoffCard({ chat, text }: { chat: Chat; text: string }) {
  const { t } = useTranslation('chats');
  const { paths } = useChatUi();
  const nameOf = useProviderLabel();
  const [open, setOpen] = useState(false);
  const from = chat.continuedFrom;
  if (!from) return null;
  const fromName = nameOf(from.provider);
  const size = kib(new TextEncoder().encode(text).length);
  return (
    <section className="hand-card" aria-label={t('limit.handoff.title', { name: fromName })}>
      <div className="hand-head">
        <FileText {...ICON} className="hand-icon" />
        <span className="hand-who">
          <span className="hand-title">{t('limit.handoff.title', { name: fromName })}</span>
          <span className="hand-sub">{t('limit.handoff.sub', { to: nameOf(chat.provider) })}</span>
          <span className="mono t-xs fg-2">{chat.model ? t('limit.handoff.meta', { size, model: chat.model }) : t('limit.handoff.metaNoModel', { size })}</span>
        </span>
        <Link to={paths.chat(from.chatId)} className="btn btn-small">
          {t('limit.handoff.previous')}
        </Link>
        <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <ChevronRight {...ICON_SM} /> {open ? t('limit.handoff.hide') : t('limit.handoff.show')}
        </button>
      </div>
      {open && <HandoffText text={text} full label={t('limit.handoff.textLabel')} />}
    </section>
  );
}

/** The header's "Continued from Claude Code", a link to the chat that stopped. */
export function ContinuedFrom({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chats');
  const { paths } = useChatUi();
  const nameOf = useProviderLabel();
  const from = chat.continuedFrom;
  if (!from) return null;
  return (
    <div className="chat-continued">
      <Link to={paths.chat(from.chatId)} className="cont-from">
        <Undo2 {...ICON_SM} /> {t('limit.continuedFrom', { name: nameOf(from.provider) })}
      </Link>
    </div>
  );
}

/** Where the old chat's transcript ends: it stopped at the limit, and the work went on elsewhere. */
export function LimitStopped({ chat, at, waiting = false }: { chat: Chat; at: string | null; waiting?: boolean }) {
  const { t } = useTranslation('chats');
  const nameOf = useProviderLabel();
  return (
    <div className="lim-stop">
      <Hourglass {...ICON_SM} className="lim-icon" />
      <span>{t('limit.stopped', { name: nameOf(chat.provider) })}</span>
      {at && !waiting && <span className="when">{formatHour(at)}</span>}
    </div>
  );
}

/** The divider that ends the old chat: "Continued on Codex in «title»", linking to the new chat. */
export function ContinuedDivider({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chats');
  const { paths } = useChatUi();
  const nameOf = useProviderLabel();
  const next = chat.continuedIn;
  const target = useQuery({
    queryKey: ['chat', next?.chatId ?? '', 'continuation'],
    queryFn: () => api.chat(next?.chatId ?? '', false, { limit: 1 }),
    enabled: Boolean(next),
    staleTime: 60_000,
  });
  if (!next) return null;
  const name = nameOf(next.provider);
  const title = target.data ? displayTitle(target.data.chat) : next.chatId.slice(0, 6);
  return (
    <Link to={paths.chat(next.chatId)} className="cont-div" aria-label={t('limit.continuedInAria', { name, id: next.chatId.slice(0, 6) })}>
      <span className="cont-line" />
      <span className="cont-body">
        <span className="cont-t">
          <CornerDownRight {...ICON_SM} />
          <span>
            <Trans t={t} i18nKey="limit.continuedIn" values={{ name, title }} components={{ b: <b /> }} />
          </span>
        </span>
        <span className="cont-m">
          {next.chatId.slice(0, 6)} · {t(`limit.continuedWith.${next.action}`)} · {formatHour(next.at)}
        </span>
      </span>
      <ChevronRight {...ICON_SM} />
      <span className="cont-line" />
    </Link>
  );
}
