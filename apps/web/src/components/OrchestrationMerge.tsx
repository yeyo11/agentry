import type { MergeBlockerAction, MergeMethod, MergeState, Orchestration, OrchestrationPullRequest } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitMerge } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, ApiRequestError, keys, useMergeState } from '../api';
import { Checkbox } from '@agentry/ui/components/controls';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox, Segmented } from '@agentry/ui/components/ui';
import { formatDateTime } from '@agentry/ui/lib/format';
import {
  actionLabelKey,
  armBody,
  blockerActionKind,
  blockerMark,
  blockerParams,
  blockersOf,
  chosenMethod,
  hasMergeWarning,
  isArmed,
  isWaitingForPipeline,
  mergeBody,
  mergeFailure,
  methodHasMessage,
  needsReread,
  type MergeTone,
} from '../lib/merge';

const MERGE_TONE_BADGE: Record<MergeTone, string> = { ok: 'badge-ok', warn: 'badge-warn', bad: 'badge-bad', idle: 'badge-idle', live: 'badge-active' };

/** The `merge` namespace is the item page's: both blocks word a blocker and a refusal from it, so one blocker reads the same on both. */
type MergeWords = (key: string, values?: Record<string, string>) => string;

type MergeCall = Extract<MergeBlockerAction, 'mark-ready' | 'update-from-base' | 'rebase-on-host' | 'auto-merge' | 'refresh'>;
const MERGE_CALLS: ReadonlySet<MergeBlockerAction> = new Set<MergeBlockerAction>(['mark-ready', 'update-from-base', 'rebase-on-host', 'auto-merge', 'refresh']);

/**
 * Merging the orchestration's change request from Agentry: the repository's methods, the branch
 * box, the commit message of a squash and Merge, which stays the person's click. What blocks it is
 * named with a word and its remedy; the host's own text is rendered as text, never as markup.
 */
export function OrchestrationMerge({ orch, pr, words }: { orch: Orchestration; pr: OrchestrationPullRequest; words: { noun: string; host: string; ref: (n: number | null, ref?: string | null) => string } }) {
  const { t } = useTranslation('orchestrationDetail');
  const { t: tm } = useTranslation() as unknown as { t: MergeWords };
  const mw: MergeWords = (key, values) => tm(`merge:${key}`, values);
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = pr.id ?? '';
  const merge = useMergeState(id, pr.phase === 'open');
  const state = merge.data;
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<boolean | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState<{ text: string; detail?: string } | null>(null);

  const keep = (next: MergeState) => queryClient.setQueryData(keys.changeRequestMerge(id), next);
  const fail = (error: unknown) => {
    const err = error instanceof ApiRequestError ? error : null;
    const reason = mergeFailure(err?.code);
    setFailure({ text: mw(`failure.${reason}`, { noun: words.noun, host: words.host }), detail: err?.detail ?? (error instanceof Error ? error.message : undefined) });
    // A head that moved or a rule that changed merges nothing: read again before the next click
    if (needsReread(reason)) void queryClient.invalidateQueries({ queryKey: keys.changeRequestMerge(id) });
  };
  const settled = () => {
    void queryClient.invalidateQueries({ queryKey: keys.orchestration(orch.id) });
    void queryClient.invalidateQueries({ queryKey: keys.changeRequest(id) });
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
    mutationFn: async (action: MergeCall): Promise<MergeState | null> => {
      if (!state) return null;
      if (action === 'mark-ready') return api.markReady(id, { ready: true });
      if (action === 'refresh') return api.mergeState(id, true);
      if (action === 'auto-merge') {
        const body = armBody(state, method);
        return body ? api.armAutoMerge(id, body) : null;
      }
      return (await api.updateBranch(id)).state;
    },
    onMutate: () => setFailure(null),
    onSuccess: (next) => {
      if (next) keep(next);
      settled();
    },
    onError: fail,
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
  const mark = first ? blockerMark(first.code) : null;
  const params = first ? blockerParams(first, pr, words.noun) : null;
  const kind = first?.action ? blockerActionKind(first.action) : null;
  const sentence = (key: string, extra?: Record<string, string>) => mw(key, { ...(params ?? {}), host: words.host, noun: words.noun, ...extra });

  return (
    <section className="omrg" aria-label={t('merge.title')}>
      <div className="omrg-head">
        <h3 className="section-label grow">{t('merge.title')}</h3>
        {state?.canMerge && <span className="mono small muted">{t('merge.ready')}</span>}
      </div>
      {merge.isLoading && <p className="muted small">{t('merge.reading', { host: words.host })}</p>}
      {merge.isError && <ErrorBox error={merge.error} />}
      {state && (
        <>
          {isArmed(state) && (
            <div className="omrg-armed">
              <span className="badge badge-idle">{t('merge.armed')}</span>
              <span className="small">
                {t('merge.armedBy', {
                  method: state.autoMerge.method ? t(`merge.method.${state.autoMerge.method}`) : t('merge.methodUnknown'),
                  who: state.autoMerge.armedBy ?? words.host,
                })}
                {state.autoMerge.armedAt && <span className="mono muted"> · {formatDateTime(state.autoMerge.armedAt)}</span>}
              </span>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => disarm.mutate()}>
                {t('merge.turnOff')}
              </button>
            </div>
          )}
          {first && mark && (
            <div className="omrg-blocked">
              <span className={`badge ${MERGE_TONE_BADGE[mark.tone]}`}>
                {mark.tone === 'live' && <Spinner />}
                {sentence(mark.word)}
              </span>
              <span className="small omrg-text">{sentence(mark.text)}</span>
              {first.action && kind === 'call' && MERGE_CALLS.has(first.action) && (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy || (first.action === 'auto-merge' && !armBody(state, method))}
                  onClick={() => call.mutate(first.action as MergeCall)}
                >
                  {sentence(actionLabelKey(first.action))}
                </button>
              )}
              {first.action && (kind === 'link' || kind === 'page') && pr.url && (
                <a className="btn btn-small" href={pr.url} target="_blank" rel="noreferrer">
                  <ExternalLink {...ICON_SM} /> {sentence(actionLabelKey('open-on-host'))}
                </a>
              )}
            </div>
          )}
          {isWaitingForPipeline(state) && (
            <p className="small omrg-text">
              <Spinner /> {t('merge.waitingForPipeline', { host: words.host })}
            </p>
          )}
          {blockers.length > 1 && (
            <p className="mono small muted">{t('merge.others', { words: blockers.slice(1).map((b) => sentence(blockerMark(b.code).word, { name: b.detail ?? '' })).join(' · ') })}</p>
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
              <button type="button" className={`btn ${state.canMerge ? 'btn-primary' : ''}`.trim()} disabled={busy || !body || !state.canMerge} onClick={() => body && doMerge.mutate(body)}>
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

