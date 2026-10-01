import type { ApprovalState, ChangeRequestReviewers, ReviewDraft, ReviewEvent, WorkItemPullRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, ExternalLink, Info, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiRequestError, api, keys } from '../../../api';
import { Sheet } from '@agentry/ui/components/controls';
import { Dialog, useConfirm } from '@agentry/ui/components/Dialog';
import { ICON_SM, monogramLetters, nameHue } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { Segmented } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import {
  approvalsProgress,
  canSubmit,
  countThreads,
  decisionMark,
  lineLabel,
  parseLogins,
  reviewerMark,
  sortDrafts,
  submitIsPrimary,
  submitOffer,
  summarizeDrafts,
  type ReviewTone,
} from '../../../lib/reviews';
import { useChangeRequestWords } from '../board/PullRequest';
import { AddressButton } from './AddressReview';

const shortSha = (sha: string | null | undefined): string => (sha ?? '').slice(0, 7);

/** The status badge of a review mark: always a word beside the colour. */
const badgeOf = (tone: ReviewTone): string => `badge badge-${tone}`;

/** The change request's id while it is open and the host numbered it: what the review routes take. */
const openId = (pr: Pick<WorkItemPullRequest, 'id' | 'phase'> | null | undefined): string | undefined => (pr?.phase === 'open' ? pr.id : undefined);

/** The person's draft review: rows on the server, so a reload or a second tab sees the same notes. */
export function useReviewDrafts(pr: Pick<WorkItemPullRequest, 'id' | 'phase'> | null | undefined) {
  const id = openId(pr);
  return useQuery({
    queryKey: keys.reviewDrafts(id ?? ''),
    queryFn: ({ signal }) => api.reviewDrafts(id ?? '', { signal }),
    enabled: !!id,
    retry: false,
  });
}

/**
 * Whether the person has notes in a draft review. While they do, **Submit review** is the item
 * page's gradient action and the header's "Work on it" renders neutral: a desktop screen has two
 * gradient surfaces at most.
 */
export function useHasDraftReview(pr: Pick<WorkItemPullRequest, 'id' | 'phase'> | null | undefined): boolean {
  const drafts = useReviewDrafts(pr);
  return submitIsPrimary(drafts.data?.length ?? 0);
}

/** The refusals `submit.reason` words; any other code is the server's own sentence. */
const REASONS = ['own-change-request', 'pending-review-exists', 'line-not-in-diff', 'review-partly-posted', 'write-unconfirmed', 'head-moved'] as const;
const isReason = (code: string | undefined): code is (typeof REASONS)[number] => REASONS.some((reason) => reason === code);

/** What a refusal says in the person's words: the reason's own sentence when there is one, else the server's. */
function useReasonText(host: string, noun: string) {
  const { t } = useTranslation('reviews');
  return (error: unknown): string | undefined => {
    if (!(error instanceof ApiRequestError)) return error instanceof Error ? error.message : undefined;
    if (isReason(error.code)) return t(`submit.reason.${error.code}`, { host, noun, detail: error.detail ?? '' });
    return error.detail ? `${error.message}: ${error.detail}` : error.message;
  };
}

/** A person: a neutral monogram (never the gradient avatar), the login in mono and a word for where they stand. */
function Person({ login, tone, word }: { login: string; tone: ReviewTone; word: string }) {
  return (
    <span className="rv-person">
      <span className="monogram rv-mono" style={{ '--hue': nameHue(login) } as CSSProperties} aria-hidden>
        {monogramLetters(login)}
      </span>
      <span className="name">{login}</span>
      <span className={badgeOf(tone)}>{word}</span>
    </span>
  );
}

/** Ask people for a review: their logins in one line; the host's re-read says who was added. */
function RequestDialog({ id, host, already, onClose }: { id: string; host: string; already: string[]; onClose: () => void }) {
  const { t } = useTranslation('reviews');
  const narrow = useMediaQuery(NARROW);
  const qc = useQueryClient();
  const toast = useToast();
  const inputId = useId();
  const [text, setText] = useState('');
  const logins = parseLogins(text, already);
  const request = useMutation({
    mutationFn: () => api.requestReviewers(id, { add: logins }),
    onSuccess: (result) => {
      qc.setQueryData(keys.changeRequestReviewers(id), result);
      const added = logins.filter((login) => result.reviewers.some((r) => r.login.toLowerCase() === login.toLowerCase()));
      // GitHub answers 0 for a login it does not know and adds nobody: the re-read is what says so
      if (added.length === 0) toast.info(t('request.nobody', { host }));
      onClose();
    },
    onError: (error) => toast.error(t('request.failed'), error),
  });
  const body = (
    <div className="form">
      <p className="muted small">{t('request.intro')}</p>
      <label htmlFor={inputId} className="field-label">
        {t('request.label')}
      </label>
      <input
        id={inputId}
        className="mono"
        data-autofocus
        value={text}
        placeholder={t('request.placeholder')}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && logins.length > 0 && !request.isPending) request.mutate();
        }}
      />
    </div>
  );
  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('request.cancel')}
      </button>
      <button type="button" className="btn" disabled={logins.length === 0 || request.isPending} onClick={() => request.mutate()}>
        {t('request.send')}
      </button>
    </>
  );
  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} side="bottom" title={t('request.title')} footer={<div className="rv-sheet-foot">{footer}</div>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={t('request.title')} onClose={onClose} width={460} footer={footer}>
      {body}
    </Dialog>
  );
}

function DraftNote({ draft, noun, onRemove, removing = false }: { draft: ReviewDraft; noun: string; onRemove?: () => void; removing?: boolean }) {
  const { t } = useTranslation('reviews');
  const place = draft.path === null ? null : lineLabel(draft.line, draft.startLine);
  const where = draft.path === null ? t('draft.general', { noun }) : `${draft.path}${place ?? ''}`;
  return (
    <li className="rv-note">
      <span className="rv-where">
        {draft.path === null ? (
          where
        ) : (
          <>
            <span className="p">{draft.path}</span>
            {place && <span className="l">{place}</span>}
          </>
        )}
      </span>
      {draft.suggestion && <span className="badge badge-suggest">{t('draft.suggestion')}</span>}
      {onRemove && (
        <button type="button" className="icon-btn rv-note-remove" aria-label={t('draft.remove', { where })} disabled={removing} onClick={onRemove}>
          <X {...ICON_SM} />
        </button>
      )}
      {/* The note's text is the person's own; a suggestion's is code, kept as plain text in mono */}
      <span className={`rv-text ${draft.suggestion ? 'is-code' : ''}`.trim()}>{draft.body}</span>
    </li>
  );
}

/** Where a submit stopped, kept for the draft block: the host's own refusals the person has to act on. */
type Outcome = { kind: 'partly'; postId: string } | { kind: 'pending' } | { kind: 'own' } | null;

/**
 * How the review goes out: comment, plus comment-and-approve on GitLab; on GitHub, approving and
 * asking for changes stay on GitHub and the sheet says so. A Dialog on a desktop and a `Sheet` on a
 * phone. Reference: DesktopTareaRevisionEnvio and MobileTareaRevisionEnvio.
 */
function SubmitSheet({
  id,
  pr,
  drafts,
  approval,
  own,
  onDone,
  onRefused,
  onClose,
}: {
  id: string;
  pr: WorkItemPullRequest;
  drafts: ReviewDraft[];
  approval: ApprovalState | undefined;
  own: boolean;
  onDone: () => void;
  onRefused: (outcome: Outcome) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('reviews');
  const words = useChangeRequestWords(pr.host);
  const narrow = useMediaQuery(NARROW);
  const toast = useToast();
  const reasonText = useReasonText(words.host, words.noun);
  const host = pr.host ?? 'github';
  const offer = submitOffer(host, approval, own);
  const [event, setEvent] = useState<ReviewEvent>('comment');
  const [summary, setSummary] = useState('');
  const sha = shortSha(approval?.headSha);
  const send = useMutation({
    mutationFn: () => api.submitReview(id, { event, body: summary.trim() }),
    onSuccess: () => {
      toast.success(t('submit.sent'));
      onDone();
    },
    onError: (error) => {
      const code = error instanceof ApiRequestError ? error.code : undefined;
      if (code === 'review-partly-posted' && error instanceof ApiRequestError && error.postId) onRefused({ kind: 'partly', postId: error.postId });
      else if (code === 'pending-review-exists') onRefused({ kind: 'pending' });
      else if (code === 'own-change-request') onRefused({ kind: 'own' });
      else {
        toast.error(t('submit.failed'), reasonText(error));
        return;
      }
      toast.error(t('submit.failed'), reasonText(error));
      onClose();
    },
  });
  const summarized = summarizeDrafts(drafts);
  const countsText = [
    summarized.comments > 0 ? t('draft.comments', { count: summarized.comments }) : null,
    summarized.suggestions > 0 ? t('draft.suggestions', { count: summarized.suggestions }) : null,
  ]
    .filter((part): part is string => !!part)
    .join(' · ');
  const ready = canSubmit(drafts, event, summary) && !send.isPending;
  const ref = words.ref(pr.number, pr.ref);

  const body = (
    <div className="rv-submit">
      {offer.events.length > 1 ? (
        <Segmented<ReviewEvent>
          label={t('submit.how')}
          value={event}
          onChange={setEvent}
          options={offer.events.map((value) => ({ value, label: t(`submit.${value === 'approve' ? 'approve' : 'comment'}`) }))}
        />
      ) : null}
      <p className="muted small">{event === 'approve' ? t('submit.approveHelp', { sha: sha || '—' }) : t('submit.commentHelp')}</p>
      <label className="rv-field">
        <span className="rv-label">{t('submit.summary')}</span>
        <textarea rows={4} data-autofocus value={summary} placeholder={t('submit.summaryPlaceholder', { noun: words.noun })} onChange={(e) => setSummary(e.target.value)} />
      </label>
      {drafts.length > 0 ? (
        <section className="rv-goes" aria-label={t('submit.goes', { summary: countsText })}>
          <span className="rv-label">{t('submit.goes', { summary: countsText })}</span>
          <ul className="rv-notes">
            {sortDrafts(drafts).map((draft) => (
              <DraftNote key={draft.id} draft={draft} noun={words.noun} />
            ))}
          </ul>
        </section>
      ) : (
        <p className="muted small">{t('submit.nothing')}</p>
      )}
    </div>
  );
  const footer = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('submit.cancel')}
      </button>
      <button type="button" className="btn btn-primary rv-send" disabled={!ready} onClick={() => send.mutate()}>
        {send.isPending ? (
          <>
            <Spinner variant="ring" />
            {t('submit.sending')}
          </>
        ) : (
          t('submit.send')
        )}
      </button>
    </>
  );
  const sub = t('submit.sub', { ref, sha: sha || shortSha(pr.fixHead) || '—' });
  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && !send.isPending && onClose()} side="bottom" title={t('submit.title')} description={sub} footer={<div className="rv-sheet-foot">{footer}</div>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog
      title={
        <span className="rv-dialog-title">
          <b>{t('submit.title')}</b>
          <span className="mono">{sub}</span>
        </span>
      }
      onClose={() => !send.isPending && onClose()}
      width={560}
      footer={footer}
    >
      {body}
    </Dialog>
  );
}

/**
 * The review of the item's open change request: its decision, the people asked, the threads, and
 * the person's own draft review with the one gradient action that sends it. Reference:
 * DesktopTareaRevision, DesktopTareaRevisionEstados and their phone versions.
 *
 * The threads row offers Address with an agent when there is something to address. `changesPath` is the item's changes page, where
 * the threads and the draft's notes are left on their lines.
 */
export function Review({ pr, itemId, changesPath }: { pr: WorkItemPullRequest | null | undefined; itemId: string; changesPath?: string }) {
  const { t } = useTranslation('reviews');
  const words = useChangeRequestWords(pr?.host);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const id = openId(pr);
  const host = pr?.host ?? 'github';
  const [requesting, setRequesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [own, setOwn] = useState(false);

  const reviewers = useQuery({
    queryKey: keys.changeRequestReviewers(id ?? ''),
    queryFn: ({ signal }) => api.changeRequestReviewers(id ?? '', { signal }),
    enabled: !!id,
    retry: false,
  });
  const threads = useQuery({
    queryKey: keys.changeRequestThreads(id ?? ''),
    queryFn: ({ signal }) => api.changeRequestThreads(id ?? '', false, { signal }),
    enabled: !!id,
    retry: false,
  });
  // GitLab only: GitHub has no approval of Agentry's to read, and its approve is a link
  const approval = useQuery({
    queryKey: keys.changeRequestApproval(id ?? ''),
    queryFn: ({ signal }) => api.changeRequestApproval(id ?? '', { signal }),
    enabled: !!id && host === 'gitlab',
    retry: false,
  });
  const draftsQuery = useReviewDrafts(pr);
  const drafts = draftsQuery.data ?? [];
  const reasonText = useReasonText(words.host, words.noun);

  const settle = () => {
    if (!id) return;
    void qc.invalidateQueries({ queryKey: keys.reviewDrafts(id) });
    void qc.invalidateQueries({ queryKey: ['change-request', id] });
    void qc.invalidateQueries({ queryKey: keys.workItem(itemId) });
  };
  const discard = useMutation({
    mutationFn: async () => {
      for (const draft of drafts) await api.deleteReviewDraft(id ?? '', draft.id);
    },
    onSettled: settle,
    onError: (error) => toast.error(t('draft.failed.discard'), error),
  });
  const remove = useMutation({
    mutationFn: (draftId: string) => api.deleteReviewDraft(id ?? '', draftId),
    onSettled: settle,
    onError: (error) => toast.error(t('draft.failed.remove'), error),
  });
  const publish = useMutation({
    mutationFn: (postId: string) => api.publishSavedReview(id ?? '', postId),
    onSuccess: () => {
      toast.success(t('partly.published'));
      setOutcome(null);
    },
    onError: (error) => toast.error(t('partly.failedPublish'), reasonText(error)),
    onSettled: settle,
  });
  const dropSaved = useMutation({
    mutationFn: (postId: string) => api.discardSavedReview(id ?? '', postId),
    onSuccess: () => {
      toast.info(t('partly.discarded'));
      setOutcome(null);
    },
    onError: (error) => toast.error(t('partly.failedDiscard'), reasonText(error)),
    onSettled: settle,
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeApproval(id ?? ''),
    onSuccess: (state) => {
      if (id) qc.setQueryData(keys.changeRequestApproval(id), state);
      toast.success(t('approve.revoked'));
    },
    onError: (error) => toast.error(t('approve.failed'), reasonText(error)),
    onSettled: settle,
  });

  // A submit that stopped half way is only known to this tab: the saved notes stay on GitLab
  useEffect(() => {
    if (drafts.length === 0 && outcome?.kind === 'pending') setOutcome(null);
  }, [drafts.length, outcome]);

  if (!pr || !id) return null;

  const decision = decisionMark(reviewers.data?.decision);
  const progress = approvalsProgress(approval.data);
  const counts = countThreads(threads.data?.threads ?? []);
  const unresolved = threads.data ? counts.unresolved : (reviewers.data?.unresolvedThreads ?? 0);
  const offer = submitOffer(host, approval.data, own);
  const ref = words.ref(pr.number, pr.ref);
  const summary = summarizeDrafts(drafts);
  const partly = outcome?.kind === 'partly' ? outcome : null;
  const pending = outcome?.kind === 'pending';
  const mine = approval.data?.viewerHasApproved ? approval.data : null;
  const working = remove.isPending || discard.isPending || publish.isPending || dropSaved.isPending;
  const people: ChangeRequestReviewers['reviewers'] = reviewers.data?.reviewers ?? [];
  const countsText = [
    summary.comments > 0 ? t('draft.comments', { count: summary.comments }) : null,
    summary.suggestions > 0 ? t('draft.suggestions', { count: summary.suggestions }) : null,
  ]
    .filter((part): part is string => !!part)
    .join(' · ');

  const askDiscard = async () => {
    const ok = await confirm({
      title: t('draft.discardTitle'),
      body: t('draft.discardBody', { count: drafts.length }),
      confirmLabel: t('draft.discardConfirm'),
      cancelLabel: t('request.cancel'),
      danger: true,
    });
    if (ok) discard.mutate();
  };

  return (
    <section className="rv" aria-label={t('title')}>
      <div className="rv-head">
        <span className="rv-title">
          <h2>{t('title')}</h2>
          {pr.number !== null && <span className="rv-sub">{t('sub', { noun: words.noun, ref })}</span>}
        </span>
      </div>

      {reviewers.error && !reviewers.data ? (
        <div className="rv-quiet warn" role="note">
          <CircleAlert {...ICON_SM} />
          <span>{t('failed', { host: words.host })}</span>
          <button type="button" className="btn btn-small" onClick={() => void reviewers.refetch()}>
            {t('retry')}
          </button>
        </div>
      ) : (
        <div className="rv-card">
          <div className="rv-row">
            <span className="rv-k rv-label">{t('row.decision')}</span>
            <span className="rv-v">
              {reviewers.isPending ? (
                <span className="muted">{t('loading')}</span>
              ) : (
                <>
                  <span className={badgeOf(decision.tone)}>{t(decision.label)}</span>
                  {progress && <span>{t('approvals', progress)}</span>}
                </>
              )}
            </span>
          </div>

          <div className="rv-row">
            <span className="rv-k rv-label">{t('row.reviewers')}</span>
            <span className="rv-v">
              {people.length === 0 && !reviewers.isPending && <span className="muted">{t('noReviewers')}</span>}
              {people.map((person) => {
                const mark = reviewerMark(person.state);
                return <Person key={person.login} login={person.login} tone={mark.tone} word={t(mark.label)} />;
              })}
            </span>
            <span className="rv-side">
              <button type="button" className="btn btn-ghost btn-small" aria-haspopup="dialog" onClick={() => setRequesting(true)}>
                <Plus {...ICON_SM} />
                {t('request.action')}
              </button>
            </span>
          </div>

          <div className="rv-row">
            <span className="rv-k rv-label">{t('row.threads')}</span>
            <span className="rv-v">
              {threads.isPending && reviewers.isPending ? null : unresolved > 0 ? (
                <span className="badge badge-warn">{t('threads.unresolved', { count: unresolved })}</span>
              ) : counts.resolved > 0 ? (
                <span className="badge badge-ok">{t('threads.allResolved')}</span>
              ) : (
                <span className="muted">{t('threads.none')}</span>
              )}
              {counts.resolved > 0 && unresolved > 0 && <span className="rv-count">{t('threads.resolved', { count: counts.resolved })}</span>}
              {counts.resolved > 0 && unresolved === 0 && <span className="rv-count">{t('threads.resolved', { count: counts.resolved })}</span>}
            </span>
            <span className="rv-side">
              {changesPath && (
                <Link to={changesPath} className="btn btn-ghost btn-small">
                  {t('threads.view')}
                </Link>
              )}
              {pr && unresolved > 0 && <AddressButton pr={pr} className="btn btn-small rv-address" />}
            </span>
          </div>

          {mine && (
            <div className="rv-row">
              <span className="rv-k rv-label">{t('row.approval')}</span>
              <span className="rv-v">
                <span className="badge badge-ok">{t('approve.mine')}</span>
                {mine.headSha && <span className="rv-count">{t('approve.commit', { sha: shortSha(mine.headSha) })}</span>}
              </span>
              <span className="rv-side">
                {mine.canRevoke && (
                  <button type="button" className="btn btn-ghost btn-small" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                    {t('approve.revoke')}
                  </button>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      <section className="rv-draft" aria-label={t('draft.title')}>
        <div className="rv-draft-head">
          <Pencil {...ICON_SM} className="rv-ico" />
          <b>{t('draft.title')}</b>
          <span className="badge">{partly ? t('draft.partlyBadge') : t('draft.badge')}</span>
          {drafts.length > 0 && <span className="rv-count">{countsText}</span>}
        </div>

        {offer.own && (
          <div className="rv-callout" role="note">
            <Info {...ICON_SM} />
            <span>{t('host.own', { host: words.host, noun: words.noun })}</span>
          </div>
        )}
        {pending && (
          <div className="rv-callout warn" role="note">
            <CircleAlert {...ICON_SM} />
            <div className="rv-col">
              <span>
                <b>{t('host.pending')}</b>
              </span>
              {pr.url && (
                <a href={pr.url} target="_blank" rel="noreferrer" className="rv-link">
                  {t('host.pendingOpen')}
                  <ExternalLink {...ICON_SM} />
                </a>
              )}
            </div>
          </div>
        )}
        {partly && (
          <div className="rv-callout warn" role="note">
            <CircleAlert {...ICON_SM} />
            <span>{t('partly.text')}</span>
          </div>
        )}

        {drafts.length === 0 ? (
          <div className="rv-empty">
            <p>{t('draft.empty')}</p>
            {changesPath && (
              <Link to={changesPath} className="btn btn-small">
                {t('draft.viewChanges')}
              </Link>
            )}
          </div>
        ) : (
          <ul className="rv-notes">
            {sortDrafts(drafts).map((draft) => (
              <DraftNote key={draft.id} draft={draft} noun={words.noun} removing={working} onRemove={() => remove.mutate(draft.id)} />
            ))}
          </ul>
        )}

        {drafts.length > 0 && (
          <div className="rv-foot">
            {partly ? (
              <>
                <button type="button" className="btn btn-ghost" disabled={working} onClick={() => dropSaved.mutate(partly.postId)}>
                  {t('partly.discard')}
                </button>
                <button type="button" className="btn btn-primary" disabled={working} onClick={() => publish.mutate(partly.postId)}>
                  {t('partly.publish')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-ghost" disabled={working} onClick={() => void askDiscard()}>
                  <Trash2 {...ICON_SM} />
                  {t('draft.discard')}
                </button>
                <button type="button" className="btn btn-primary rv-submit-btn" disabled={pending || working} onClick={() => setSubmitting(true)}>
                  {t('draft.submit')}
                </button>
              </>
            )}
          </div>
        )}

        {offer.openOnHost && pr.url && drafts.length > 0 && (
          <div className="rv-open">
            <span className="muted small">{t('host.githubOnly')}</span>
            <a className="btn btn-ghost btn-small" href={pr.url} target="_blank" rel="noreferrer">
              <ExternalLink {...ICON_SM} />
              {t('host.open')}
            </a>
          </div>
        )}
      </section>

      {requesting && <RequestDialog id={id} host={words.host} already={people.map((p) => p.login)} onClose={() => setRequesting(false)} />}
      {submitting && (
        <SubmitSheet
          id={id}
          pr={pr}
          drafts={drafts}
          approval={approval.data}
          own={own}
          onClose={() => setSubmitting(false)}
          onDone={() => {
            setSubmitting(false);
            setOutcome(null);
            settle();
          }}
          onRefused={(next) => {
            if (next?.kind === 'own') setOwn(true);
            setOutcome(next);
            settle();
          }}
        />
      )}
    </section>
  );
}
