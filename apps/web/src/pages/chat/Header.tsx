import type { Chat } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, CirclePause, CircleSlash, Copy, Download, GitFork, Hand, Info, Search, Square, Trash2, WifiOff } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
// Direct imports: this page is in the shell bundle, and the barrel would pull the lazy form controls into it
import { Menu, type MenuEntry } from '../../components/controls/Menu';
import { Tooltip } from '../../components/controls/Tooltip';
import { HealthBadge } from '../../components/observe/Health';
import { ProgressBar } from '../../components/ProgressBar';
import { SplitButton } from '../../components/SplitButton';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import type { TranscriptFind } from '../../components/TranscriptSearch';
import { ICON, ICON_SM } from '../../components/icons';
import { api } from '../../api';
import { chatPill, checklistCounts, RECONNECTING_AFTER_MS } from '../../lib/chat-live';
import { COMPACT, useMediaQuery } from '../../lib/media';
import { checklistProgress } from '../../lib/observe';
import type { InspectorTab } from './Inspector';

/** True once `on` has held for `ms`: a flag that does not flap on a blip. */
function useHeldFor(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    setHeld(false);
    if (!on) return;
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return held;
}

const PILL_ICON = { waiting: Hand, idle: CirclePause } as const;

/**
 * The chat's state, who drives it and whether its stream is up, as one pill: "Working · live".
 * A stream that drops is only called reconnecting once it has stayed down a few seconds.
 */
export function StatePill({ chat, connected }: { chat: Chat; connected: boolean }) {
  const { t } = useTranslation('chat');
  const downLong = useHeldFor(Boolean(chat.execution) && !connected, RECONNECTING_AFTER_MS);
  const pill = chatPill(chat, { connected, downLong });
  const Icon = pill.link === 'reconnecting' ? WifiOff : pill.tone === 'working' ? null : PILL_ICON[pill.tone];
  const hint = [t(`badges.stateHint.${pill.tone}`), chat.control.mode === 'readOnly' ? chat.control.reason : t(`pill.hint.${pill.link}`)].join('. ');
  return (
    <Tooltip content={hint}>
      <span className={`chat-pill is-${pill.tone} ${pill.link === 'reconnecting' ? 'is-reconnecting' : ''}`.trim()}>
        {Icon ? <Icon size={12} strokeWidth={2} aria-hidden /> : <Spinner />}
        <span className="chat-pill-word">{t(`badges.state.${pill.tone}`)}</span>
        <span className="chat-pill-sep" aria-hidden>
          ·
        </span>
        <span className="chat-pill-link">{t(`pill.link.${pill.link}`)}</span>
      </span>
    </Tooltip>
  );
}

/** "▰▰▱▱▱ 3/7": how far the chat is through the checklist it wrote itself; the item it is on, on hover. */
function ChecklistProgress({ chat, onOpen }: { chat: Chat; onOpen: () => void }) {
  const { t } = useTranslation(['chat', 'observe']);
  const live = chat.state === 'working';
  // The same query the inspector's checklist reads, so both show the same list
  const { data } = useQuery({ queryKey: ['chat', chat.id, 'checklist'], queryFn: () => api.chatChecklist(chat.id), refetchInterval: live ? 10_000 : false });
  if (!data || data.items.length === 0) return null;
  const { done, total, current } = checklistProgress(data.items);
  const said = [t('observe:checklist.progress', { done, total }), current ? t('observe:checklist.onIt', { text: current.text }) : ''].filter(Boolean).join(' · ');
  return (
    <Tooltip content={said}>
      <button type="button" className="chat-checklist" aria-label={t('head.checklist', { progress: said })} onClick={onOpen}>
        <span aria-hidden>
          <ProgressBar counts={checklistCounts(data.items)} variant="blocks" />
        </span>
        <span className="chat-checklist-count" aria-hidden>
          {done}/{total}
        </span>
      </button>
    </Tooltip>
  );
}

export interface HeaderActions {
  /** Only what opens and closes the search: the rest of it changes as it is typed into */
  find: Pick<TranscriptFind, 'open' | 'show' | 'close'>;
  sidechains: boolean;
  setSidechains: (on: boolean) => void;
  forking: boolean;
  setForking: (on: boolean) => void;
  stop: { run: () => void; pending: boolean };
  interrupt: { run: () => void; pending: boolean };
  remove: { run: () => void; pending: boolean };
  /** `rail`: the inspector keeps a strip of its own on the right edge, so the header needs no button for it */
  inspector: { open: boolean; rail: boolean; toggle: () => void; show: (tab: InspectorTab) => void };
}

/**
 * One line: back, the title, the pill, and only the action that fits the moment; everything else a
 * chat can do is one press away in the `⋯` menu, and everything it is in the inspector.
 */
export const ChatHeader = memo(function ChatHeader({ chat, connected, actions }: { chat: Chat; connected: boolean; actions: HeaderActions }) {
  const { t } = useTranslation(['chat', 'work', 'common', 'components']);
  const toast = useToast();
  const { control } = chat;
  const working = chat.state === 'working';
  const live = Boolean(chat.execution);
  const held = control.mode === 'readOnly';
  const { find, inspector } = actions;
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  // On a phone the title would get no room: search and interrupt move into the menu, Stop keeps its icon
  const compact = useMediaQuery(COMPACT);
  const stoppable = control.mode === 'interactive';

  const entries: MenuEntry[] = [
    ...(compact
      ? [
          {
            id: 'here',
            items: [
              { id: 'find', label: t('components:find.button'), icon: Search, checked: find.open, onSelect: () => (find.open ? find.close() : find.show()) },
              ...(stoppable && working
                ? [{ id: 'interrupt', label: t('work:runView.interrupt'), icon: CircleSlash, disabled: actions.interrupt.pending, onSelect: actions.interrupt.run }]
                : []),
            ],
          },
          { id: 'sep-0', separator: true as const },
        ]
      : []),
    {
      id: 'export',
      items: [
        // Real links: the route answers with Content-Disposition: attachment, so the browser saves the file
        { id: 'markdown', label: t('view.export.markdown'), icon: Download, href: api.chatExportUrl(chat.id, 'markdown'), download: true },
        { id: 'json', label: t('view.export.json'), icon: Download, href: api.chatExportUrl(chat.id, 'json'), download: true },
      ],
    },
    { id: 'sep-1', separator: true },
    {
      id: 'chat',
      items: [
        { id: 'fork', label: actions.forking ? t('view.cancelFork') : t('view.fork'), icon: GitFork, onSelect: () => actions.setForking(!actions.forking) },
        { id: 'sidechains', label: t('view.subagentMessages'), checked: actions.sidechains, onSelect: () => actions.setSidechains(!actions.sidechains) },
        {
          id: 'copy-id',
          label: t('view.copyId'),
          icon: Copy,
          onSelect: () =>
            void navigator.clipboard?.writeText(chat.id).then(
              () => toast.success(t('view.copiedId')),
              (error: unknown) => toast.error(t('view.copyFailed'), error),
            ),
        },
      ],
    },
    { id: 'sep-2', separator: true },
    {
      id: 'delete',
      label: actions.remove.pending ? t('work:sessionView.deleting') : t('common:actions.delete'),
      icon: Trash2,
      destructive: true,
      disabled: live || held || actions.remove.pending,
      // The same words the old button's tooltip said, now said where the item is
      disabledReason: live ? t('view.deleteLive') : held ? t('view.deleteHeld') : undefined,
      onSelect: actions.remove.run,
    },
  ];

  return (
    <header className="chat-head">
      <Tooltip content={t('view.back')}>
        <Link to="/chats" className="icon-btn chat-back" aria-label={t('view.back')}>
          <ChevronLeft {...ICON} />
        </Link>
      </Tooltip>
      <h1 className="chat-title ellipsis">{chat.title}</h1>
      <StatePill chat={chat} connected={connected} />
      {chat.health.level !== 'ok' && <HealthBadge health={chat.health} />}
      <ChecklistProgress chat={chat} onOpen={() => inspector.show('activity')} />
      <div className="chat-head-actions">
        {!compact && (
          <Tooltip content={t('components:find.buttonHint', { shortcut: `${mac ? '⌘' : 'Ctrl+'}F` })}>
            <button type="button" className="icon-btn" aria-label={t('components:find.button')} aria-pressed={find.open} onClick={() => (find.open ? find.close() : find.show())}>
              <Search {...ICON_SM} />
            </button>
          </Tooltip>
        )}
        {stoppable &&
          (compact ? (
            <Tooltip content={t('common:actions.stop')}>
              <button type="button" className="btn btn-small btn-danger chat-stop is-icon" aria-label={t('common:actions.stop')} disabled={actions.stop.pending} onClick={actions.stop.run}>
                <Square {...ICON_SM} />
              </button>
            </Tooltip>
          ) : working ? (
            <SplitButton
              className="chat-stop"
              variant="danger"
              icon={Square}
              label={t('common:actions.stop')}
              onClick={actions.stop.run}
              disabled={actions.stop.pending}
              entries={[{ id: 'interrupt', label: t('work:runView.interrupt'), icon: CircleSlash, disabled: actions.interrupt.pending, onSelect: actions.interrupt.run }]}
            />
          ) : (
            <button type="button" className="btn btn-small btn-danger chat-stop" disabled={actions.stop.pending} onClick={actions.stop.run}>
              <Square {...ICON_SM} />
              {t('common:actions.stop')}
            </button>
          ))}
        {!inspector.rail && (
          <Tooltip content={inspector.open ? t('view.hideDetails') : t('view.showDetails')}>
            <button type="button" className="icon-btn" aria-label={t('view.details')} aria-pressed={inspector.open} onClick={inspector.toggle}>
              <Info {...ICON_SM} />
            </button>
          </Tooltip>
        )}
        <Menu entries={entries} label={t('view.moreActions')} />
      </div>
    </header>
  );
});
