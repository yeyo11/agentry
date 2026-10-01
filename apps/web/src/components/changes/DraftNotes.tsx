import type { ReviewDraft, ReviewDraftInput, ReviewSide } from '@agentry/shared';
import { useToast } from '@agentry/ui/components/Toast';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import type { ParsedDiff } from '../../lib/diff';
import { draftsByLine, draftsInFile, newLineText, type LineAnchor } from '../../lib/review-lines';
import { lineKey, lineLabel } from '../../lib/reviews';
import { ReviewComposer } from './ReviewComposer';

// The person's draft review on the diff (design system §5, DesktopRevisionHilosNota and
// MobileRevisionHilosNota): a note is a card under its line, dashed because it is not on the host
// yet, and the composer opens in the same place (a Sheet on a phone). The notes are rows on the
// server, so they survive a reload; nothing here reaches the host until the item page submits the
// review. A suggestion is the person's own text, drawn as code and never as markup.

/** The draft review of a change request; the item page reads the same key, so both stay in step */
export function useDraftReview(changeRequestId: string | undefined) {
  return useQuery({
    queryKey: keys.reviewDrafts(changeRequestId ?? ''),
    queryFn: ({ signal }) => api.reviewDrafts(changeRequestId!, { signal }),
    enabled: !!changeRequestId,
    retry: false,
  });
}

/** What a file's header says of the notes the person has left in it: `2 notes` */
export function DraftsChip({ count }: { count: number }) {
  const { t } = useTranslation('changes');
  if (count === 0) return null;
  return (
    <span className="chip changes-drafts-chip" title={t('draft.chipTitle')}>
      <MessageSquare {...ICON_SM} />
      {t('draft.chip', { count })}
    </span>
  );
}

function DraftCard({ draft, onEdit, onRemove, removing }: { draft: ReviewDraft; onEdit: () => void; onRemove: () => void; removing: boolean }) {
  const { t } = useTranslation('changes');
  const where = `${draft.path ?? ''}${lineLabel(draft.line, draft.startLine) ?? ''}`;
  const lines = draft.body.replace(/\n$/, '').split('\n');
  return (
    <article className="rt draft" aria-label={t('draft.label', { where })}>
      <div className="rt-head">
        <span className="badge">{t('draft.badge')}</span>
        {draft.suggestion && <span className="badge badge-suggest">{t('draft.suggestion')}</span>}
        <span className="where">{lineLabel(draft.line, draft.startLine)}</span>
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label={t('draft.edit', { where })} onClick={onEdit}>
          <Pencil {...ICON_SM} />
        </button>
        <button type="button" className="icon-btn" aria-label={t('draft.remove', { where })} disabled={removing} onClick={onRemove}>
          <Trash2 {...ICON_SM} />
        </button>
      </div>
      {draft.suggestion ? (
        <div className="rt-sugg">
          {lines.map((text, i) => (
            <div key={i} className="rt-sugg-row add">
              <i aria-hidden>+</i>
              <code>{text}</code>
            </div>
          ))}
        </div>
      ) : (
        <div className="rt-comment">
          <div className="rt-main">
            <p className="rt-body rt-plain">{draft.body}</p>
          </div>
        </div>
      )}
    </article>
  );
}

/** A note being written or edited; its place is a line of the file */
type Composing = { at: LineAnchor; draft?: ReviewDraft };

/**
 * What a file adds to its diff for the draft review: the notes under their lines, the composer
 * where the person is writing, and the gutter's "+" that opens one. `diff` is what a suggestion is
 * started from. Without a change request there is nothing to add a note to, and nothing is offered.
 */
export function useDraftNotes({ changeRequestId, path, diff }: { changeRequestId: string | undefined; path: string; diff: ParsedDiff | null }) {
  const { t } = useTranslation('changes');
  const toast = useToast();
  const queryClient = useQueryClient();
  const drafts = useDraftReview(changeRequestId);
  const [composing, setComposing] = useState<Composing | null>(null);
  const list = drafts.data;
  const byLine = useMemo(() => draftsByLine(list ?? [], path), [list, path]);
  const count = useMemo(() => draftsInFile(list ?? [], path), [list, path]);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.reviewDrafts(changeRequestId ?? '') });

  const save = useMutation({
    mutationFn: async ({ inputs, draft }: { inputs: ReviewDraftInput[]; draft?: ReviewDraft }) => {
      const id = changeRequestId ?? '';
      for (const input of inputs) await (draft ? api.updateReviewDraft(id, draft.id, input) : api.addReviewDraft(id, input));
    },
    onSuccess: () => {
      setComposing(null);
      refresh();
    },
    onError: (err) => toast.error(t('draft.saveFailed'), err),
  });
  const remove = useMutation({
    mutationFn: (draftId: string) => api.deleteReviewDraft(changeRequestId ?? '', draftId),
    onSuccess: refresh,
    onError: (err) => toast.error(t('draft.removeFailed'), err),
  });

  const onAddNote = useCallback((side: ReviewSide, line: number) => setComposing({ at: { side, line } }), []);
  const extra = (side: ReviewSide, line: number): ReactNode => {
    const key = lineKey(side, line);
    const here = byLine.get(key) ?? [];
    const open = composing && composing.at.side === side && composing.at.line === line ? composing : null;
    if (here.length === 0 && !open) return null;
    return (
      <>
        {here.map((draft) =>
          open?.draft?.id === draft.id ? null : (
            <DraftCard key={draft.id} draft={draft} removing={remove.isPending} onEdit={() => setComposing({ at: { side, line }, draft })} onRemove={() => remove.mutate(draft.id)} />
          ),
        )}
        {open && (
          <ReviewComposer
            target={{ path, side, line, startLine: open.draft?.startLine ?? null }}
            lineText={newLineText(diff, line)}
            draft={open.draft}
            busy={save.isPending}
            onSave={(inputs) => save.mutate({ inputs, draft: open.draft })}
            onCancel={() => setComposing(null)}
          />
        )}
      </>
    );
  };
  // Nothing is offered where there is no change request to hold the note
  if (!changeRequestId) return { extra: undefined, onAddNote: undefined, count: 0 };
  return { extra, onAddNote, count };
}
