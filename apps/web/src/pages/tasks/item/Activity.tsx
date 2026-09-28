import type { FlowRun, WorkItemComment, WorkItemDetail, WorkItemHistoryEntry, WorkItemPriority, WorkItemStatus, WorkItemType } from '@agentry/shared';
import { ArrowRight, ArrowUp, Check, Hourglass, Link2, MessageSquare, Pencil, Play, Plus, RotateCcw, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useWorkItemRuns } from '../../../api';
import { Monogram } from '../../../components/icons';
import { Segmented } from '../../../components/ui';
import { formatDateTime, timeAgo } from '../../../lib/format';
import { columnMeta, priorityMeta } from '../../../lib/work-items';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';
import { AgentMark } from './Criteria';
import type { ItemActions } from './hooks';
import { activityOf, causeLine, historyLine, shortId, type ActivityFilter, type HistoryLine } from './model';
import { RunStatusBadge, useFailureReason } from './RunParts';
import { commentRun, failureCommentRun, retriesOf, runStep } from './runs';

const Markdown = lazy(() => import('../../../components/Markdown'));

const HISTORY_ICON: Record<HistoryLine['icon'], LucideIcon> = {
  created: Plus,
  forward: ArrowRight,
  start: Play,
  done: Check,
  check: Check,
  edit: Pencil,
  relation: Link2,
  link: MessageSquare,
  wait: Hourglass,
};

function HistoryItem({ entry, person }: { entry: WorkItemHistoryEntry; person: string }) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const roleName = useRoleName();
  const line = historyLine(entry);
  // Columns, types and priorities travel as ids; the page says them in its language
  const word = (name: string, value: string): string => {
    if (entry.change === 'status') return tt(columnMeta(value as WorkItemStatus).label);
    if (entry.change === 'type') return tt(`type.${value as WorkItemType}`);
    if (entry.change === 'priority' && name === 'to') return tt(priorityMeta(value as WorkItemPriority).label);
    return value;
  };
  const values = Object.fromEntries(Object.entries({ ...line.values, person }).map(([name, value]) => [name, word(name, value)]));
  const cause = causeLine(entry.cause);
  const who = entry.actor.kind === 'person' ? person : entry.actor.kind === 'agent' ? (entry.actor.role ? roleName(entry.actor.role) : t('actor.agent')) : t('actor.system');
  const Icon = HISTORY_ICON[line.icon];
  // The keys are checked against the English file where the model builds them (HistoryKey,
  // CauseKey); a union of them with a bag of values is more than t's overloads resolve
  const say = t as unknown as (key: string, values: Record<string, string>) => string;
  return (
    <li className="history-entry">
      <span className="history-icon" aria-hidden>
        <span>
          <Icon size={11} strokeWidth={2} />
        </span>
      </span>
      <span className="history-text">
        <span>
          {say(line.key, values)}
          {line.strong && (
            <>
              {' '}
              <b>{values[line.strong]}</b>
            </>
          )}
        </span>
        <span className="history-cause">{cause ? `${who} · ${say(cause.key, cause.values)}` : who}</span>
      </span>
      <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
        {timeAgo(entry.createdAt)}
      </time>
    </li>
  );
}

/**
 * A person's retry of a failed flow run, as a history entry the core does not write: "Verification
 * retried · yeyo · QA started chat 7c2e01", or queued while no chat has started yet.
 */
function RetryItem({ run, person }: { run: FlowRun; person: string }) {
  const { t } = useTranslation('workItem');
  const roleName = useRoleName();
  const role = roleName(run.role);
  const what = run.chatId ? t('run.retriedChat', { role, chat: shortId(run.chatId) }) : t('run.retriedQueued', { role });
  return (
    <li className="history-entry">
      <span className="history-icon" aria-hidden>
        <span>
          <RotateCcw size={11} strokeWidth={2} />
        </span>
      </span>
      <span className="history-text">
        <span>{t(`run.retried.${runStep(run)}`)}</span>
        <span className="history-cause">
          {person} · {what}
        </span>
      </span>
      <time dateTime={run.queuedAt} title={formatDateTime(run.queuedAt)}>
        {timeAgo(run.queuedAt)}
      </time>
    </li>
  );
}

/**
 * The comment the core writes when a run fails is English ("This verification run failed and moved
 * nothing: …"): drawn from the run instead, in the person's words, with the way to its chat.
 */
function FailureText({ run, column }: { run: FlowRun; column: WorkItemStatus }) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const reason = useFailureReason()(run);
  return (
    <p>
      {t(`run.failedHead.${runStep(run)}`)} {reason} {t('run.stays', { column: tt(columnMeta(column).label) })}{' '}
      {run.chatId && (
        <Link to={`/chats/${run.chatId}`} className="comment-run-chat">
          {t('run.seeChat')}
        </Link>
      )}
    </p>
  );
}

function CommentItem({ comment, person, runs }: { comment: WorkItemComment; person: string; runs: readonly FlowRun[] }) {
  const { t } = useTranslation('workItem');
  const roleName = useRoleName();
  const agent = comment.author.kind !== 'person';
  const role = comment.author.kind === 'agent' ? comment.author.role : null;
  const chat = comment.source?.chatId;
  // A flow run's comment names its run and how it ended; the agent's name already says who wrote it
  const run = commentRun(comment, runs);
  const failure = failureCommentRun(comment, runs);
  return (
    <li className={`comment ${agent ? 'agent' : ''}`.trim()}>
      {role ? <RoleAvatar role={role} /> : agent ? <AgentMark size={28} label={t('actor.agent')} /> : <Monogram name={person} size={28} />}
      <div className="comment-body">
        <div className="comment-head">
          <b>{agent ? (role ? roleName(role) : t('actor.agent')) : person}</b>
          {run && run.state === 'ended' && <RunStatusBadge run={run} />}
          {agent && chat && <span className="mono small muted">{run ? `${t('run.flowRun')} · ${t('link.chat', { id: shortId(chat) })}` : t('link.chat', { id: shortId(chat) })}</span>}
          <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>
            {timeAgo(comment.createdAt)}
          </time>
        </div>
        <div className="comment-text">
          {failure ? (
            <FailureText run={failure} column={failure.column} />
          ) : (
            <Suspense fallback={<p>{comment.body}</p>}>
              <Markdown text={comment.body} />
            </Suspense>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The item's flow runs, which tell its flow comments, and a person's retries among them, which are
 * history of their own. Only fetched for an item the flow has worked on.
 */
export function useItemRuns(item: Pick<WorkItemDetail, 'id' | 'links'>): { runs: FlowRun[]; retries: FlowRun[] } {
  const flowMade = item.links.some((link) => link.kind === 'chat' && Boolean(link.teamRole));
  const runs = useWorkItemRuns(item.id, flowMade).data ?? [];
  return { runs, retries: retriesOf(runs) };
}

/** The box a comment is written in; Ctrl/⌘ + Enter sends it as well as the button. */
export function CommentBox({ actions, compact = false }: { actions: ItemActions; compact?: boolean }) {
  const { t } = useTranslation('workItem');
  const [body, setBody] = useState('');
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if (!text || actions.comment.isPending) return;
    actions.comment.mutate(text, { onSuccess: () => setBody('') });
  };
  return (
    <form className={`comment-box ${compact ? 'is-compact' : ''}`.trim()} onSubmit={send} aria-label={t('activity.write')}>
      <label className="comment-field">
        {compact && <MessageSquare size={16} strokeWidth={1.75} aria-hidden />}
        <textarea
          rows={compact ? 1 : 2}
          value={body}
          aria-label={t('activity.write')}
          placeholder={t('activity.placeholder')}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
        />
      </label>
      <button type="submit" className={compact ? 'btn comment-send' : 'btn btn-small'} aria-label={t('activity.send')} disabled={!body.trim() || actions.comment.isPending}>
        {compact ? <ArrowUp size={18} strokeWidth={1.75} aria-hidden /> : t('activity.send')}
      </button>
    </form>
  );
}

/**
 * Comments by the person and by agents, interleaved with the history the store wrote, oldest
 * first: an automatic move names its cause. A segmented control narrows it to either.
 */
export function Activity({ item, actions, person, compact = false }: { item: WorkItemDetail; actions: ItemActions; person: string; compact?: boolean }) {
  const { t } = useTranslation('workItem');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const { runs, retries } = useItemRuns(item);
  const entries = activityOf(item.history, item.comments, filter, retries);
  return (
    <section className="workitem-section workitem-activity" aria-labelledby={`activity-${item.id}`}>
      <div className={compact ? 'workitem-section-head is-bare' : 'workitem-section-head'}>
        <h2 id={`activity-${item.id}`} className={compact ? 'sr-only' : 'workitem-h2 grow'}>
          {t('activity.title')}
        </h2>
        {/* On a phone the section's own tab already says what it holds, as the prototype draws it */}
        {!compact && (
          <Segmented<ActivityFilter>
            label={t('activity.filter')}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('activity.all') },
              {
                value: 'comments',
                label: (
                  <>
                    {t('activity.comments')} <span className="segment-count">{item.comments.length}</span>
                  </>
                ),
              },
              {
                value: 'history',
                label: (
                  <>
                    {t('activity.history')} <span className="segment-count">{item.history.length + retries.length}</span>
                  </>
                ),
              },
            ]}
          />
        )}
      </div>
      {entries.length === 0 ? (
        <p className="muted small workitem-none">{filter === 'comments' ? t('activity.noComments') : t('activity.none')}</p>
      ) : (
        <ol className="activity">
          {entries.map((entry) =>
            entry.kind === 'history' ? (
              <HistoryItem key={entry.entry.id} entry={entry.entry} person={person} />
            ) : entry.kind === 'retry' ? (
              <RetryItem key={`retry-${entry.run.id}`} run={entry.run} person={person} />
            ) : (
              <CommentItem key={entry.comment.id} comment={entry.comment} person={person} runs={runs} />
            ),
          )}
        </ol>
      )}
      {!compact && <CommentBox actions={actions} />}
    </section>
  );
}
