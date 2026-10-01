import type { AssistantRunDetail, AssistantWorkItemProposal, Project } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Search, Sparkle, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useAssistantRun, useAssistantRuns, useProjectSettings } from '../../../api';
import { AssistantMark, LiveRunHead, RunFacts, RunSources, SuggestionWait } from '../../../components/assistant/run';
import { Dialog } from '@agentry/ui/components/Dialog';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox, Skeleton } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { backlogRunsFor } from '../../team/model';
import { useRoleName } from '../../team/RoleAvatar';
import { FullScreen } from '../FullScreen';
import { initialSelection, isRunning, latestFocus, selectedPending, suggestRequest, workItemProposals } from './model';
import { ProposalRow, RunLine } from './Results';

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
  const settings = useProjectSettings(project.id);
  const roleName = useRoleName();

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
      setFocus(latestFocus(latest));
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
      api.startAssistantRun(project.id, suggestRequest(focus, latest !== null)),
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
  // Each card created in Backlog sets the flow off on it: say so before the person queues eight runs
  const backlogRuns = busy ? null : backlogRunsFor(settings.data, chosen.map((p) => p.workItem.type));

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

  const flowNote = backlogRuns && (
    <p className="form-hint suggest-flow-note">
      {t('suggest.flowRuns', { count: backlogRuns.count, role: roleName(backlogRuns.role), parallel: backlogRuns.parallel })}
    </p>
  );

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
          {flowNote}
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
        {flowNote}
      </div>
    </Dialog>
  );
}
