import type { AssistantRunDetail, AssistantWorkItemProposal } from '@agentry/shared';
import { AlertTriangle, Check, Plus, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ProposedWorkItemMeta, RunFacts } from '../../../components/assistant/run';
import { Checkbox } from '../../../components/controls';
import { ICON_SM, WorkItemKey } from '../../../components/icons';
import { localized } from '../../../lib/server-strings';
import { taskPath } from '../../../lib/work-items';
import { readPhrases, type SourcePhrase } from './model';

/** A finished run in one still line: what it produced, from what, and its facts; or why it produced nothing. */
export function RunLine({ run, count, phone }: { run: AssistantRunDetail; count: number; phone: boolean }) {
  const { t, i18n } = useTranslation('tasks');
  const phrase = (p: SourcePhrase): string =>
    p.key === 'path' ? p.path : p.key === 'commits' ? t('suggest.source.commits', { count: p.count }) : t(`suggest.source.${p.key}`);
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(readPhrases(run.sources).map(phrase));

  if (run.status === 'failed' || run.status === 'stopped' || count === 0) {
    const failed = run.status === 'failed';
    const words = failed
      ? run.error
        ? localized(run.error)
        : t('suggest.failed')
      : run.status === 'stopped'
        ? t('suggest.stopped')
        : run.empty
          ? t('suggest.emptyProject')
          : t('suggest.nothing');
    return (
      <section className={`suggestion-run is-done suggest-line ${failed ? 'is-failed' : ''}`.trim()} aria-label={t('suggest.result')}>
        {failed ? <AlertTriangle {...ICON_SM} className="text-err" /> : <Check {...ICON_SM} />}
        <span className="suggest-line-text">
          {failed && <b>{t('suggest.failedTitle')} </b>}
          <span className="muted">{words}</span>
        </span>
        <RunFacts run={run} />
      </section>
    );
  }
  return (
    <section className={`suggestion-run is-done suggest-line ${phone ? 'is-phone' : ''}`.trim()} aria-label={t('suggest.result')}>
      <Check {...ICON_SM} />
      <span className="suggest-line-text">
        <b>{t('suggest.proposalCount', { count })}</b>{' '}
        <span className="muted">{phone ? `· ${t('suggest.inBacklog')}` : list && t('suggest.from', { sources: list })}</span>
      </span>
      <RunFacts run={run} />
    </section>
  );
}

/**
 * One proposal and its reason. Pending: a checkbox on a desktop, an "Include" button on a phone
 * (no checkboxes there), and "Discard". Accepted: the item it became. Discarded: struck through,
 * with "Undo".
 */
export function ProposalRow({
  proposal,
  phone,
  selected,
  onToggle,
  onDecide,
  deciding,
}: {
  proposal: AssistantWorkItemProposal;
  phone: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onDecide: (action: 'discard' | 'restore') => void;
  deciding: boolean;
}) {
  const { t } = useTranslation('tasks');
  const { workItem } = proposal;
  const state = proposal.status === 'accepted' ? 'is-accepted' : proposal.status === 'discarded' ? 'is-discarded' : '';

  const done =
    proposal.status === 'accepted' ? (
      <span className="suggestion-done">
        <Check {...ICON_SM} />
        {proposal.created ? (
          <Link to={taskPath(proposal.created.key)}>
            {t('suggest.createdAs')} · <WorkItemKey value={proposal.created.key} />
          </Link>
        ) : (
          t('suggest.createdAs')
        )}
      </span>
    ) : proposal.status === 'discarded' ? (
      <button type="button" className="btn btn-quiet btn-small" disabled={deciding} onClick={() => onDecide('restore')}>
        <Undo2 {...ICON_SM} />
        {t('suggest.undo')}
      </button>
    ) : null;

  const main = (
    <div className="suggestion-main">
      <span className="suggestion-title">{workItem.title}</span>
      {proposal.status !== 'discarded' && <ProposedWorkItemMeta item={workItem} />}
      {proposal.status === 'pending' && proposal.reason && <p className="suggestion-reason">{proposal.reason}</p>}
    </div>
  );

  if (phone)
    return (
      <div className={`suggestion-card ${state}`.trim()}>
        {main}
        <div className="suggestion-acts">
          {proposal.status === 'pending' ? (
            <>
              <button type="button" className="btn suggestion-pick" aria-pressed={selected} onClick={() => onToggle(!selected)}>
                {selected ? <Check {...ICON_SM} /> : <Plus {...ICON_SM} />}
                {selected ? t('suggest.included') : t('suggest.include')}
              </button>
              <button type="button" className="btn btn-quiet suggest-discard" disabled={deciding} onClick={() => onDecide('discard')}>
                {t('suggest.discard')}
              </button>
            </>
          ) : (
            done
          )}
        </div>
      </div>
    );

  return (
    <div className={`suggestion-row ${state}`.trim()}>
      {proposal.status === 'pending' ? (
        <Checkbox className="suggest-check" checked={selected} onChange={onToggle} aria-label={t('suggest.includeTitle', { title: workItem.title })} />
      ) : (
        <span className="suggest-check-slot" aria-hidden />
      )}
      {main}
      <div className="suggestion-acts">
        {proposal.status === 'pending' ? (
          <button
            type="button"
            className="btn btn-quiet btn-small suggest-discard"
            aria-label={t('suggest.discardTitle', { title: workItem.title })}
            disabled={deciding}
            onClick={() => onDecide('discard')}
          >
            <X {...ICON_SM} />
            {t('suggest.discard')}
          </button>
        ) : (
          done
        )}
      </div>
    </div>
  );
}
