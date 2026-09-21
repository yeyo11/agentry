import type { Chat, TranscriptEntry } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet } from '../../components/controls/Sheet';
import { ActivityLine } from '../../components/observe/Activity';
import { ChatChangesView, type ChangeSource } from '../../components/observe/Changes';
import { isStepIn } from '../../components/observe/Health';
import { Stepper } from '../../components/Stepper';
import { ErrorBox, TabPanel, Tabs, useTabGroup } from '../../components/ui';
import { api } from '../../api';
import { checklistStepState } from '../../lib/chat-live';
import { WIDE, useMediaQuery } from '../../lib/media';
import { checklistProgress } from '../../lib/observe';
import { BranchesCard, EnvironmentCard, ExecutionsCard, FactsCard, HealthCard, Section, UsageCard } from './Side';
import { ToolsCard } from './ToolsCard';

export const INSPECTOR_TABS = ['summary', 'activity', 'changes', 'environment'] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

// ---------- open or closed, remembered ----------

const STORAGE_KEY = 'agentry-chat-inspector';
const listeners = new Set<() => void>();

function storedOpen(): boolean {
  try {
    // Open unless someone closed it: on a wide screen the side panel is where the facts were
    return localStorage.getItem(STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function storeOpen(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // private mode: it is remembered for this page only
  }
  for (const listener of listeners) listener();
}

/**
 * Whether the inspector shows, and as what. On a wide screen it is a side panel whose open or
 * closed state is remembered; below that it is a sheet over the chat, which always starts closed —
 * a sheet that opens by itself on a phone would hide the conversation it was opened for.
 */
export function useInspector() {
  const wide = useMediaQuery(WIDE);
  const remembered = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    storedOpen,
    () => true,
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<InspectorTab>('summary');
  const open = wide ? remembered : sheetOpen;
  const setOpen = useCallback((next: boolean) => (wide ? storeOpen(next) : setSheetOpen(next)), [wide]);
  const show = useCallback(
    (next: InspectorTab) => {
      setTab(next);
      setOpen(true);
    },
    [setOpen],
  );
  return { wide, open, setOpen, toggle: () => setOpen(!open), tab, setTab, show };
}

export type InspectorState = ReturnType<typeof useInspector>;

// ---------- the tabs ----------

/** The checklist the chat keeps for itself, as a timeline: what is done, what it is on, what is left. */
function ChecklistSteps({ chat }: { chat: Chat }) {
  const { t } = useTranslation('observe');
  const live = chat.state === 'working';
  const { data, error } = useQuery({ queryKey: ['chat', chat.id, 'checklist'], queryFn: () => api.chatChecklist(chat.id), refetchInterval: live ? 10_000 : false });
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  if (data.items.length === 0) return <p className="muted small">{t('checklist.none')}</p>;
  const { done, total, current } = checklistProgress(data.items);
  return (
    <div className="stack-tight">
      <p className="small muted">
        {t('checklist.progress', { done, total })}
        {current ? ` · ${t('checklist.onIt', { text: current.text })}` : ''}
      </p>
      <Stepper
        className="insp-checklist"
        label={t('checklist.title')}
        steps={data.items.map((item, i) => ({ id: String(i), label: item.text, state: checklistStepState(item) }))}
      />
    </div>
  );
}

function ActivityTab({ chat, entries }: { chat: Chat; entries: TranscriptEntry[] }) {
  const { t } = useTranslation('observe');
  // Waiting on a permission prompt is not running a command, so only `working` says a call is in flight
  const live = chat.state === 'working';
  return (
    <>
      <Section title={t('activity.title')}>
        <ActivityLine entries={entries} live={live} />
      </Section>
      <Section title={t('checklist.title')}>
        <ChecklistSteps chat={chat} />
      </Section>
      <ExecutionsCard chat={chat} />
    </>
  );
}

function ChangesTab({ chat }: { chat: Chat }) {
  const { t } = useTranslation('observe');
  const source: ChangeSource = {
    queryKey: ['chat', chat.id, 'changes'],
    diff: (path) => api.chatDiff(chat.id, path),
    dir: chat.worktree?.path ?? null,
    // The main checkout is not part of what a chat knows about itself
    compare: null,
    live: Boolean(chat.execution),
  };
  return (
    <Section title={t('changes.title')}>
      <ChatChangesView source={source} load={() => api.chatChanges(chat.id)} />
    </Section>
  );
}

/**
 * Everything the chat page knows about the chat that is not the conversation, in four tabs instead
 * of nine stacked cards. Health a person has to act on (a command to cancel, a hint to send) is
 * put on the first tab as well, so it is never a tab away while the chat is stuck.
 */
function InspectorBody({ chat, entries, tab, onTab }: { chat: Chat; entries: TranscriptEntry[]; tab: InspectorTab; onTab: (tab: InspectorTab) => void }) {
  const { t } = useTranslation('chat');
  const group = useTabGroup();
  const stepIn = chat.health.signals.some(isStepIn) || chat.health.proposal?.status === 'proposed';
  return (
    <div className="run-side chat-inspector-body">
      <Tabs group={group} value={tab} onChange={onTab} label={t('inspector.tabs')} inline tabs={INSPECTOR_TABS.map((id) => ({ id, label: t(`inspector.tab.${id}`) }))} />
      <TabPanel group={group} tab={tab} className="insp-panel">
        {tab === 'summary' && (
          <>
            {stepIn && <HealthCard chat={chat} />}
            <UsageCard chat={chat} />
            <FactsCard chat={chat} />
          </>
        )}
        {tab === 'activity' && <ActivityTab chat={chat} entries={entries} />}
        {tab === 'changes' && <ChangesTab chat={chat} />}
        {tab === 'environment' && (
          <>
            <BranchesCard chat={chat} />
            {!stepIn && <HealthCard chat={chat} />}
            <ToolsCard chat={chat} />
            <EnvironmentCard chat={chat} />
          </>
        )}
      </TabPanel>
    </div>
  );
}

export function Inspector({ chat, entries, state }: { chat: Chat; entries: TranscriptEntry[]; state: InspectorState }) {
  const { t } = useTranslation('chat');
  if (state.wide) {
    if (!state.open) return null;
    return (
      <aside className="chat-inspector" aria-label={t('view.details')}>
        <InspectorBody chat={chat} entries={entries} tab={state.tab} onTab={state.setTab} />
      </aside>
    );
  }
  return (
    <Sheet open={state.open} onOpenChange={state.setOpen} title={t('view.details')} className="chat-inspector-sheet">
      <InspectorBody chat={chat} entries={entries} tab={state.tab} onTab={state.setTab} />
    </Sheet>
  );
}
