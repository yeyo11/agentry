import type { Overview } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, keys } from '../../api';
import { useFallbackInterval } from '../../lib/events';
import { progressBlocks, type ProgressCounts } from '../../lib/progress';
import { liveSummary, type LiveItem, type LiveSummary } from '../../lib/shell-live';
import { ActivityTicker } from '../ActivityTicker';
import { Menu, type MenuEntry } from '../controls/Menu';
import { ICON } from '../icons';
import { StatusDot } from '../motion';
import { Spinner } from '../Spinner';

/** How many chats of each state the shell asks for: it lists what is live, not the history. */
const LIVE_LIMIT = 10;
/** Rows the sidebar shows before it says how many more there are. */
const SIDEBAR_ROWS = 6;
/** Past this many tasks a segment per task is thinner than it is useful; the cells are shared out instead. */
const MAX_SEGMENTS = 12;

type Counts = Overview['counts'] | undefined;

/**
 * What is live right now, for the whole shell. The overview's counts (kept current by the event
 * feed) decide whether anything is fetched at all, so an idle wrapper costs no list requests; the
 * lists themselves are the same queries the Chats and Orchestrations pages read, so the feed
 * keeps them fresh too.
 */
export function useLive(counts: Counts): LiveSummary & { any: boolean } {
  const fallback = useFallbackInterval();
  const working = counts?.chatsWorking ?? 0;
  const waiting = counts?.chatsWaiting ?? 0;
  const running = counts?.orchestrationsRunning ?? 0;
  const workingChats = useQuery({
    queryKey: keys.chatList({ state: 'working', limit: LIVE_LIMIT }),
    queryFn: ({ signal }) => api.chats({ state: 'working', limit: LIVE_LIMIT }, { signal }),
    enabled: working > 0,
    refetchInterval: fallback,
  });
  const waitingChats = useQuery({
    queryKey: keys.chatList({ state: 'waiting', limit: LIVE_LIMIT }),
    queryFn: ({ signal }) => api.chats({ state: 'waiting', limit: LIVE_LIMIT }, { signal }),
    enabled: waiting > 0,
    refetchInterval: fallback,
  });
  const orchestrations = useQuery({ queryKey: keys.orchestrations, queryFn: api.orchestrations, enabled: running > 0, refetchInterval: fallback });
  // A list fetched while something ran stays in the cache after it stops: the counts say it is stale
  const summary = liveSummary({
    chats: [...(working > 0 ? (workingChats.data ?? []) : []), ...(waiting > 0 ? (waitingChats.data ?? []) : [])],
    orchestrations: running > 0 ? (orchestrations.data ?? []) : [],
  });
  // The counts are the numbers everywhere; the lists only say which. Worker chats of an
  // orchestration count as working but are listed under their orchestration, not one by one.
  return { ...summary, working, waiting, running, any: working + waiting + running > 0 };
}

/** "2 working · 1 waiting · 1 running", only the parts that are not zero. */
export function useLiveWords(live: LiveSummary): string[] {
  const { t } = useTranslation('shell');
  const parts: string[] = [];
  if (live.working) parts.push(t('live.working', { count: live.working }));
  if (live.waiting) parts.push(t('live.waiting', { count: live.waiting }));
  if (live.running) parts.push(t('live.running', { count: live.running }));
  return parts;
}

function ItemLabel({ item }: { item: LiveItem }) {
  const { t } = useTranslation('shell');
  return (
    <span className="live-menu-item">
      {item.kind === 'chat' && item.state === 'waiting' ? <span className="live-waiting-dot" aria-hidden /> : <Spinner />}
      <span className="ellipsis">{item.title}</span>
      <span className="live-menu-meta">
        {item.kind === 'orchestration' ? t('live.progress', { done: item.done, total: item.total }) : item.state === 'waiting' ? t('live.stateWaiting') : t('live.stateWorking')}
      </span>
    </span>
  );
}

/** The live items as menu entries, grouped by what they need from a person. */
export function useLiveEntries(live: LiveSummary): MenuEntry[] {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  const toEntry = (item: LiveItem) => ({ id: `${item.kind}:${item.id}`, label: <ItemLabel item={item} />, onSelect: () => navigate(item.href) });
  const waiting = live.items.filter((i) => i.kind === 'chat' && i.state === 'waiting');
  const working = live.items.filter((i) => i.kind === 'chat' && i.state === 'working');
  const orchestrations = live.items.filter((i) => i.kind === 'orchestration');
  const entries: MenuEntry[] = [];
  if (waiting.length) entries.push({ id: 'waiting', label: t('live.groups.waiting'), items: waiting.map(toEntry) });
  if (working.length) entries.push({ id: 'working', label: t('live.groups.working'), items: working.map(toEntry) });
  if (orchestrations.length) entries.push({ id: 'orchestrations', label: t('live.groups.orchestrations'), items: orchestrations.map(toEntry) });
  entries.push({ id: 'sep', separator: true });
  entries.push({ id: 'all-chats', label: t('live.openChats'), onSelect: () => navigate('/chats') });
  entries.push({ id: 'all-orchestrations', label: t('live.openOrchestrations'), onSelect: () => navigate('/orchestration') });
  return entries;
}

/**
 * The top bar's "● 3 agents working": there only while something runs or waits, and a menu of
 * exactly what, each a link. Live work pings in cyan; a chat waiting for a person is a still dot
 * in warn, because nothing moves until they answer.
 */
export function LiveChip({ live }: { live: LiveSummary & { any: boolean } }) {
  const { t } = useTranslation('shell');
  const entries = useLiveEntries(live);
  if (!live.any) return null;
  const working = live.working > 0 || live.running > 0;
  // Worker chats count as working, so the chats are the agents; an orchestration between two tasks
  // has none working and is counted as itself
  const visible = [
    ...(live.working ? [t('live.agentsWorking', { count: live.working })] : live.running ? [t('live.running', { count: live.running })] : []),
    ...(live.waiting ? [t('live.waiting', { count: live.waiting })] : []),
  ];
  // The visible words are the name, so what is read is what is seen; only the "Live" prefix is extra
  return (
    <Menu
      entries={entries}
      label={t('live.menu')}
      trigger={
        <button type="button" className={`live-chip ${working ? 'is-working' : 'is-waiting'}`}>
          {working ? <StatusDot tone="active" live /> : <span className="live-waiting-dot" aria-hidden />}
          <span className="sr-only">{t('live.section')}: </span>
          <span className="live-chip-text">{visible.join(' · ')}</span>
        </button>
      }
    />
  );
}

/**
 * One segment per task, as the orchestration pages draw it: done in ok, failed in bad, running as
 * a partial live fill, pending empty. Its words are the "2/6" beside it.
 */
function SegBar({ counts, total }: { counts: ProgressCounts; total: number }) {
  const cells = progressBlocks(counts, Math.min(Math.max(total, 1), MAX_SEGMENTS));
  return (
    <span className="live-segbar" aria-hidden>
      {cells.map((status, index) => (
        <i key={index} className={`is-${status}`} />
      ))}
    </span>
  );
}

/** One row of the sidebar's Live section: title, and what it is doing in words. */
function LiveRow({ item }: { item: LiveItem }) {
  const { t } = useTranslation('shell');
  if (item.kind === 'orchestration')
    return (
      <NavLink to={item.href} className="live-row is-working live-rail">
        <span className="live-row-title">
          <Spinner />
          <span className="ellipsis">{item.title}</span>
          <span className="live-row-count">
            <span aria-hidden>{t('live.progress', { done: item.done, total: item.total })}</span>
            <span className="sr-only">{t('live.progressWords', { done: item.done, total: item.total })}</span>
          </span>
        </span>
        <SegBar counts={item.progress} total={item.total} />
      </NavLink>
    );
  return (
    <NavLink to={item.href} className={`live-row ${item.state === 'waiting' ? 'is-waiting' : 'is-working live-rail'}`}>
      <span className="live-row-title">
        {item.state === 'working' ? <Spinner /> : <span className="live-waiting-dot" aria-hidden />}
        <span className="ellipsis">{item.title}</span>
      </span>
      {item.state === 'working' && item.activity ? (
        <ActivityTicker activity={item.activity} className="live-row-ticker" />
      ) : (
        <span className="live-row-meta ellipsis">
          <span className="live-row-state">{item.state === 'waiting' ? t('live.stateWaiting') : t('live.stateWorking')}</span>
          {item.project && <span> · {item.project}</span>}
        </span>
      )}
    </NavLink>
  );
}

/**
 * The sidebar's Live section, OpenCode-like: what is running and what waits for a person, each a
 * link. In the icon rail it folds into one button with the count that opens the same list.
 */
export function LiveSection({ live, rail }: { live: LiveSummary & { any: boolean }; rail: boolean }) {
  const { t } = useTranslation('shell');
  const words = useLiveWords(live);
  const entries = useLiveEntries(live);
  if (!live.any) return null;
  const total = live.working + live.waiting + live.running;

  if (rail) {
    const name = t('live.chipLabel', { summary: words.join(', ') });
    return (
      <div className="live-section is-rail">
        <Menu
          entries={entries}
          label={t('live.menu')}
          side="right"
          align="start"
          trigger={
            <button type="button" className="nav-link live-rail-btn" aria-label={name}>
              <span className="nav-icon">{live.working || live.running ? <Spinner /> : <Activity {...ICON} />}</span>
              <span className="nav-count live-count" aria-hidden>
                {total}
              </span>
            </button>
          }
        />
      </div>
    );
  }

  const rows = live.items.slice(0, SIDEBAR_ROWS);
  const hidden = live.items.length - rows.length;
  return (
    // A group, not a landmark or a heading: the sidebar comes before every page's own h1
    <div className="live-section" role="group" aria-labelledby="live-section-title">
      <div className="live-section-head">
        <span id="live-section-title">{t('live.section')}</span>
        <span className="live-section-count">
          <span aria-hidden>{total}</span>
          <span className="sr-only">{words.join(', ')}</span>
        </span>
      </div>
      <div className="live-list">
        {rows.map((item) => (
          <LiveRow key={`${item.kind}:${item.id}`} item={item} />
        ))}
        {hidden > 0 && (
          <NavLink to="/chats" className="live-more">
            {t('live.more', { count: hidden })}
          </NavLink>
        )}
      </div>
    </div>
  );
}
