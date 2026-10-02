import type { MergeBlocker, MergeBlockerAction, MergeMethod, MergeState, Orchestration, OrchestrationPullRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ExternalLink, GitMerge, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, ApiRequestError, keys, useMergeState, type ChangeRequestFixResult } from '../api';
import { Checkbox } from '@agentry/ui/components/controls';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox, Segmented } from '@agentry/ui/components/ui';
import { formatDateTime } from '@agentry/ui/lib/format';
import { checksActions } from '../lib/change-requests';
import {
  actionLabelKey,
  armBody,
  blockerSentence,
  blockersOf,
  chosenMethod,
  hasMergeWarning,
  isArmed,
  isWaitingForPipeline,
  mergeBody,
  mergeFailure,
  mergePrimary,
  methodHasMessage,
  updateFailure,
  type MergeTone,
} from '../lib/merge';
import { checksShown, orchestrationFix } from '../lib/orchestration-v2';
import { addressable } from '../lib/reviews';
import { leadingAction, type LeadingAction } from '../pages/tasks/item/model';
import { MergeNotices } from './MergeNotices';

const MERGE_TONE_BADGE: Record<MergeTone, string> = { ok: 'badge-ok', warn: 'badge-warn', bad: 'badge-bad', idle: 'badge-idle', live: 'badge-active' };

/** The `merge` namespace is the item page's: both blocks word a blocker and a refusal from it, so one blocker reads the same on both. */
type MergeWords = (key: string, values?: Record<string, string | number>) => string;

/** Remedies that act through Agentry; every other action is a place on the host, which is where the person does it. */
const MERGE_CALLS: ReadonlySet<MergeBlockerAction> = new Set<MergeBlockerAction>(['mark-ready', 'update-from-base', 'rebase-on-host', 'auto-merge', 'refresh', 'fix-checks', 'rerun-checks', 'address-review']);

/**
 * The zone's one gradient action of an orchestration's open change request: a fix that waits for
 * its push, then Fix failing checks, then Merge (or Turn on auto-merge while the required checks
 * run). The page's Relaunch and the cost figure give way while one leads, as the item page's Work on
 * it does, so a screen never has more gradient surfaces than the reference draws.
 */
export function useOrchestrationLead(pr: OrchestrationPullRequest | null | undefined): LeadingAction | null {
  const open = checksShown(pr) ? pr.id : undefined;
  const merge = useMergeState(open).data;
  const checks = useQuery({ queryKey: keys.changeRequestChecks(open ?? ''), queryFn: ({ signal }) => api.changeRequestChecks(open ?? '', false, { signal }), enabled: !!open }).data;
  if (!open || !pr) return null;
  return leadingAction({
    pushWaiting: orchestrationFix(pr) === 'push',
    publishWaiting: false,
    replyWaiting: false,
    drafts: 0,
    fixOffered: checksActions(checks, { fixState: pr.fixState ?? null }).fix,
    mergeOffered: mergePrimary(merge) !== null,
  });
}

/**
 * Which of the page head's two gradient surfaces stay lit. With the top bar's New chat, a screen
 * has two: while a zone action leads it takes the second, and without one Relaunch or, when there
 * is none to offer, the cost figure takes it.
 */
export function headGradients(facts: { live: boolean; relaunch: boolean; lead: LeadingAction | null }): { relaunchLit: boolean; costLit: boolean } {
  const relaunchLit = facts.lead === null && !facts.live && facts.relaunch;
  return { relaunchLit, costLit: facts.lead === null && !relaunchLit };
}

/**
 * Merging the orchestration's change request from Agentry: the repository's methods, the branch
 * box, the commit message of a squash and Merge, which stays the person's click. What blocks it is
 * named with a word and its remedy; the host's own text is rendered as text, never as markup.
 */
export function OrchestrationMerge({ orch, pr, words }: { orch: Orchestration; pr: OrchestrationPullRequest; words: { noun: string; host: string; ref: (n: number | null, ref?: string | null) => string } }) {
  const { t } = useTranslation('orchestrationDetail');
  const { t: tv } = useTranslation('orchestrationV2');
  const { t: tm } = useTranslation() as unknown as { t: MergeWords };
  const mw: MergeWords = (key, values) => tm(`merge:${key}`, values);
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = pr.id ?? '';
  const merge = useMergeState(id, pr.phase === 'open');
  const lead = useOrchestrationLead(pr);
  const state = merge.data;
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<boolean | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState<{ text: string; detail?: string } | null>(null);

  const keep = (next: MergeState) => queryClient.setQueryData(keys.changeRequestMerge(id), next);
  const detailOf = (error: unknown) => (error instanceof ApiRequestError ? error.detail : undefined) ?? (error instanceof Error ? error.message : undefined);
  // Every refusal reads the state again: a head that moved or a rule that changed merges nothing, and GitLab's 405 never says why, so the reason comes from the re-read
  const reread = () => void queryClient.invalidateQueries({ queryKey: keys.changeRequestMerge(id) });
  const fail = (error: unknown) => {
    const reason = mergeFailure(error instanceof ApiRequestError ? error.code : undefined);
    setFailure({ text: mw(`failure.${reason}`, { noun: words.noun, host: words.host }), detail: detailOf(error) });
    reread();
  };
  const failUpdate = (error: unknown) => {
    const reason = updateFailure(error instanceof ApiRequestError ? error : null);
    const text = reason === 'conflicts' ? mw('toast.conflicts', { head: pr.branch, base: pr.base }) : mw(`update.${reason}`, { noun: words.noun, host: words.host, base: pr.base });
    setFailure({ text, detail: detailOf(error) });
    reread();
  };
  const settled = () => {
    void queryClient.invalidateQueries({ queryKey: keys.orchestration(orch.id) });
    void queryClient.invalidateQueries({ queryKey: keys.changeRequest(id) });
  };
  // An agent on it, or the prompt for a chat of the person's own when the project's flow is off
  const fixed = (res: ChangeRequestFixResult) => {
    if (res.started) toast.success(mw('toast.fixStarted'));
    else toast.info(tv('checks.fixPrompt'), res.prompt);
  };

  const doMerge = useMutation({
    mutationFn: (body: NonNullable<ReturnType<typeof mergeBody>>) => api.mergeChangeRequest(id, body),
    onMutate: () => setFailure(null),
    onSuccess: (res) => {
      keep(res.state);
      toast.success(t('merge.merged', { noun: words.noun }));
      settled();
    },
    onError: fail,
  });
  const call = useMutation({
    mutationFn: async (action: MergeBlockerAction): Promise<MergeState | null> => {
      if (!state) return null;
      switch (action) {
        case 'mark-ready':
          return api.markReady(id, { ready: true });
        case 'auto-merge': {
          const body = armBody(state, method);
          return body ? api.armAutoMerge(id, body) : null;
        }
        case 'update-from-base':
        case 'rebase-on-host':
          return (await api.updateBranch(id)).state;
        case 'fix-checks':
          fixed(await api.fixChecks(id));
          return null;
        case 'address-review': {
          const threads = await api.changeRequestThreads(id);
          fixed(await api.addressReview(id, { threadIds: addressable(threads.threads).map((thread) => thread.id) }));
          return null;
        }
        case 'rerun-checks':
          await api.rerunChecks(id, { scope: 'all' });
          return api.mergeState(id, true);
        default:
          return api.mergeState(id, true);
      }
    },
    onMutate: () => setFailure(null),
    onSuccess: (next) => {
      if (next) keep(next);
      settled();
    },
    onError: (error, action) => (action === 'update-from-base' || action === 'rebase-on-host' ? failUpdate(error) : fail(error)),
  });
  const disarm = useMutation({
    mutationFn: () => api.disarmAutoMerge(id),
    onMutate: () => setFailure(null),
    onSuccess: (next) => {
      keep(next);
      settled();
    },
    onError: fail,
  });

  if (!id || pr.phase !== 'open') return null;
  const ref = words.ref(pr.number, pr.ref);
  const label = ref ? `${words.noun} ${ref}` : words.noun;
  const busy = doMerge.isPending || call.isPending || disarm.isPending;
  const chosen = state ? chosenMethod(state, method) : null;
  const removeBranch = deleteBranch ?? state?.deleteBranchDefault ?? false;
  const body = state ? mergeBody(state, { method: chosen, deleteBranch: removeBranch, subject, body: message }) : null;
  const blockers = state ? blockersOf(state) : [];
  const first = state?.blocker ?? null;
  const sentenceOf = (blocker: MergeBlocker) => blockerSentence(blocker, { host: pr.host ?? 'github', branch: pr.branch, base: pr.base, phase: pr.phase }, words.noun);
  const mark = first ? sentenceOf(first) : null;
  // Turn on auto-merge leads while the required checks run; Merge leads when it can merge. Anything else is a plain button
  const leadArm = lead === 'merge' && !!state && !state.canMerge;
  const leadMerge = lead === 'merge' && !!state?.canMerge;

  /** A remedy: an Agentry call, or the place on the host where the person does it. */
  const remedy = (blocker: MergeBlocker): ReactNode => {
    const action = blocker.action;
    if (!action) return null;
    const text = mw(actionLabelKey(action), { host: words.host, base: pr.base, noun: words.noun });
    if (MERGE_CALLS.has(action)) {
      return (
        <button
          type="button"
          className={`btn btn-small ${action === 'auto-merge' && leadArm ? 'btn-primary' : ''}`.trim()}
          disabled={busy || (action === 'auto-merge' && (!state || !armBody(state, method)))}
          onClick={() => call.mutate(action)}
        >
          {call.isPending && call.variables === action && <Spinner variant="ring" />}
          {text}
        </button>
      );
    }
    // Closing, editing the title, asking for a review and the threads have no call of their own: the host's page does them
    if (!pr.url) return null;
    return (
      <a className="btn btn-small" href={pr.url} target="_blank" rel="noreferrer">
        {action === 'edit-title' ? <Pencil {...ICON_SM} /> : action === 'close' ? <Ban {...ICON_SM} /> : <ExternalLink {...ICON_SM} />} {text}
      </a>
    );
  };

  const auto = state?.autoMerge ?? null;

  return (
    <section className="omrg" aria-label={t('merge.title')}>
      <div className="omrg-head">
        <h3 className="section-label grow">{t('merge.title')}</h3>
        {state?.canMerge && <span className="mono small muted">{t('merge.ready')}</span>}
      </div>
      {merge.isLoading && <p className="muted small">{t('merge.reading', { host: words.host })}</p>}
      {merge.isError && <ErrorBox error={merge.error} />}
      {state && auto && (
        <>
          <MergeNotices state={state} host={words.host} />
          {isArmed(state) && (
            <div className="omrg-armed">
              <span className="badge badge-idle">{t('merge.armed')}</span>
              <span className="small">
                {auto.armedBy
                  ? t('merge.armedBy', { method: auto.method ? t(`merge.method.${auto.method}`) : t('merge.methodUnknown'), who: auto.armedBy })
                  : t('merge.armedByUnknown', { method: auto.method ? t(`merge.method.${auto.method}`) : t('merge.methodUnknown'), host: words.host })}
                {auto.armedAt && <span className="mono muted"> · {formatDateTime(auto.armedAt)}</span>}
              </span>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => disarm.mutate()}>
                {t('merge.turnOff')}
              </button>
            </div>
          )}
          {first && mark && (
            <div className="omrg-blocked" data-reason={first.code}>
              <span className={`badge ${MERGE_TONE_BADGE[mark.tone]}`}>
                {mark.tone === 'live' && <Spinner />}
                {mw(mark.word, mark.params)}
              </span>
              <span className="small omrg-text">{mw(mark.text, mark.params)}</span>
              {remedy(first)}
            </div>
          )}
          {first?.code === 'checks-running' && auto.reason === 'auto-merge-not-allowed' && <p className="small muted">{mw('failure.auto-merge-not-allowed')}</p>}
          {isWaitingForPipeline(state) && (
            <p className="small omrg-text">
              <Spinner /> {t('merge.waitingForPipeline', { host: words.host })}
            </p>
          )}
          {blockers.length > 1 && (
            <p className="mono small muted">
              {t('merge.others', {
                words: blockers
                  .slice(1)
                  .map((b) => {
                    const m = sentenceOf(b);
                    return mw(m.word, m.params);
                  })
                  .join(' · '),
              })}
            </p>
          )}
          {hasMergeWarning(state) && <div className="alert alert-warn small">{t('merge.optionalChecksFailing')}</div>}
          {state.methods.length > 0 && !isArmed(state) && (
            <div className="omrg-opts">
              <div className="col omrg-col">
                <span className="section-label">{t('merge.method.label')}</span>
                <Segmented
                  value={chosen ?? state.methods[0]!}
                  label={t('merge.method.group')}
                  options={state.methods.map((m) => ({ value: m, label: t(`merge.method.${m}`) }))}
                  onChange={setMethod}
                  disabled={busy}
                />
                <span className="small muted">{t('merge.methodHint', { base: pr.base, methods: state.methods.map((m) => t(`merge.method.${m}`)).join(', ') })}</span>
                <Checkbox className="omrg-row" checked={removeBranch} onChange={setDeleteBranch} disabled={busy}>
                  <span>
                    <Trans t={t} i18nKey="merge.deleteBranch" values={{ branch: pr.branch, host: words.host }} components={{ mono: <span className="mono" /> }} />
                  </span>
                </Checkbox>
              </div>
              {chosen && methodHasMessage(chosen) && (
                <div className="col omrg-col">
                  <span className="section-label">{t('merge.message')}</span>
                  <label className="field">
                    <input type="text" className="mono" value={subject} aria-label={t('merge.subject')} placeholder={t('merge.subjectPlaceholder')} onChange={(e) => setSubject(e.target.value)} />
                  </label>
                  <label className="field field-area">
                    <textarea rows={3} value={message} aria-label={t('merge.body')} placeholder={t('merge.bodyPlaceholder')} onChange={(e) => setMessage(e.target.value)} />
                  </label>
                </div>
              )}
            </div>
          )}
          {!isArmed(state) && (
            <div className="omrg-foot">
              {state.canMerge && state.headSha && <span className="small muted omrg-guard">{t('merge.guard', { head: state.headSha.slice(0, 8) })}</span>}
              <span className="grow" />
              <button type="button" className={`btn ${leadMerge ? 'btn-primary' : ''}`.trim()} disabled={busy || !body || !state.canMerge} onClick={() => body && doMerge.mutate(body)}>
                <GitMerge {...ICON_SM} /> {doMerge.isPending ? t('merge.merging') : t('merge.action', { label })}
              </button>
            </div>
          )}
          {failure && (
            <div className="alert alert-warn small" role="alert" title={failure.detail || undefined}>
              {failure.text}
              {failure.detail && <span className="mono muted"> · {failure.detail}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
