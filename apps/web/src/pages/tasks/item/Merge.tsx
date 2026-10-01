import type { MergeBlocker, MergeBlockerAction, MergeMethod, MergeState, WorkItemPullRequest } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, CircleAlert, Clock, ExternalLink, GitMerge, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ApiRequestError, api, keys, useMergeState, type ChangeRequestFixResult } from '../../../api';
import { Checkbox } from '@agentry/ui/components/controls';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { Segmented } from '@agentry/ui/components/ui';
import { timeAgo } from '@agentry/ui/lib/format';
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
} from '../../../lib/merge';
import { addressable } from '../../../lib/reviews';
import { useChangeRequestWords } from '../board/PullRequest';
import { useFixOffered } from './Checks';
import { useReviewDrafts } from './Review';

const shortSha = (sha: string | null | undefined): string => (sha ?? '').slice(0, 7);

/** The change request's id while it is open and the host numbered it: what the merge routes take. */
const openId = (pr: WorkItemPullRequest | null | undefined): string | undefined => (pr?.phase === 'open' && pr.number !== null ? pr.id : undefined);

const toneBadge = (tone: MergeTone): string => (tone === 'live' ? 'badge badge-active' : tone === 'ok' ? 'badge badge-ok' : `badge badge-${tone}`);

/** The one thing the block offers as its action, when there is one: a merge, or arming auto-merge. */
export function mergePrimary(state: MergeState | undefined): 'merge' | 'arm' | null {
  if (!state || isArmed(state)) return null;
  if (state.canMerge) return 'merge';
  return state.autoMerge.available ? 'arm' : null;
}

/**
 * Whether the merge block carries the zone's gradient: it does unless the person has a draft review
 * (Submit review leads) or Fix failing checks is on the page. The header's "Work on it" gives its
 * gradient up while it does, because a screen has two gradient surfaces at most.
 */
export function useMergeLeads(pr: WorkItemPullRequest | null | undefined): boolean {
  const state = useMergeState(openId(pr)).data;
  const fix = useFixOffered(pr);
  const drafts = useReviewDrafts(pr).data?.length ?? 0;
  return mergePrimary(state) !== null && !fix && drafts === 0;
}

/** Scrolls to the review block, where the person asks for reviewers. */
const showReview = () => document.querySelector('.rv')?.scrollIntoView({ block: 'start', behavior: 'smooth' });

/**
 * The merge block of the item's open pull request or merge request, under the review block: the
 * method the repository allows, the commit message, the branch box and Merge; Auto-merge and its
 * Turn off; why a merge is blocked, with the one remedy; GitLab waiting for the pipeline; and a
 * head that moved. Merging is the person's click, carrying the head they saw. Host text is drawn as
 * text. Reference: DesktopTareaFusion, DesktopTareaFusionEstados and DSFusion.
 */
export function Merge({ pr, itemId, itemKey }: { pr: WorkItemPullRequest | null | undefined; itemId: string; itemKey: string }) {
  const { t } = useTranslation('merge');
  const { t: tw } = useTranslation('workItem');
  const words = useChangeRequestWords(pr?.host);
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const id = openId(pr);
  const query = useMergeState(id);
  const fixOffered = useFixOffered(pr);
  const draftNotes = useReviewDrafts(pr).data?.length ?? 0;
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<boolean | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // The head the person looked at when the host refused a merge because it had moved
  const [moved, setMoved] = useState<string | null>(null);

  const state = query.data;
  const settle = () => {
    if (!id) return;
    void qc.invalidateQueries({ queryKey: keys.workItem(itemId) });
    void qc.invalidateQueries({ queryKey: keys.workItems });
    void qc.invalidateQueries({ queryKey: keys.changeRequestMerge(id) });
  };
  const written = (next: MergeState) => {
    if (id) qc.setQueryData(keys.changeRequestMerge(id), next);
    settle();
  };
  const failed = (error: unknown) => {
    const reason = mergeFailure(error instanceof ApiRequestError ? error.code : undefined);
    toast.error(t(`failure.${reason}`, { host: words.host }), error);
    if (needsReread(reason) && id) void qc.invalidateQueries({ queryKey: keys.changeRequestMerge(id) });
    else settle();
    return reason;
  };

  const merge = useMutation({
    mutationFn: (req: NonNullable<ReturnType<typeof mergeBody>>) => api.mergeChangeRequest(id ?? '', req),
    onSuccess: (result) => {
      written(result.state);
      toast.success(t('toast.merged', { ref: `${words.noun} ${words.ref(pr?.number ?? null, pr?.ref)}`.trim() }));
    },
    onError: (error, req) => {
      if (failed(error) === 'head-moved') setMoved(req.expectedHead);
    },
  });
  const arm = useMutation({
    mutationFn: (req: NonNullable<ReturnType<typeof armBody>>) => api.armAutoMerge(id ?? '', req),
    onSuccess: (next) => {
      written(next);
      toast.success(t('toast.armed'));
    },
    onError: failed,
  });
  const disarm = useMutation({
    mutationFn: () => api.disarmAutoMerge(id ?? ''),
    onSuccess: (next) => {
      written(next);
      toast.success(t('toast.disarmed'));
    },
    onError: failed,
  });
  const remedy = useMutation({
    mutationFn: async (action: MergeBlockerAction): Promise<{ state?: MergeState; fix?: ChangeRequestFixResult; toast?: string }> => {
      switch (action) {
        case 'mark-ready':
          return { state: await api.markReady(id ?? '', { ready: true }), toast: t('toast.ready') };
        case 'update-from-base':
        case 'rebase-on-host': {
          const result = await api.updateBranch(id ?? '');
          return { state: result.state, toast: t('toast.updated', { head: pr?.branch ?? '', base: pr?.base ?? '' }) };
        }
        case 'auto-merge': {
          const req = armBody(state ?? EMPTY, method);
          if (!req) throw new Error('auto-merge is not on offer');
          return { state: await api.armAutoMerge(id ?? '', req), toast: t('toast.armed') };
        }
        case 'fix-checks':
          return { fix: await api.fixChecks(id ?? ''), toast: t('toast.fixStarted') };
        case 'address-review': {
          const threads = await api.changeRequestThreads(id ?? '');
          return { fix: await api.addressReview(id ?? '', { threadIds: addressable(threads.threads).map((thread) => thread.id) }), toast: t('toast.fixStarted') };
        }
        case 'rerun-checks':
          await api.rerunChecks(id ?? '', { scope: 'all' });
          return { state: await api.mergeState(id ?? '', true) };
        default:
          return { state: await api.mergeState(id ?? '', true) };
      }
    },
    onSuccess: (result) => {
      if (result.state) written(result.state);
      else settle();
      if (result.toast) toast.success(result.toast);
      // A project whose flow is off gets the prompt as a chat of its own, in the item's worktree
      if (result.fix && !result.fix.started)
        navigate(result.fix.worktree ? `/chats/new?cwd=${encodeURIComponent(result.fix.worktree)}` : '/chats/new', { state: { prompt: result.fix.prompt } });
    },
    onError: (error, action) => {
      if ((action === 'update-from-base' || action === 'rebase-on-host') && error instanceof ApiRequestError && error.status === 409) {
        toast.error(t('toast.conflicts', { head: pr?.branch ?? '', base: pr?.base ?? '' }), error);
        settle();
        return;
      }
      toast.error(t('toast.failed'), error);
      settle();
    },
  });

  if (!id || !pr) return null;
  const host = words.host;
  const ref = words.ref(pr.number, pr.ref);
  const sha = shortSha(state?.headSha);
  const busy = merge.isPending || arm.isPending || disarm.isPending || remedy.isPending;

  if (!state) {
    return (
      <section className="mg" aria-label={t('title')} aria-busy={query.isPending}>
        <h2 className="t-h2">{t('title')}</h2>
        {query.isError ? (
          <div className="mb-note is-warn" role="status">
            <CircleAlert {...ICON_SM} aria-hidden />
            <div className="mb-body">
              <span className="mb-text">{t('failed', { host })}</span>
              <div className="mb-acts">
                <button type="button" className="btn btn-small" onClick={() => void query.refetch()}>
                  {t('retry')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="small muted">{t('loading')}</p>
        )}
      </section>
    );
  }

  const chosen = chosenMethod(state, method);
  const params = (blocker: MergeBlocker) => {
    const { noun, host: hostName, head, base, name, state: phase } = blockerParams(blocker, { host: pr.host ?? 'github', branch: pr.branch, base: pr.base, phase: pr.phase }, words.noun);
    const stateWord = phase === 'merged' ? tw('pr.state.merged') : phase === 'closed' ? tw('pr.state.closed') : phase;
    return { noun, host: hostName, head, base, name, state: stateWord };
  };
  const armedState = isArmed(state);
  const waiting = isWaitingForPipeline(state);
  const stateMoved = moved !== null;
  const primaryClass = (lead: boolean) => `btn btn-small ${lead ? 'btn-primary' : ''}`.trim();
  const lead = !fixOffered && draftNotes === 0;

  /** A remedy: an Agentry call, a link to the host, or a move inside the page. */
  const remedyButton = (blocker: MergeBlocker): ReactNode => {
    const action = blocker.action;
    if (!action) return null;
    const label = t(actionLabelKey(action), { host, base: pr.base, noun: words.noun });
    const kind = blockerActionKind(action);
    // Closing and editing the title have no call of their own here: the host's page does both
    if (action === 'close' || action === 'edit-title' || kind === 'link') {
      if (!pr.url) return null;
      return (
        <a className="btn btn-small" href={pr.url} target="_blank" rel="noreferrer">
          {action === 'edit-title' ? <Pencil {...ICON_SM} /> : action === 'close' ? <Ban {...ICON_SM} /> : <ExternalLink {...ICON_SM} />}
          {label}
        </a>
      );
    }
    if (action === 'show-threads')
      return (
        <Link className="btn btn-small" to={`/tasks/${itemKey}/changes`}>
          {label}
        </Link>
      );
    if (action === 'request-reviewers')
      return (
        <button type="button" className="btn btn-small" onClick={showReview}>
          {label}
        </button>
      );
    return (
      <button type="button" className="btn btn-small" disabled={busy || (action === 'auto-merge' && armBody(state, method) === null)} onClick={() => remedy.mutate(action)}>
        {remedy.isPending && remedy.variables === action && <Spinner variant="ring" />}
        {label}
      </button>
    );
  };

  const header = (badge: ReactNode) => (
    <div className="mg-head">
      <span className="mg-title">
        <h2 className="t-h2">{t('title')}</h2>
        <span className="mg-sub">{t('sub', { ref: `${words.noun} ${ref}`.trim(), head: pr.branch, base: pr.base, sha })}</span>
      </span>
      <span className="grow" />
      {badge}
    </div>
  );
  const limited = state.limitedUntil ? (
    <p className="small muted" role="status">
      {t('limited', { host, time: new Date(state.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
    </p>
  ) : null;
  const frame = (badge: ReactNode, content: ReactNode) => (
    <section className="mg" aria-label={t('title')}>
      {header(badge)}
      {limited}
      {content}
    </section>
  );

  // The head moved under the person's click: nothing was merged, and the next one reads again
  if (stateMoved) {
    const now = state.headSha && state.headSha !== moved ? shortSha(state.headSha) : null;
    return frame(
      <span className="badge badge-warn">{t('badge.headMoved')}</span>,
      <div className="rv-card">
        <div className="rv-row">
          <span className="callout callout-warn" role="note" style={{ gridColumn: '1 / -1' }}>
            <CircleAlert {...ICON_SM} aria-hidden />
            <span>
              <b>{t('headMoved.title')}</b> {t('headMoved.text')}
            </span>
          </span>
        </div>
        <div className="rv-row">
          <span className="rv-k rv-label">{t('row.commit')}</span>
          <span className="rv-v">
            <span className="mg-mono">{shortSha(moved)}</span>
            <span className="mg-hint">{t('headMoved.seen')}</span>
          </span>
        </div>
        {now && (
          <div className="rv-row">
            <span className="rv-k rv-label">{t('row.now')}</span>
            <span className="rv-v">
              <span className="mg-mono">{now}</span>
              <span className="mg-hint">{t('headMoved.now')}</span>
            </span>
            <span className="rv-side">
              <Link className="btn btn-ghost btn-small" to={`/tasks/${itemKey}/changes`}>
                {t('headMoved.changes')}
              </Link>
            </span>
          </div>
        )}
        <div className="mg-foot">
          <span className="mg-note" />
          <span className="mg-acts">
            <button type="button" className="btn btn-small" disabled>
              {t('actions.merge')}
            </button>
            <button
              type="button"
              className={primaryClass(lead)}
              onClick={() => {
                setMoved(null);
                void query.refetch();
              }}
            >
              {t('actions.reread')}
            </button>
          </span>
        </div>
      </div>,
    );
  }

  // Auto-merge is armed: who, when and how, what it waits on, and Turn off. It waits on the host, not on an agent.
  if (armedState) {
    const auto = state.autoMerge;
    const methodName = auto.method ? t(`method.${auto.method}`) : null;
    const when = auto.armedAt ? timeAgo(auto.armedAt) : null;
    const who = auto.armedBy && when && methodName ? t('autoMerge.by', { who: auto.armedBy, when, method: methodName }) : when && methodName ? t('autoMerge.byUnknown', { when, method: methodName }) : t('autoMerge.unknown', { host });
    const first = state.blocker;
    return frame(
      <span className="badge badge-idle">{t('badge.armed')}</span>,
      <div className="rv-card">
        <div className="rv-row">
          <span className="rv-k rv-label">{t('row.autoMerge')}</span>
          <span className="rv-v">
            <span className="badge badge-idle">{t('autoMerge.on')}</span>
            <span className="mg-mono">{who}</span>
          </span>
          <span className="rv-side">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => disarm.mutate()}>
              {disarm.isPending && <Spinner variant="ring" />}
              {t('actions.disarm')}
            </button>
          </span>
        </div>
        <div className="rv-row">
          <span className="rv-k rv-label">{t('row.waitsFor')}</span>
          <span className="rv-v">
            {first ? (
              <>
                <span className={toneBadge(blockerMark(first.code).tone)}>{t(blockerMark(first.code).word)}</span>
                <span className="mg-hint">{t(blockerMark(first.code).text, params(first))}</span>
              </>
            ) : (
              <span className="mg-hint">{t('autoMerge.waitsFor', { noun: words.noun })}</span>
            )}
          </span>
        </div>
        <div className="mg-foot">
          <span className="mg-note">{t('note.armed')}</span>
          <span className="mg-acts" />
        </div>
      </div>,
    );
  }

  // GitLab, the head's pipeline has not attached yet: the spinner stands next to the verb and Merge stays off
  if (waiting) {
    return frame(
      <span className="badge badge-active">{t('badge.waitingPipeline')}</span>,
      <div className="rv-card">
        <div className="rv-row">
          <span className="rv-k rv-label">{t('row.pipeline')}</span>
          <span className="rv-v">
            <span className="mg-live" role="status">
              <Spinner />
              <span className="mg-live-text">
                <span>{t('pipeline.waiting')}</span>
                <span className="mg-sub">{t('pipeline.waitingDetail', { sha, host })}</span>
              </span>
            </span>
          </span>
        </div>
        <div className="mg-foot">
          <span className="mg-note">{t('note.pipelineWait')}</span>
          <span className="mg-acts">
            <button type="button" className="btn btn-small" disabled aria-busy="true">
              <Spinner />
              {t('actions.waiting')}
            </button>
          </span>
        </div>
      </div>,
    );
  }

  // Merge is possible: the method, the message, the branch box and the one action
  if (state.canMerge) {
    const message = chosen !== null && methodHasMessage(chosen);
    const deleting = deleteBranch ?? state.deleteBranchDefault;
    const req = mergeBody(state, { method, deleteBranch: deleting, subject, body });
    const warn = hasMergeWarning(state);
    const methodHint = chosen ? t(`method.hint.${chosen}`, { base: pr.base, head: pr.branch }) : null;
    return frame(
      merge.isPending ? (
        <span className="badge badge-active">{t('badge.merging')}</span>
      ) : warn ? (
        <span className="badge badge-warn">{t('badge.warning')}</span>
      ) : (
        <span className="badge badge-ok">
          <Check size={11} strokeWidth={2} aria-hidden />
          {t('badge.ready')}
        </span>
      ),
      <div className="rv-card">
        {chosen && (
          <div className="rv-row">
            <span className="rv-k rv-label">{t('row.method')}</span>
            <span className="rv-v">
              <span className="mg-fields">
                {state.methods.length > 1 ? (
                  <Segmented<MergeMethod>
                    value={chosen}
                    label={t('method.label')}
                    disabled={merge.isPending}
                    options={state.methods.map((value) => ({ value, label: t(`method.${value}`) }))}
                    onChange={setMethod}
                  />
                ) : (
                  <span className="rv-v">
                    <span className="badge">{t(`method.${chosen}`)}</span>
                    <span className="mg-hint">{t('method.fixed', { host })}</span>
                  </span>
                )}
                {methodHint && <span className="mg-hint">{methodHint}</span>}
              </span>
            </span>
          </div>
        )}
        {message && (
          <div className="rv-row">
            <span className="rv-k rv-label">{t('row.message')}</span>
            <span className="rv-v">
              <span className="mg-fields">
                <label className="mg-field">
                  <span className="t-label">{t('message.subject')}</span>
                  <input className="mono" value={subject} placeholder={t('message.hostWrites', { host })} aria-label={t('message.subjectLabel')} disabled={merge.isPending} onChange={(event) => setSubject(event.target.value)} />
                </label>
                <label className="mg-field">
                  <span className="t-label">{t('message.body')}</span>
                  <textarea className="mono" rows={3} value={body} aria-label={t('message.bodyLabel')} disabled={merge.isPending} onChange={(event) => setBody(event.target.value)} />
                </label>
              </span>
            </span>
          </div>
        )}
        <div className="rv-row">
          <span className="rv-k rv-label">{t('row.branch')}</span>
          <span className="rv-v">
            <span className="mg-fields">
              <Checkbox className="mg-check" checked={deleting} disabled={merge.isPending} onChange={setDeleteBranch}>
                <span className="mg-check-text">
                  <span>{t('branch.delete', { head: pr.branch, host })}</span>
                  <span className="mg-hint">{t('branch.localStays')}</span>
                </span>
              </Checkbox>
            </span>
          </span>
        </div>
        {warn && state.warning && (
          <div className="rv-row">
            <span className="rv-k rv-label">{t('row.warning')}</span>
            <span className="rv-v">
              <span className="badge badge-warn">{t('warning.word')}</span>
              <span className="mg-hint">{t(`warning.${state.warning}`, { host })}</span>
            </span>
          </div>
        )}
        <div className="mg-foot">
          <span className="mg-note">{merge.isPending ? t('note.merging', { host }) : t('note.done')}</span>
          <span className="mg-acts">
            <button type="button" className={primaryClass(lead)} disabled={!req || busy} aria-busy={merge.isPending || undefined} onClick={() => req && merge.mutate(req)}>
              {merge.isPending ? <Spinner variant="ring" /> : <GitMerge {...ICON_SM} />}
              {merge.isPending ? t('actions.merging') : t('actions.merge')}
            </button>
          </span>
        </div>
      </div>,
    );
  }

  // Not possible yet: the first blocker with its word and its remedy, the others under it
  const first = state.blocker;
  if (!first) return frame(<span className="badge">{t('badge.checksPending')}</span>, null);
  const mark = blockerMark(first.code);
  const others = blockersOf(state).slice(1);
  const offer = armBody(state, method);
  const armed = state.autoMerge.available && first.action !== 'auto-merge';
  const pending = first.code === 'checks-running';
  return frame(
    <span className={toneBadge(mark.tone)}>{t(mark.word)}</span>,
    <>
      <div className={`mb-note is-${mark.tone}`} role="status" data-reason={first.code}>
        {mark.tone === 'live' ? <Spinner variant="ring" /> : mark.tone === 'idle' ? <Clock {...ICON_SM} aria-hidden /> : <CircleAlert {...ICON_SM} aria-hidden />}
        <div className="mb-body">
          <div className="mb-head">
            <span className={toneBadge(mark.tone)}>{t(mark.word)}</span>
            <span className="mb-code">{first.code}</span>
          </div>
          <span className="mb-text">{t(mark.text, params(first))}</span>
          {first.detail && first.code !== 'checks-failing' && first.code !== 'checks-missing' && <span className="mb-detail">{first.detail}</span>}
          {pending && state.autoMerge.reason === 'auto-merge-not-allowed' && <span className="mg-hint">{t('failure.auto-merge-not-allowed')}</span>}
          <div className="mb-acts">
            {pending && offer ? (
              <button type="button" className={primaryClass(lead)} disabled={busy} onClick={() => arm.mutate(offer)}>
                {arm.isPending && <Spinner variant="ring" />}
                {t('actions.arm')}
              </button>
            ) : (
              remedyButton(first)
            )}
            {armed && !pending && offer && (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => arm.mutate(offer)}>
                {t('actions.arm')}
              </button>
            )}
          </div>
          {others.length > 0 && (
            <ul className="mb-others" aria-label={t('row.others')}>
              {others.map((other) => {
                const m = blockerMark(other.code);
                return (
                  <li key={other.code}>
                    <span className="mono">{other.code}</span>
                    <span className={toneBadge(m.tone)}>{t(m.word)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {pending && offer && <p className="mg-note">{t('note.arm', { host, noun: words.noun })}</p>}
    </>,
  );
}

/** What arming reads from while no state has come: nothing to offer. */
const EMPTY: Pick<MergeState, 'headSha' | 'autoMerge' | 'methods' | 'defaultMethod'> = {
  headSha: null,
  autoMerge: { available: false, reason: null, armed: false, method: null, armedBy: null, armedAt: null },
  methods: [],
  defaultMethod: null,
};
