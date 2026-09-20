import type { ChatState, ChatSummary } from '@agentry/shared';
import { GitBranch, MessageSquare, Plus, RotateCcw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
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
  SORTERS,
  type ChatFilters,
  type ChatOriginFilter,
  type ChatSort,
} from '../lib/chat-model';
import { formatDateTime, timeAgo } from '../lib/format';

const PAGE = 100;
const STATES: readonly ChatState[] = ['working', 'waiting', 'idle'];
const SORTS = Object.keys(SORT_LABEL) as ChatSort[];
const STATE_OPTIONS = [
  { value: 'all', label: 'All', title: 'Every chat, whatever it is doing' },
  { value: 'working', label: 'Working', title: 'A process is generating or running tools' },
  { value: 'waiting', label: 'Waiting for you', title: 'Stopped for a permission, a question or a plan' },
  { value: 'idle', label: 'Idle' },
] as const;

/** Where the chat came from, with the orchestration named when it works for one. */
function originLabel(chat: ChatSummary): string {
  if (chat.origin !== 'orchestration' || !chat.orchestration) return ORIGIN_LABEL[chat.origin];
  return `${chat.orchestration.name} · ${chat.orchestration.taskName ?? 'synthesis'}`;
}

function ChatRow({ chat }: { chat: ChatSummary }) {
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
            {chat.derivedFrom && <span>fork</span>}
            <span>{chat.project?.name ?? 'no project'}</span>
            {chat.worktree && (
              <span className="chip chip-static mono" title={chat.worktree.path}>
                <GitBranch size={12} strokeWidth={1.75} aria-hidden /> {chat.worktree.branch ?? chat.worktree.name}
              </span>
            )}
            {chat.model && <span className="chip chip-static mono">{chat.model}</span>}
            <span>{chat.messageCount} msgs</span>
          </span>
        </span>
        <span className="crow-side">
          <ContextMeter chat={chat} />
          <span className="small muted">cost {formatUsd(chat.cost.usd)}</span>
          <span className="small muted nowrap" title={formatDateTime(chat.updatedAt)}>
            {timeAgo(chat.updatedAt)}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function Chats() {
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
        title="Chats"
        subtitle={
          <span className="meta">
            <span role="status">
              {visible.length} of {all.length} chats
            </span>
            {working > 0 && <span>{working} working</span>}
            {waiting > 0 && <span>{waiting} waiting for you</span>}
            {filtersActive && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setSearch('');
                  setParams(scope ? { project: scope } : {}, { replace: true });
                }}
              >
                <RotateCcw size={11} strokeWidth={2} aria-hidden /> Reset filters
              </button>
            )}
          </span>
        }
        actions={
          <Link to="/chats/new" className="btn btn-primary">
            <Plus size={14} strokeWidth={2} aria-hidden />
            New chat
          </Link>
        }
      />

      <div className="filter-bar">
        <div className="search-field grow">
          <Search {...ICON_SM} />
          <input
            type="search"
            placeholder="Search title, first prompt, project, id…"
            aria-label="Search chats"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setShown(PAGE);
            }}
          />
        </div>
        <Segmented
          label="State"
          value={state ?? 'all'}
          onChange={(v) => patch({ state: v === 'all' ? null : v })}
          options={STATE_OPTIONS}
        />
        <Select<ChatSort> aria-label="Sort by" value={sort} onChange={(v) => patch({ sort: v === 'activity' ? null : v })} options={SORTS.map((value) => ({ value, label: SORT_LABEL[value] }))} />
        <div className="chips" role="group" aria-label="Origin">
          {ALL_ORIGINS.map((origin) => (
            <button
              key={origin}
              type="button"
              className={`chip chip-toggle ${origins.has(origin) ? 'chip-on' : ''}`}
              aria-pressed={origins.has(origin)}
              onClick={() => toggleOrigin(origin)}
            >
              {origin === 'orchestration' ? 'Orchestration syntheses' : ORIGIN_LABEL[origin]}
            </button>
          ))}
        </div>
        <Checkbox checked={workers} onChange={(on) => patch({ workers: on ? '1' : null })} tooltip="The chats that carry out the tasks of an orchestration: their home is the orchestration board">
          Orchestration workers
        </Checkbox>
        <Checkbox checked={internal} onChange={(on) => patch({ internal: on ? '1' : null })} tooltip="Housekeeping chats of Agentry itself (the planner, the auth check)">
          Internal
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
            title={filtersActive ? 'No chats match' : 'No chats yet'}
            action={
              !filtersActive && (
                <Link to="/chats/new" className="btn btn-primary">
                  New chat
                </Link>
              )
            }
          >
            {filtersActive ? 'Try resetting the filters.' : 'Chats you start here, and the ones Claude Code has run in an imported project, appear in this list.'}
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
                Show more ({visible.length - shown} left)
              </button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
