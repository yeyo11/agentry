import type { ChangeRequestThreads, DecisionRecord, ReviewThread, WorkItemPullRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, MessageSquareReply, Send, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../../../api';
import { Checkbox, Sheet } from '@agentry/ui/components/controls';
import { Dialog } from '@agentry/ui/components/Dialog';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { fixStage } from '../../../lib/change-requests';
import {
  ADDRESS_THREADS_MAX,
  addressable,
  countThreads,
  followUp,
  followUpThreads,
  isReviewFix,
  lineLabel,
  preselected,
  threadLine,
  triageMark,
  type TriageMark,
} from '../../../lib/reviews';
import { useChangeRequestWords } from '../board/PullRequest';

const BADGE = { size: 11, strokeWidth: 2, 'aria-hidden': true } as const;
const MARKS: readonly TriageMark[] = ['agent', 'person', 'no-action'];

/**
 * What `review.triage` last said about a change request's threads, by thread id. The point only
 * preselects: a thread without a mark, or an answer in some other shape, is simply not marked.
 */
export function triageMarksOf(record: Pick<DecisionRecord, 'answers'> | null | undefined): Record<string, TriageMark> {
  const marks: Record<string, TriageMark> = {};
  for (const [threadId, answer] of Object.entries(record?.answers ?? {})) {
    if (answer.kind !== 'choice') continue;
    const mark = MARKS.find((m) => m === answer.value);
    if (mark) marks[threadId] = mark;
  }
  return marks;
}

const shortSha = (sha: string | null | undefined) => (sha ?? '').slice(0, 7);

/** `path:142` in mono, or the change request itself for a general thread. */
function useWhere() {
  const { t } = useTranslation('workItem');
  return (thread: ReviewThread, noun: string): string => {
    if (thread.path === null) return t('address.dialog.general', { noun });
    return `${thread.path}${lineLabel(threadLine(thread), thread.line === null ? null : thread.startLine) ?? ''}`;
  };
}

function ThreadRow({ thread, mark, on, narrow, where, onToggle }: { thread: ReviewThread; mark: TriageMark | undefined; on: boolean; narrow: boolean; where: string; onToggle: () => void }) {
  const { t } = useTranslation('workItem');
  const first = thread.comments[0];
  const tone = mark ? triageMark(mark).tone : null;
  const main = (
    <span className="addr-main">
      <span className="addr-head">
        <span className="addr-path">{where}</span>
        {thread.isOutdated && <span className="badge">{t('address.dialog.outdated')}</span>}
        {mark && <span className={`badge ${tone === 'ok' ? 'badge-ok' : 'badge-idle'}`}>{t(`address.triage.${mark}`)}</span>}
      </span>
      {/* Another person's text, drawn as text */}
      {first && <p className="addr-quote">{first.body}</p>}
      <span className="addr-by">{t('address.dialog.by', { count: thread.comments.length, author: first?.author ?? t('address.dialog.noAuthor') })}</span>
    </span>
  );
  // A phone has no checkboxes: the whole row is the button and says "Chosen"
  if (narrow)
    return (
      <button type="button" className={`addr-thread ${on ? 'on' : ''}`.trim()} aria-pressed={on} aria-label={t('address.dialog.choose', { where })} onClick={onToggle}>
        {main}
        <span className={`addr-state ${on ? 'on' : ''}`.trim()}>{on && <Check {...ICON_SM} />}{on ? t('address.dialog.chosen') : null}</span>
      </button>
    );
  return (
    <Checkbox className={`addr-thread ${on ? 'on' : ''}`.trim()} checked={on} onChange={onToggle} aria-label={t('address.dialog.choose', { where })}>
      {main}
    </Checkbox>
  );
}

/** Which threads go to the agent, with `review.triage`'s marks choosing the first selection: a click changes any of them. */
function AddressDialog({ pr, list, onClose }: { pr: WorkItemPullRequest; list: ChangeRequestThreads; onClose: () => void }) {
  const { t } = useTranslation('workItem');
  const words = useChangeRequestWords(pr.host);
  const narrow = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const where = useWhere();
  const crId = pr.id ?? '';
  const threads = addressable(list.threads);
  const resolved = countThreads(list.threads).resolved;

  const query = { point: 'review.triage', subjectId: crId, limit: 1 } as const;
  const triage = useQuery({ queryKey: keys.decisionsRecent(query), queryFn: ({ signal }) => api.decisions(query, { signal }), staleTime: 15_000, retry: false });
  const marks = triageMarksOf(triage.data?.items[0]);
  const marked = Object.keys(marks).length > 0;

  // null follows the marks until the person's first click
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const selected = chosen ?? preselected(threads, marks);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  const start = useMutation({
    mutationFn: (ids: string[]) => api.addressReview(crId, { threadIds: ids }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: keys.changeRequest(crId) });
      onClose();
      // A project whose flow is off gets the prompt as a chat of its own, in the item's worktree
      if (!result.started) navigate(result.worktree ? `/chats/new?cwd=${encodeURIComponent(result.worktree)}` : '/chats/new', { state: { prompt: result.prompt } });
    },
    onError: (error) => toast.error(t('address.errors.address'), error),
  });
  const ids = threads.filter((th) => selected.has(th.id)).map((th) => th.id);
  const go = () => start.mutate(ids);

  const title = pr.number === null ? t('address.dialog.titleUnnumbered', { noun: words.noun }) : t('address.dialog.title', { noun: words.noun, ref: words.ref(pr.number, pr.ref) });
  const body: ReactNode = (
    <div className="form addr-form">
      <p className="muted small">{t('address.dialog.intro')}</p>
      <div className="addr-group">
        <div className="addr-bar">
          <span className="section-label">{t('address.dialog.threads', { count: threads.length })}</span>
          {marked && (
            <span className="decided-face" title={t('address.dialog.suggestedTitle')}>
              {t('address.dialog.suggested')}
            </span>
          )}
          <span className="grow" />
          {marked && (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setChosen(preselected(threads, marks))}>
              {t('address.dialog.onlyAgent')}
            </button>
          )}
        </div>
        <div className="addr-list">
          {threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} mark={marks[thread.id]} on={selected.has(thread.id)} narrow={narrow} where={where(thread, words.noun)} onToggle={() => toggle(thread.id)} />
          ))}
        </div>
        {countThreads(list.threads).unresolved > ADDRESS_THREADS_MAX && <p className="muted small">{t('address.dialog.capped', { max: ADDRESS_THREADS_MAX })}</p>}
      </div>
      <p className="muted small">
        <b>{t('address.dialog.untrustedLead')}</b> {t('address.dialog.untrusted')}
      </p>
      <p className="muted small">{t('address.dialog.push', { noun: words.noun })}</p>
      {resolved > 0 && <p className="muted small">{t('address.dialog.resolved', { count: resolved })}</p>}
    </div>
  );
  const footer = (
    <>
      <span className="small muted addr-count">{t('address.dialog.count', { n: ids.length, total: threads.length })}</span>
      <span className="grow" />
      <button type="button" className="btn" onClick={onClose}>
        {t('address.dialog.cancel')}
      </button>
      <button type="button" className="btn btn-primary" data-autofocus disabled={ids.length === 0 || start.isPending} onClick={go}>
        <Sparkles {...ICON_SM} />
        {t('address.dialog.start', { count: ids.length })}
      </button>
    </>
  );
  if (narrow)
    return (
      <Sheet open onOpenChange={(next) => !next && onClose()} side="bottom" title={title} footer={<div className="addr-foot">{footer}</div>}>
        {body}
      </Sheet>
    );
  return (
    <Dialog title={title} onClose={onClose} width={600} footer={footer}>
      {body}
    </Dialog>
  );
}

/** The address under way or waiting for its push: live only while an agent or QA works on it. */
function ReviewRun({ pr }: { pr: WorkItemPullRequest }) {
  const { t } = useTranslation('workItem');
  const words = useChangeRequestWords(pr.host);
  const qc = useQueryClient();
  const toast = useToast();
  const stage = fixStage(pr);
  const push = useMutation({
    mutationFn: () => api.pushFix(pr.id ?? ''),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.changeRequest(pr.id ?? '') }),
    onError: (error) => toast.error(t('address.errors.push'), error),
  });
  if (!stage) return null;
  const hint = stage === 'push' ? t('address.run.hint.push', { noun: words.noun }) : t(`address.run.hint.${pr.fixOrigin === 'decision' ? 'decision' : 'person'}`);
  return (
    <div className={`check-fix ${stage === 'push' ? '' : 'live-rail'}`.trim()} role="status" aria-label={t('address.run.label')}>
      {stage === 'push' ? <span className="badge badge-idle">{t('address.run.waiting')}</span> : <Spinner />}
      <span className="check-fix-text">
        <b>{t(`address.run.stage.${stage}`)}</b>
        <br />
        <span>{hint}</span>
      </span>
      {stage === 'push' && (
        <button type="button" className="btn btn-primary btn-small workitem-push-review" disabled={push.isPending} onClick={() => push.mutate()}>
          <Send {...ICON_SM} />
          {t('address.run.push')}
        </button>
      )}
    </div>
  );
}

/**
 * After the fix reached the branch: the threads that were addressed and are still open, each with
 * "Reply “Addressed in <sha>”" and Resolve. Nothing is posted or resolved but by a click.
 */
function FollowUp({ pr, threads, sha, onDone }: { pr: WorkItemPullRequest; threads: ReviewThread[]; sha: string; onDone: (ids: string[]) => void }) {
  const { t } = useTranslation('workItem');
  const words = useChangeRequestWords(pr.host);
  const qc = useQueryClient();
  const toast = useToast();
  const where = useWhere();
  const crId = pr.id ?? '';
  const [replied, setReplied] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const text = t('address.followUp.replyText', { sha });
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.changeRequestThreads(crId) });

  const reply = async (thread: ReviewThread) => {
    await api.replyToThread(crId, thread.id, text);
    setReplied((current) => new Set(current).add(thread.id));
  };
  const resolve = async (thread: ReviewThread) => {
    await api.resolveThread(crId, thread.id, true);
    onDone([thread.id]);
  };
  const run = async (title: string, work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(title, error);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const all = () =>
    run(t('address.errors.resolve'), async () => {
      for (const thread of threads) {
        if (!replied.has(thread.id)) await reply(thread);
        await resolve(thread);
      }
    });

  return (
    <section className="item-wait item-pr-wait is-address-done" aria-label={t('address.followUp.label')}>
      <div className="item-wait-head">
        <span className="badge badge-idle">{t('address.run.waiting')}</span>
        <span className="item-wait-why">{t('address.followUp.title', { count: threads.length })}</span>
      </div>
      <p className="small muted item-wait-hint">{t('address.followUp.sub', { sha })}</p>
      <div className="addr-list">
        {threads.map((thread) => {
          const first = thread.comments[0];
          return (
            <div key={thread.id} className="addr-done">
              <div className="addr-head">
                <span className="addr-path">{where(thread, words.noun)}</span>
                {replied.has(thread.id) && (
                  <span className="badge badge-ok">
                    <Check {...BADGE} />
                    {t('address.followUp.replied')}
                  </span>
                )}
              </div>
              {first && <p className="addr-quote">{first.body}</p>}
              <div className="addr-acts">
                {!replied.has(thread.id) && (
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(t('address.errors.reply'), () => reply(thread))}>
                    <MessageSquareReply {...ICON_SM} />
                    {t('address.followUp.reply', { sha })}
                  </button>
                )}
                {thread.viewerCanResolve && (
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(t('address.errors.resolve'), () => resolve(thread))}>
                    <Check {...ICON_SM} />
                    {t('address.followUp.resolve')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="addr-reply">
        <span className="section-label">{t('address.followUp.published')}</span>
        <span className="mono">{text}</span>
      </div>
      <div className="item-wait-actions">
        <button type="button" className="btn btn-primary btn-small workitem-reply-resolve" disabled={busy} onClick={() => void all()}>
          <Check {...ICON_SM} />
          {t('address.followUp.replyAndResolve', { count: threads.length })}
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => onDone(threads.map((thread) => thread.id))}>
          {t('address.followUp.dismiss')}
        </button>
      </div>
    </section>
  );
}

/** The button that opens the dialog, for the review card's thread row as well as this page's own strip. */
export function AddressButton({ pr, className = 'btn btn-small', label = 'start' }: { pr: WorkItemPullRequest; className?: string; label?: 'start' | 'choose' }) {
  const { t } = useTranslation('workItem');
  const [open, setOpen] = useState(false);
  const list = useChangeRequestThreads(pr);
  if (!list.data) return null;
  return (
    <>
      <button type="button" className={`${className} workitem-address`} onClick={() => setOpen(true)}>
        <Sparkles {...ICON_SM} />
        {t(`address.strip.${label}`)}
      </button>
      {open && (
        <AddressDialog pr={pr} list={list.data} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** The threads of an open change request: the one read the strip, the dialog and the follow-up share. */
function useChangeRequestThreads(pr: Pick<WorkItemPullRequest, 'id' | 'phase'> | null | undefined) {
  const id = pr?.phase === 'open' ? pr.id : undefined;
  return useQuery({
    queryKey: keys.changeRequestThreads(id ?? ''),
    queryFn: ({ signal }) => api.changeRequestThreads(id ?? '', false, { signal }),
    enabled: !!id,
    // A host that does not serve threads leaves the strip out, rather than an error on every item
    retry: false,
  });
}

/**
 * Everything the item page says about review comments beside the PR panel: a quiet strip with the
 * way in while threads wait, the run while an agent addresses them, and the offer to answer them
 * after the push. It adds no gradient of its own: Submit review, or the dialog's own action, is the
 * zone's.
 */
export function AddressReview({ pr }: { pr: WorkItemPullRequest | null | undefined }) {
  const { t } = useTranslation('workItem');
  const list = useChangeRequestThreads(pr);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  if (!pr?.id || pr.phase !== 'open') return null;

  if (isReviewFix(pr)) return <ReviewRun pr={pr} />;
  if (!list.data) return null;

  // The core's record of the push the address made decides, never a head the browser saw change
  const done = followUp(pr);
  const follow = done ? followUpThreads(list.data.threads, done.threadIds).filter((thread) => !dismissed.has(thread.id)) : [];
  if (follow.length > 0 && done)
    return <FollowUp pr={pr} threads={follow} sha={shortSha(done.sha)} onDone={(ids) => setDismissed((current) => new Set([...current, ...ids]))} />;

  const open = addressable(list.data.threads).length;
  if (open === 0 || pr.fixState) return null;
  return (
    <div className="item-wait is-quiet item-pr-wait is-address">
      <span className="item-wait-why">{t('address.strip.why', { count: open })}</span>
      <AddressButton pr={pr} label="choose" />
    </div>
  );
}
