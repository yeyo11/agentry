import type { Chat, Orchestration, OrchestrationTaskState, TranscriptEntry } from '@agentry/shared';
import { useQueryClient } from '@tanstack/react-query';
import { GitMerge, ListChecks, Terminal, X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { ICON_SM } from '../icons';
import { Card, StatusBadge } from '../ui';
import { ActivityLine, useChatTail } from './Activity';
import { ChangesView, ChatChangesView, type ChangeSource } from './Changes';
import { ChecklistView } from './Checklist';
import { HealthBadge, HealthPanel, isStepIn } from './Health';

/*
 * What an agent is really doing, put together from the parts: the command it runs and how long it
 * has been quiet, what core makes of its health, the plan it wrote for itself and the files it
 * changed. A task and a chat are read from different routes and share everything else.
 */

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="stack-tight obs-section">
    <h3 className="obs-head">{title}</h3>
    {children}
  </section>
);

// ---------- a task of an orchestration ----------

/** The wide panel under the board for the task a person picked. */
export function TaskWork({ orch, task, onClose }: { orch: Orchestration; task: OrchestrationTaskState; onClose: () => void }) {
  const { t } = useTranslation(['observe', 'common']);
  const queryClient = useQueryClient();
  const headingId = useId();
  const live = task.status === 'running';
  const chatId = task.sessionId ?? null;
  const entries = useChatTail(chatId, live);
  // Under the graph's key: `changes.updated` refreshes the graph, and everything read for it with it
  const base = keys.orchestration(orch.id);
  const source: ChangeSource = {
    queryKey: [...base, 'changes', task.id],
    diff: (path) => api.taskDiff(orch.id, task.id, path),
    dir: task.worktree ?? null,
    compare: orch.cwd,
    live,
  };
  const started = task.status !== 'pending' && task.status !== 'blocked';

  return (
    <Card
      className="obs-panel"
      title={
        <span className="title-icon" id={headingId}>
          <ListChecks {...ICON_SM} /> {t('observe:task.title', { name: task.name || task.id })}
        </span>
      }
      actions={
        <span className="obs-panel-actions">
          <StatusBadge status={task.status} />
          {task.health && <HealthBadge health={task.health} />}
          <button type="button" className="icon-btn" aria-label={t('observe:task.close')} onClick={onClose}>
            <X {...ICON_SM} />
          </button>
        </span>
      }
    >
      {!started ? (
        <p className="muted small">{t('observe:task.notStarted')}</p>
      ) : (
        <div className="stack">
          {chatId && (
            <Section title={t('observe:activity.title')}>
              <ActivityLine entries={entries} live={live} />
            </Section>
          )}
          {task.health && task.health.signals.some(isStepIn) && (
            <Section title={t('observe:health.title')}>
              <HealthPanel
                health={task.health}
                chatId={chatId}
                live={live}
                badge={false}
                sendHint={(text) =>
                  api.hintOrchestrationTask(orch.id, task.id, { text }).then((next) => queryClient.setQueryData(keys.orchestration(orch.id), next))
                }
              />
            </Section>
          )}
          {chatId && (
            <Section title={t('observe:checklist.title')}>
              <ChecklistView queryKey={[...base, 'checklist', task.id]} load={() => api.taskChecklist(orch.id, task.id)} live={live} />
            </Section>
          )}
          <Section title={t('observe:changes.title')}>
            {orch.worktree && task.branch ? (
              <ChangesView source={source} load={() => api.taskChanges(orch.id, task.id)} inline />
            ) : (
              <p className="muted small">{t('observe:changes.noWorktree')}</p>
            )}
          </Section>
        </div>
      )}
    </Card>
  );
}

// ---------- the integration branch ----------

/** What the branch that merges every task's work holds, next to the pull request that would publish it. */
export function IntegrationChanges({ orch }: { orch: Orchestration }) {
  const integration = orch.integration;
  if (!integration) return null;
  const source: ChangeSource = {
    queryKey: [...keys.orchestration(orch.id), 'changes', 'integration'],
    diff: (path) => api.integrationDiff(orch.id, path),
    dir: integration.worktree,
    compare: orch.cwd,
    live: integration.status === 'merging' || integration.status === 'resolving',
  };
  return <ChangesView source={source} load={() => api.integrationChanges(orch.id)} inline />;
}

// ---------- a chat ----------

/** What a chat is doing now and the plan it keeps, for the side of its page. */
export function ChatActivityCard({ chat, entries }: { chat: Chat; entries: TranscriptEntry[] | null }) {
  const { t } = useTranslation('observe');
  // Waiting on a permission prompt is not running a command, so only `working` says a call is in flight
  const live = chat.state === 'working';
  return (
    <Card
      title={
        <span className="title-icon">
          <Terminal {...ICON_SM} /> {t('activity.title')}
        </span>
      }
    >
      <div className="stack">
        <ActivityLine entries={entries} live={live} />
        <Section title={t('checklist.title')}>
          <ChecklistView queryKey={['chat', chat.id, 'checklist']} load={() => api.chatChecklist(chat.id)} live={live} />
        </Section>
      </div>
    </Card>
  );
}

/** The git summary of a chat in a worktree, or the files its own calls wrote when there is none. */
export function ChatChangesCard({ chat }: { chat: Chat }) {
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
    <Card
      title={
        <span className="title-icon">
          <GitMerge {...ICON_SM} /> {t('changes.title')}
        </span>
      }
    >
      <ChatChangesView source={source} load={() => api.chatChanges(chat.id)} />
    </Card>
  );
}
