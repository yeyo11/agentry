import type { ChangeRequestThreads, ReviewComment, ReviewSide, ReviewThread } from '@agentry/shared';
import { RichText } from '@agentry/chat-ui/components/Transcript';
import { Sheet } from '@agentry/ui/components/controls';
import { ICON_SM, Monogram } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { formatDateTime, timeAgo } from '@agentry/ui/lib/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, MessageSquare, MessageSquarePlus, RotateCcw } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { countThreads, groupThreads, lineKey, lineLabel, startsFolded, threadLine, type FileThreads } from '../../lib/reviews';
import type { LineLayer } from './DiffView';
import { splitPath } from './review-model';

// The review's threads on the diff (design system §5, "Review threads in the diff"). A thread is a
// card under its line, never a new kind of diff: DiffView draws the rows and asks this layer what
// goes under each one. Everything a card shows was written by someone else, so a comment is text or
// the sanitising markdown, never markup. Replying and resolving act on the host at once; they are not
// part of the person's draft review. Nothing here is live: no spinner, no `--live`.

/** The threads of a change request, read by head; `change-request.review` refreshes them */
export function useReviewThreads(changeRequestId: string | undefined) {
  const q = useQuery({
    queryKey: keys.changeRequestThreads(changeRequestId ?? ''),
    queryFn: ({ signal }) => api.changeRequestThreads(changeRequestId!, false, { signal }),
    enabled: !!changeRequestId,
  });
  return q;
}

/** What a file shows of the review: its threads placed, and the counts of the file header's chip */
export function useFileThreads(data: ChangeRequestThreads | undefined, path: string): { file: FileThreads | null; threads: ReviewThread[] } {
  return useMemo(() => {
    const threads = (data?.threads ?? []).filter((t) => t.path === path);
    return { file: groupThreads(threads).files.get(path) ?? null, threads };
  }, [data, path]);
}

/** A comment's body without the fenced suggestion the card draws on its own */
const withoutSuggestion = (body: string): string => body.replace(/```suggestion[^\n]*\n[\s\S]*?```/g, '').trim();

const authorOf = (c: ReviewComment, unknown: string): string => c.author ?? unknown;

// ---------------------------------------------------------------------------------------------
// One comment

function Suggestion({ comment, line }: { comment: ReviewComment; line: string }) {
  const { t } = useTranslation('changes');
  const s = comment.suggestion;
  if (!s) return null;
  const where = s.fromLine === s.toLine ? t('thread.suggestionLine', { line: s.fromLine }) : t('thread.suggestionLines', { from: s.fromLine, to: s.toLine });
  const lines = (text: string) => text.replace(/\n$/, '').split('\n');
  return (
    <div className="rt-sugg">
      <div className="rt-sugg-head">
        <MessageSquarePlus {...ICON_SM} />
        {t('thread.suggestion')}
        <span className="grow" />
        <span title={line}>{where}</span>
      </div>
      {s.fromContent !== null &&
        lines(s.fromContent).map((text, i) => (
          <div key={`d${i}`} className="rt-sugg-row del">
            <i aria-hidden>−</i>
            <code>{text}</code>
          </div>
        ))}
      {lines(s.toContent).map((text, i) => (
        <div key={`a${i}`} className="rt-sugg-row add">
          <i aria-hidden>+</i>
          <code>{text}</code>
        </div>
      ))}
    </div>
  );
}

function Comment({ comment, where }: { comment: ReviewComment; where: string }) {
  const { t } = useTranslation('changes');
  const name = authorOf(comment, t('thread.unknownAuthor'));
  const text = comment.suggestion ? withoutSuggestion(comment.body) : comment.body;
  return (
    <div className="rt-comment">
      <span className="rt-avatar" role="img" aria-label={name} title={name}>
        <Monogram name={name} size={24} />
      </span>
      <div className="rt-main">
        <span className="rt-who">
          <b>{name}</b>
          {comment.createdAt && <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>{timeAgo(comment.createdAt)}</time>}
        </span>
        {text && <RichText className="rt-body" text={text} />}
        <Suggestion comment={comment} line={where} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One thread

/** `project-settings.ts:10`, or the line alone where the file is the page's context (a phone) */
function whereOf(thread: ReviewThread, phone: boolean): string {
  const name = thread.path ? splitPath(thread.path).name : '';
  const at = lineLabel(threadLine(thread), thread.startLine) ?? '';
  return phone ? at.replace(/^:/, '') : `${name}${at}`;
}

/** Reply and resolve; each one re-reads the threads, which the host answers with its own state */
function useThreadActions(changeRequestId: string, thread: ReviewThread) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation('changes');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['change-request', changeRequestId] });
  };
  const reply = useMutation({
    mutationFn: (body: string) => api.replyToThread(changeRequestId, thread.id, body),
    onSuccess: refresh,
    onError: (err) => toast.error(t('thread.replyFailed'), err),
  });
  const resolve = useMutation({
    mutationFn: (resolved: boolean) => api.resolveThread(changeRequestId, thread.id, resolved),
    onSuccess: refresh,
    onError: (err) => toast.error(t('thread.resolveFailed'), err),
  });
  return { reply, resolve };
}

/** A phone's reply: the same Sheet as a new note, with the thread's last comment quoted above the field */
function ReplySheet({ thread, open, onOpenChange, onSend, busy }: { thread: ReviewThread; open: boolean; onOpenChange: (open: boolean) => void; onSend: (body: string) => void; busy: boolean }) {
  const { t } = useTranslation('changes');
  const [text, setText] = useState('');
  const last = thread.comments[thread.comments.length - 1];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
    onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('thread.replyTitle')} description={whereOf(thread, false)} closeLabel={t('thread.replyClose')}>
      <form className="rt-sheet" onSubmit={submit}>
        {last && <blockquote className="rt-quote">{withoutSuggestion(last.body).slice(0, 280)}</blockquote>}
        <label className="field field-area">
          <textarea rows={4} value={text} autoFocus aria-label={t('thread.replyLabel')} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={busy || !text.trim()}>
          {t('thread.reply')}
        </button>
      </form>
    </Sheet>
  );
}

export function ThreadCard({
  changeRequestId,
  thread,
  phone,
  withFile = false,
}: {
  changeRequestId: string;
  thread: ReviewThread;
  phone: boolean;
  /** Name the file in the head: where the card is not under the line it is about (outdated, whole file) */
  withFile?: boolean;
}) {
  const { t } = useTranslation('changes');
  const { reply, resolve } = useThreadActions(changeRequestId, thread);
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState(false);
  const where = whereOf(thread, phone && !withFile);
  const state = thread.isResolved ? 'resolved' : thread.isOutdated ? 'outdated' : 'open';
  const send = (body: string) => reply.mutate(body, { onSuccess: () => setText('') });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && !reply.isPending) send(text.trim());
  };
  return (
    <article className={`rt ${state === 'resolved' ? 'resolved' : state === 'outdated' ? 'outdated' : 'open'}`} aria-label={t('thread.label', { where: where || t('thread.file') })}>
      <div className="rt-head">
        {thread.isResolved ? (
          <span className="badge badge-ok">
            <Check {...ICON_SM} />
            {t('thread.resolved')}
          </span>
        ) : (
          <span className="badge badge-idle">{t('thread.open')}</span>
        )}
        {thread.isOutdated && <span className="badge">{t('thread.outdated')}</span>}
        <span className="where">{where}</span>
        {thread.isResolved && thread.resolvedBy && <span className="rt-note">{t('thread.resolvedBy', { name: thread.resolvedBy })}</span>}
        {thread.isOutdated && !phone && <span className="rt-note">{t('thread.outdatedWhy')}</span>}
        <span className="grow" />
        <span className="rt-count">{t('thread.comments', { count: thread.comments.length })}</span>
      </div>
      {thread.isOutdated && thread.diffHunk && <Hunk hunk={thread.diffHunk} line={thread.originalLine} />}
      {thread.comments.map((c) => (
        <Comment key={c.id} comment={c} where={where} />
      ))}
      {thread.commentsTruncated && <p className="rt-more">{t('thread.truncated')}</p>}
      {(thread.viewerCanReply || thread.viewerCanResolve) && (
        <form className="rt-foot" onSubmit={submit}>
          {thread.viewerCanReply &&
            (phone ? (
              <button type="button" className="btn" onClick={() => setSheet(true)}>
                {t('thread.reply')}
              </button>
            ) : (
              <label className="field">
                <input
                  value={text}
                  placeholder={t('thread.replyPlaceholder')}
                  aria-label={t('thread.replyLabel')}
                  disabled={reply.isPending}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
            ))}
          {!phone && thread.viewerCanReply && text.trim() && (
            <button type="submit" className="btn btn-small" disabled={reply.isPending}>
              {t('thread.reply')}
            </button>
          )}
          {thread.viewerCanResolve && (
            <button type="button" className={`btn${phone ? '' : ' btn-small'}`} disabled={resolve.isPending} onClick={() => resolve.mutate(!thread.isResolved)}>
              {thread.isResolved ? <RotateCcw {...ICON_SM} /> : <Check {...ICON_SM} />}
              {thread.isResolved ? t('thread.reopen') : t('thread.resolve')}
            </button>
          )}
        </form>
      )}
      {phone && <ReplySheet thread={thread} open={sheet} onOpenChange={setSheet} onSend={send} busy={reply.isPending} />}
    </article>
  );
}

/** The hunk an outdated comment was left on; its last line is the one commented */
function Hunk({ hunk, line }: { hunk: string; line: number | null }) {
  const { t } = useTranslation('changes');
  const rows = hunk.split('\n').filter((l) => !l.startsWith('@@')).slice(-6);
  return (
    <div className="rt-hunk">
      {line !== null && <div className="rt-hunk-note">{t('thread.originalLine', { line })}</div>}
      {rows.map((row, i) => {
        // Only the commented line carries the added rail; the rest is the code around it
        const last = i === rows.length - 1;
        return (
          <div key={i} className={`rt-hunk-row ${last ? 'add' : 'ctx'}`}>
            <i aria-hidden>{last ? '+' : ' '}</i>
            <code>{row.slice(1)}</code>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Folds

/** One row that stands for a thread, a resolved one by default and an outdated one always, until opened */
function Fold({ children, label }: { children: ReactNode; label: string }) {
  const { t } = useTranslation('changes');
  const [open, setOpen] = useState(false);
  return (
    <>
      {open ? (
        <div className="rt-unfold">
          <button type="button" className="btn btn-ghost btn-small" aria-expanded onClick={() => setOpen(false)}>
            {t('thread.hide')}
          </button>
        </div>
      ) : (
        <div className="rt-fold">
          <span className="grow">{label}</span>
          <button type="button" className="btn btn-ghost" aria-expanded={false} onClick={() => setOpen(true)}>
            {t('thread.show')}
          </button>
        </div>
      )}
      {open && children}
    </>
  );
}

/** A thread on a line: resolved ones fold into a row naming who and how many */
function LineThread({ changeRequestId, thread, phone }: { changeRequestId: string; thread: ReviewThread; phone: boolean }) {
  const { t } = useTranslation('changes');
  const card = <ThreadCard changeRequestId={changeRequestId} thread={thread} phone={phone} />;
  if (!startsFolded(thread)) return card;
  const authors = [...new Set(thread.comments.map((c) => authorOf(c, t('thread.unknownAuthor'))))].join(', ');
  return <Fold label={t('thread.foldResolved', { authors, count: thread.comments.length })}>{card}</Fold>;
}

/** The threads that have no line to stand under, folded at the top of the file */
export function FileThreadsFold({ changeRequestId, file, phone }: { changeRequestId: string; file: FileThreads; phone: boolean }) {
  const { t } = useTranslation('changes');
  return (
    <>
      {file.file.map((thread) => (
        <ThreadCard key={thread.id} changeRequestId={changeRequestId} thread={thread} phone={phone} withFile />
      ))}
      {file.outdated.length > 0 && (
        <Fold label={t('thread.foldOutdated', { count: file.outdated.length })}>
          {file.outdated.map((thread) => (
            <ThreadCard key={thread.id} changeRequestId={changeRequestId} thread={thread} phone={phone} withFile />
          ))}
        </Fold>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The layer DiffView draws

/** What a file's header says of its threads: `3 threads · 1 unresolved` */
export function ThreadsChip({ threads }: { threads: readonly ReviewThread[] }) {
  const { t } = useTranslation('changes');
  if (threads.length === 0) return null;
  const { unresolved } = countThreads(threads);
  return (
    <span className="chip changes-threads-chip" title={t('thread.chipTitle')}>
      <MessageSquare {...ICON_SM} />
      {t('thread.chip', { count: threads.length })}
      {unresolved > 0 && <span className="n">{t('thread.chipOpen', { count: unresolved })}</span>}
    </span>
  );
}

/**
 * The layer a file hands DiffView: thread cards under their lines, the pill at the right of a line
 * with a conversation, and the gutter's "+". `extra` is what the draft review adds under a line (the
 * person's notes and the composer); `onAddNote` opens a note on a line.
 */
export function threadLayer({
  changeRequestId,
  file,
  phone,
  extra,
  onAddNote,
}: {
  changeRequestId: string;
  file: FileThreads | null;
  phone: boolean;
  extra?: (side: ReviewSide, line: number) => ReactNode;
  onAddNote?: (side: ReviewSide, line: number) => void;
}): LineLayer {
  return {
    after: (side, line) => {
      const key = lineKey(side, line);
      const open = file?.byLine.get(key) ?? [];
      const resolved = file?.resolvedByLine.get(key) ?? [];
      const own = extra?.(side, line);
      if (open.length === 0 && resolved.length === 0 && !own) return null;
      return (
        <>
          {[...open, ...resolved].map((thread) => (
            <LineThread key={thread.id} changeRequestId={changeRequestId} thread={thread} phone={phone} />
          ))}
          {own}
        </>
      );
    },
    // On a phone the card under the line says it, so there is no pill
    mark: phone
      ? undefined
      : (side, line) => {
          const key = lineKey(side, line);
          const all = [...(file?.byLine.get(key) ?? []), ...(file?.resolvedByLine.get(key) ?? [])];
          if (all.length === 0) return null;
          return <NotePill threads={all} />;
        },
    gutter: onAddNote ? (side, line) => <AddNote line={line} onAdd={() => onAddNote(side, line)} /> : undefined,
  };
}

function NotePill({ threads }: { threads: ReviewThread[] }) {
  const { t } = useTranslation('changes');
  const count = threads.reduce((n, th) => n + th.comments.length, 0);
  const open = threads.some((th) => !th.isResolved);
  return (
    <span className={`diff-note-pill${open ? ' is-open' : ''}`} role="img" aria-label={t('thread.pill', { count })}>
      <MessageSquare {...ICON_SM} />
      {count}
    </span>
  );
}

function AddNote({ line, onAdd }: { line: number; onAdd: () => void }) {
  const { t } = useTranslation('changes');
  return (
    <button type="button" className="diff-add-note" aria-label={t('thread.addNote', { line })} onClick={onAdd}>
      <MessageSquarePlus {...ICON_SM} />
    </button>
  );
}
