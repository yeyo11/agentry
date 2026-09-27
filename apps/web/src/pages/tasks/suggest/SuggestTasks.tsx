import type { AssistantRunDetail, AssistantWorkItemProposal, Project } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Plus, RefreshCw, Search, Sparkle, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useAssistantRun, useAssistantRuns } from '../../../api';
import { AssistantMark, LiveRunHead, ProposedWorkItemMeta, RunFacts, RunSources, SuggestionWait } from '../../../components/assistant/run';
import { Checkbox } from '../../../components/controls';
import { Dialog } from '../../../components/Dialog';
import { ICON_SM, WorkItemKey } from '../../../components/icons';
import { useToast } from '../../../components/Toast';
import { ErrorBox, Skeleton } from '../../../components/ui';
import { NARROW, useMediaQuery } from '../../../lib/media';
import { localized } from '../../../lib/server-strings';
import { taskPath } from '../../../lib/work-items';
import { FullScreen } from '../FullScreen';
import { initialSelection, isRunning, readPhrases, selectedPending, workItemProposals, type SourcePhrase } from './model';

/**
 * "Suggest tasks" on the board: a `work-items` run of the project assistant, a CLI chat that reads
 * the project read-only and answers through `--json-schema`. Its proposals are created one by one
 * (decision 36): the ones the person leaves selected are accepted each on its own, in Backlog, and
 * nothing is written before. A dialog on a desktop, a full screen on a phone; closing it leaves the
 * run going, and opening it again shows the same run.
 */
export function SuggestTasks({ project, onClose }: { project: Pick<Project, 'id' | 'name'>; onClose: () => void }) {
  const { t } = useTranslation('tasks');
  const phone = useMediaQuery(NARROW);
  const toast = useToast();
  const queryClient = useQueryClient();

  const runs = useAssistantRuns(project.id, 'work-items');
  const latest = runs.data?.[0] ?? null;
  const detail = useAssistantRun(latest?.id ?? null);
  const run: AssistantRunDetail | null = detail.data && detail.data.id === latest?.id ? detail.data : null;
  const running = isRunning(latest);
  const proposals = useMemo(() => workItemProposals(run?.proposals), [run?.proposals]);

  const [focus, setFocus] = useState('');
  const [focusFor, setFocusFor] = useState<string | null>(null);
  // The field says what the latest run looked for, until the person types something else
  useEffect(() => {
    if (latest && focusFor !== latest.id) {
      setFocus(latest.description ?? '');
      setFocusFor(latest.id);
    }
  }, [latest, focusFor]);

  // The selection starts once per finished run: a proposal decided later does not reset it
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionFor, setSelectionFor] = useState<string | null>(null);
  useEffect(() => {
    if (run && run.status === 'completed' && selectionFor !== run.id) {
      setSelected(initialSelection(workItemProposals(run.proposals)));
      setSelectionFor(run.id);
    }
  }, [run, selectionFor]);
  const toggle = (id: string, on: boolean) =>
    setSelected((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const refresh = (runId: string) => {
    void queryClient.invalidateQueries({ queryKey: keys.assistantRun(runId) });
    void queryClient.invalidateQueries({ queryKey: keys.assistantRunsOf(project.id) });
  };

  const start = useMutation({
    mutationFn: () =>
      api.startAssistantRun(project.id, {
        kind: 'work-items',
        ...(focus.trim() ? { description: focus.trim() } : {}),
        // "Suggest again" sets the previous run's pending proposals aside; the first run has none
        ...(latest ? { supersede: true } : {}),
      }),
    onSuccess: (started) => {
      queryClient.setQueryData(keys.assistantRun(started.id), started);
      setFocusFor(started.id);
      refresh(started.id);
    },
    onError: (err) => toast.error(t('suggest.startFailed'), err),
  });
  const stop = useMutation({
    mutationFn: (runId: string) => api.stopAssistantRun(runId),
    onSuccess: (stopped) => refresh(stopped.id),
    onError: (err) => toast.error(t('suggest.stopFailed'), err),
  });
  const decide = useMutation({
    mutationFn: ({ proposal, action }: { proposal: AssistantWorkItemProposal; action: 'discard' | 'restore' }) =>
      action === 'discard' ? api.discardAssistantProposal(proposal.id) : api.restoreAssistantProposal(proposal.id),
    onSuccess: (_answer, { proposal }) => refresh(proposal.runId),
    onError: (err) => toast.error(t('suggest.decideFailed'), err),
  });
  // One accept per proposal, in the order they were proposed: decision 36 has no bulk accept, and
  // one that fails leaves the others created
  const create = useMutation({
    mutationFn: async (chosen: AssistantWorkItemProposal[]) => {
      let created = 0;
      for (const proposal of chosen) {
        try {
          await api.acceptAssistantProposal(proposal.id);
          created += 1;
        } catch (err) {
          toast.error(t('suggest.createFailed', { title: proposal.workItem.title }), err);
        }
      }
      return created;
    },
    onSuccess: (created) => {
      if (run) refresh(run.id);
      if (created > 0) toast.success(t('suggest.created', { count: created }));
    },
  });

  const chosen = selectedPending(proposals, selected);
  const pending = proposals.filter((p) => p.status === 'pending');
  const busy = start.isPending || running;
  const canCreate = !busy && chosen.length > 0 && !create.isPending;

  // ---- the parts both sizes share ----
  const focusField = (
    <div className="suggest-focus">
      <label className="search-field suggest-focus-field">
        <Search {...ICON_SM} />
        <input
          value={focus}
          placeholder={t('suggest.focusPlaceholder')}
          aria-label={t('suggest.focus')}
          disabled={busy}
          onChange={(e) => setFocus(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && start.mutate()}
          data-autofocus={latest ? undefined : true}
        />
      </label>
      {!running && (
        <button
          type="button"
          className={`btn suggest-again ${latest ? '' : 'btn-primary'}`.trim()}
          aria-label={phone ? (latest ? t('suggest.again') : t('suggest.start')) : undefined}
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          {latest ? <RefreshCw {...ICON_SM} /> : <Sparkle {...ICON_SM} />}
          {!phone && (latest ? t('suggest.again') : t('suggest.start'))}
        </button>
      )}
    </div>
  );

  let body: ReactNode;
  if (runs.error) body = <ErrorBox error={runs.error} />;
  else if (runs.isLoading || (latest && !run)) body = <Skeleton rows={4} height={18} />;
  else if (!latest || !run) body = <SuggestionWait>{t('suggest.first')}</SuggestionWait>;
  else if (running)
    body = (
      <>
        <section className="suggestion-run is-live live-energy" aria-label={t('suggest.running')}>
          <LiveRunHead run={run} title={t('suggest.running')} />
          <RunFacts run={run} showSchema={!phone} />
          <RunSources sources={run.sources} />
        </section>
        {phone && <span className="section-label">{t('suggest.proposals')}</span>}
        <SuggestionWait>{phone ? t('suggest.waitingShort') : t('suggest.waiting')}</SuggestionWait>
      </>
    );
  else
    body = (
      <>
        <RunLine run={run} count={proposals.length} phone={phone} />
        {proposals.length > 0 && (
          <div className="card suggest-list">
            {proposals.map((proposal) => (
              <ProposalRow
                key={proposal.id}
                proposal={proposal}
                phone={phone}
                selected={selected.has(proposal.id)}
                onToggle={(on) => toggle(proposal.id, on)}
                onDecide={(action) => decide.mutate({ proposal, action })}
                deciding={decide.isPending && decide.variables.proposal.id === proposal.id}
              />
            ))}
          </div>
        )}
      </>
    );

  const hint = running
    ? phone
      ? t('suggest.phoneHint')
      : t('suggest.closeHint')
    : proposals.some((p) => p.workItem.similarTo && p.status === 'pending')
      ? t('suggest.likeHint')
      : null;

  const count = running || !run ? (
    <span className="suggest-count muted">{t('suggest.noneYet')}</span>
  ) : (
    <span className="suggest-count">
      <b className="tabular">{chosen.length}</b> <span className="muted">{t('suggest.selectedOf', { total: pending.length })}</span>
    </span>
  );
  const stopButton = latest && running && (
    <button type="button" className="btn suggest-stop" disabled={stop.isPending} onClick={() => stop.mutate(latest.id)}>
      <X {...ICON_SM} />
      {t('suggest.stop')}
    </button>
  );
  const createButton = (
    <button type="button" className="btn btn-primary suggest-create" disabled={!canCreate} onClick={() => create.mutate(chosen)}>
      <Plus {...ICON_SM} />
      {phone && chosen.length > 0 && !busy ? t('suggest.createCount', { count: chosen.length }) : t('suggest.create')}
    </button>
  );

  if (phone)
    return (
      <FullScreen
        title={t('suggest.title')}
        onClose={onClose}
        footer={
          <div className="suggest-mfoot">
            {stopButton}
            {createButton}
          </div>
        }
      >
        <div className="suggest-body is-phone">
          {focusField}
          {body}
          {hint && <p className="form-hint">{hint}</p>}
        </div>
      </FullScreen>
    );

  return (
    <Dialog
      width={780}
      onClose={onClose}
      title={
        <span className="suggest-dialog-title">
          <AssistantMark small />
          <span className="grow">{t('suggest.title')}</span>
          <span className="mono small muted">{t('suggest.where', { project: project.name })}</span>
        </span>
      }
      footer={
        <>
          {count}
          <span className="grow" />
          {running ? (
            stopButton
          ) : (
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              {t('suggest.cancel')}
            </button>
          )}
          {createButton}
        </>
      }
    >
      <div className="suggest-body">
        {focusField}
        {body}
        {hint && <p className="form-hint">{hint}</p>}
      </div>
    </Dialog>
  );
}

/** A finished run in one still line: what it produced, from what, and its facts; or why it produced nothing. */
function RunLine({ run, count, phone }: { run: AssistantRunDetail; count: number; phone: boolean }) {
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
function ProposalRow({
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
