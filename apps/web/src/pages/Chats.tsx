import type { ChatState, ChatSummary } from '@agentry/shared';
import { GitBranch, MessageSquare, Plus, RotateCcw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Checkbox, Select } from '../components/controls';
import { ContextMeter, ControlBadge, LastOutcome, OriginBadge, StateBadge } from '../components/ChatBadges';
import { ICON_SM } from '../components/icons';
import { Card, Empty, ErrorBox, PageHeader, Segmented, Skeleton } from '../components/ui';
import { useChats } from '../api';
import {
  ALL_ORIGINS,
  formatUsd,
  matchesFilters,
  originsToFetch,
  ORIGIN_LABEL,
  SORT_LABEL,
  STATE_LABEL,
  SORTERS,
  type ChatFilters,
  type ChatOriginFilter,
  type ChatSort,
} from '../lib/chat-model';
import { formatDateTime, formatNumber, timeAgo } from '../lib/format';
import i18n from '../i18n';

const PAGE = 100;
const STATES: readonly ChatState[] = ['working', 'waiting', 'idle'];
const SORTS = Object.keys(SORT_LABEL) as ChatSort[];

/** Where the chat came from, with the orchestration named when it works for one. */
function originLabel(chat: ChatSummary): string {
  if (chat.origin !== 'orchestration' || !chat.orchestration) return ORIGIN_LABEL[chat.origin];
  return `${chat.orchestration.name} · ${chat.orchestration.taskName ?? i18n.t('chats:list.synthesis')}`;
}

function ChatRow({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation('chats');
  const subtitle = chat.firstPrompt && chat.firstPrompt.split('\n')[0]?.slice(0, 100) !== chat.title ? chat.firstPrompt : null;
  return (
    <li className="crow">
      <Link to={`/chats/${chat.id}`} className="crow-link">
        <span className="crow-main">
          <span className="crow-title">
            <StateBadge state={chat.state} />
            <LastOutcome chat={chat} />
            <span className="crow-title-text">{chat.title}</span>
          </span>
          {subtitle && (
            <span className="crow-sub" title={subtitle}>
              {subtitle}
            </span>
          )}
          <span className="meta">
            <OriginBadge origin={chat.origin} label={originLabel(chat)} />
            <ControlBadge control={chat.control} />
            {chat.derivedFrom && <span>{t('list.fork')}</span>}
            <span>{chat.project?.name ?? t('list.noProject')}</span>
            {chat.worktree && (
              <span className="chip chip-static mono" title={chat.worktree.path}>
                <GitBranch size={12} strokeWidth={1.75} aria-hidden /> {chat.worktree.branch ?? chat.worktree.name}
              </span>
            )}
            {chat.model && <span className="chip chip-static mono">{chat.model}</span>}
            <span>{t('list.messages', { n: formatNumber(chat.messageCount) })}</span>
          </span>
        </span>
        <span className="crow-side">
          <ContextMeter chat={chat} />
          <span className="small muted">{t('list.cost', { cost: formatUsd(chat.cost.usd) })}</span>
          <span className="small muted nowrap" title={formatDateTime(chat.updatedAt)}>
            {timeAgo(chat.updatedAt)}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function Chats() {
  const { t } = useTranslation('chats');
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);

  const state = STATES.find((s) => s === params.get('state')) ?? null;
  const sort = SORTS.find((s) => s === params.get('sort')) ?? 'activity';
  const workers = params.get('workers') === '1';
  const internal = params.get('internal') === '1';
  const originParam = params.get('origin');
  const origins = useMemo(
    () => new Set<ChatOriginFilter>(originParam ? ALL_ORIGINS.filter((o) => originParam.split(',').includes(o)) : ALL_ORIGINS),
    [originParam],
  );
  // The project chosen in the top bar; `loose` is the chats under no project
  const scope = params.get('project');
  const project = scope === null ? undefined : scope === 'loose' ? null : scope;

  const stateOptions = [
    { value: 'all', label: t('list.stateAll'), title: t('list.stateAllHint') },
    { value: 'working', label: STATE_LABEL.working, title: t('list.stateWorkingHint') },
    { value: 'waiting', label: STATE_LABEL.waiting, title: t('list.stateWaitingHint') },
    { value: 'idle', label: STATE_LABEL.idle },
  ] as const;

  const filters: ChatFilters = { origins, state, workers, internal, search };
  const chats = useChats({ origin: originsToFetch(filters), ...(project !== undefined ? { project } : {}) });

  const patch = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
    setShown(PAGE);
  };

  const all = chats.data ?? [];
  const visible = useMemo(
    () => all.filter((chat) => matchesFilters(chat, { origins, state, workers, internal, search })).sort(SORTERS[sort]),
    [all, origins, state, workers, internal, search, sort],
  );
  const working = all.filter((c) => c.state === 'working').length;
  const waiting = all.filter((c) => c.state === 'waiting').length;
  const filtersActive = Boolean(search.trim()) || state !== null || workers || internal || origins.size !== ALL_ORIGINS.length || sort !== 'activity';

  const toggleOrigin = (origin: ChatOriginFilter) => {
    const next = new Set(origins);
    if (next.has(origin)) next.delete(origin);
    else next.add(origin);
    // At least one origin stays on: an empty list explains nothing
    if (next.size === 0) return;
    patch({ origin: next.size === ALL_ORIGINS.length ? null : [...next].join(',') });
  };

  return (
    <>
      <PageHeader
        title={t('list.title')}
        subtitle={
          <span className="meta">
            <span role="status">
              {t('list.count', { shown: formatNumber(visible.length), total: formatNumber(all.length) })}
            </span>
            {working > 0 && <span>{t('list.working', { n: formatNumber(working) })}</span>}
            {waiting > 0 && <span>{t('list.waiting', { n: formatNumber(waiting) })}</span>}
            {filtersActive && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setSearch('');
                  setParams(scope ? { project: scope } : {}, { replace: true });
                }}
              >
                <RotateCcw size={11} strokeWidth={2} aria-hidden /> {t('list.resetFilters')}
              </button>
            )}
          </span>
        }
        actions={
          <Link to="/chats/new" className="btn btn-primary">
            <Plus size={14} strokeWidth={2} aria-hidden />
            {t('list.newChat')}
          </Link>
        }
      />

      <div className="filter-bar">
        <div className="search-field grow">
          <Search {...ICON_SM} />
          <input
            type="search"
            placeholder={t('list.searchPlaceholder')}
            aria-label={t('list.searchLabel')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setShown(PAGE);
            }}
          />
        </div>
        <Segmented
          label={t('list.stateLabel')}
          value={state ?? 'all'}
          onChange={(v) => patch({ state: v === 'all' ? null : v })}
          options={stateOptions}
        />
        <Select<ChatSort> aria-label={t('list.sortLabel')} value={sort} onChange={(v) => patch({ sort: v === 'activity' ? null : v })} options={SORTS.map((value) => ({ value, label: SORT_LABEL[value] }))} />
        <div className="chips" role="group" aria-label={t('list.originLabel')}>
          {ALL_ORIGINS.map((origin) => (
            <button
              key={origin}
              type="button"
              className={`chip chip-toggle ${origins.has(origin) ? 'chip-on' : ''}`}
              aria-pressed={origins.has(origin)}
              onClick={() => toggleOrigin(origin)}
            >
              {origin === 'orchestration' ? t('list.orchestrationSyntheses') : ORIGIN_LABEL[origin]}
            </button>
          ))}
        </div>
        <Checkbox checked={workers} onChange={(on) => patch({ workers: on ? '1' : null })} tooltip={t('list.workersHint')}>
          {t('list.workers')}
        </Checkbox>
        <Checkbox checked={internal} onChange={(on) => patch({ internal: on ? '1' : null })} tooltip={t('list.internalHint')}>
          {t('list.internal')}
        </Checkbox>
      </div>

      <ErrorBox error={chats.error} />

      {chats.isLoading ? (
        <Card>
          <Skeleton rows={8} height={20} />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <Empty
            icon={MessageSquare}
            title={filtersActive ? t('list.emptyFiltered') : t('list.empty')}
            action={
              !filtersActive && (
                <Link to="/chats/new" className="btn btn-primary">
                  {t('list.newChat')}
                </Link>
              )
            }
          >
            {filtersActive ? t('list.emptyFilteredBody') : t('list.emptyBody')}
          </Empty>
        </Card>
      ) : (
        <Card className="scard">
          <ul className="list-plain">
            {visible.slice(0, shown).map((chat) => (
              <ChatRow key={chat.id} chat={chat} />
            ))}
          </ul>
          {visible.length > shown && (
            <div className="crow-more">
              <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
                {t('list.showMore', { n: formatNumber(visible.length - shown) })}
              </button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
