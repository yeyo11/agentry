import type { IssueRef, IssueSyncState, WorkItemDetail } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleDot, ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { timeAgo } from '@agentry/ui/lib/format';
import { canSyncAgain, issueChipText, issueRef, SYNC_TONE, trackerWords } from '../../../lib/trackers';

/** An issue's sync state as a dot and a word; the word is what says it, the colour only agrees. */
export function SyncMark({ state }: { state: IssueSyncState }) {
  const { t } = useTranslation('issues');
  const tone = SYNC_TONE[state];
  return (
    <span className={`iss-sync is-${tone ?? 'idle'}`}>
      <i className="iss-dot" aria-hidden />
      {t(`sync.${state}`)}
    </span>
  );
}

/** The issues of the item grouped by tracker, in the order they were linked. */
function byTracker(issues: readonly IssueRef[]): Array<[IssueRef['tracker'], IssueRef[]]> {
  const groups = new Map<IssueRef['tracker'], IssueRef[]>();
  for (const issue of issues) groups.set(issue.tracker, [...(groups.get(issue.tracker) ?? []), issue]);
  return [...groups];
}

/**
 * One chip per issue under the title: its key in mono, where its sync stands and a link to the
 * tracker. The title of an issue is a stranger's text and never goes into the chip.
 */
export function IssueChips({ item }: { item: Pick<WorkItemDetail, 'issues'> }) {
  const { t } = useTranslation('issues');
  const issues = item.issues ?? [];
  if (issues.length === 0) return null;
  return (
    <ul className="iss-chips" aria-label={t('chip.label')}>
      {issues.map((issue) => {
        const words = trackerWords(issue.tracker);
        const inner = (
          <>
            <b className="iss-key">{issueChipText(issue)}</b>
            <SyncMark state={issue.syncState} />
            {issue.url && <ExternalLink {...ICON_SM} />}
          </>
        );
        return issue.url ? (
          <li key={`${issue.tracker}-${issue.key}`} className="iss-li">
            <a className="iss-chip" href={issue.url} target="_blank" rel="noreferrer" aria-label={t('chip.open', { ref: issueRef(issue.tracker, issue.key), tracker: words.label })}>
              {inner}
            </a>
          </li>
        ) : (
          <li key={`${issue.tracker}-${issue.key}`} className="iss-li">
            <span className="iss-chip">{inner}</span>
          </li>
        );
      })}
    </ul>
  );
}

function IssueRow({ item, issue }: { item: Pick<WorkItemDetail, 'id'>; issue: IssueRef }) {
  const { t } = useTranslation('issues');
  const qc = useQueryClient();
  const toast = useToast();
  const words = trackerWords(issue.tracker);
  // The answer is the item itself, with the chip's new state; the board reads it again
  const sync = useMutation({
    mutationFn: () => api.syncWorkItemIssue(item.id, issue.key, issue.tracker),
    onSuccess: (updated) => {
      qc.setQueryData<WorkItemDetail>(keys.workItem(item.id), (old) => (old ? { ...old, ...updated } : old));
      void qc.invalidateQueries({ queryKey: keys.workItems });
    },
    onError: (error) => {
      toast.error(t('panel.againFailed'), error);
      void qc.invalidateQueries({ queryKey: keys.workItem(item.id) });
    },
  });
  const failed = issue.syncState === 'failed';
  return (
    <div className="addr-done iss-row">
      <div className="addr-head">
        <b className="iss-key">{issueChipText(issue)}</b>
        <SyncMark state={issue.syncState} />
        <span className="small muted">{t('panel.opened', { state: issue.state, tracker: words.label })}</span>
      </div>
      <p className="iss-title">{issue.title}</p>
      <p className="small muted">
        {failed ? t('panel.failedBecause', { tracker: words.label }) : issue.syncState === 'synced' && issue.syncedAt ? t('panel.synced', { when: timeAgo(issue.syncedAt) }) : t('panel.none')}
      </p>
      {failed && issue.syncReason && (
        <p className="mono small muted iss-reason">{t('panel.reason', { code: issue.syncReason, when: timeAgo(issue.syncedAt) })}</p>
      )}
      {canSyncAgain(issue) && (
        <div className="addr-acts">
          <button type="button" className="btn btn-small" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? <Spinner /> : <RefreshCw {...ICON_SM} />}
            {t('panel.again')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The item's issues as a panel beside the pull request's: one block per tracker with each issue's
 * state, why its last write failed and, only then, Sync again. Agentry writes once per event; the
 * second try is this click, never a timer.
 */
export function Issues({ item }: { item: Pick<WorkItemDetail, 'id' | 'issues'> }) {
  const { t } = useTranslation('issues');
  const issues = item.issues ?? [];
  if (issues.length === 0) return null;
  return (
    <>
      {byTracker(issues).map(([tracker, group]) => {
        const words = trackerWords(tracker);
        return (
          <section key={tracker} className="item-wait item-pr-wait iss-panel" aria-label={t('panel.title', { tracker: words.label })}>
            <div className="item-wait-head">
              <CircleDot {...ICON_SM} aria-hidden />
              <span className="item-wait-why">{words.label}</span>
              <span className="count">{group.length}</span>
            </div>
            <p className="small muted item-wait-hint">{t('panel.intro')}</p>
            <div className="addr-list">
              {group.map((issue) => (
                <IssueRow key={issue.key} item={item} issue={issue} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
