import type { ReviewDraft, ReviewDraftInput, ReviewSide } from '@agentry/shared';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet } from '@agentry/ui/components/controls';
import { ICON_SM } from '@agentry/ui/components/icons';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { lineLabel } from '../../lib/reviews';

/** Where a note is left: a line (or range) of a file, or the whole change request when `path` is null. */
export interface ReviewTarget {
  path: string | null;
  side: ReviewSide | null;
  line: number | null;
  startLine: number | null;
}

export interface ReviewComposerProps {
  target: ReviewTarget;
  /** The current text of the line (or lines) on the head side: what a suggestion starts from */
  lineText?: string;
  /** The note being edited; a new one when absent */
  draft?: ReviewDraft;
  busy?: boolean;
  /** One input per thing the person wrote: the note, and the suggestion when they asked for one */
  onSave: (inputs: ReviewDraftInput[]) => void;
  onCancel: () => void;
}

/** A suggestion replaces lines of the new file: it needs a line, and the head side. */
const canSuggest = (target: ReviewTarget): boolean => target.path !== null && target.line !== null && (target.side ?? 'right') === 'right';

function Fields({
  target,
  draft,
  note,
  setNote,
  suggesting,
  setSuggesting,
  replacement,
  setReplacement,
}: {
  target: ReviewTarget;
  draft?: ReviewDraft;
  note: string;
  setNote: (value: string) => void;
  suggesting: boolean;
  setSuggesting: (value: boolean) => void;
  replacement: string;
  setReplacement: (value: string) => void;
}) {
  const { t } = useTranslation('reviews');
  const editingSuggestion = !!draft?.suggestion;
  const from = target.startLine !== null && target.line !== null ? Math.min(target.startLine, target.line) : target.line;
  const to = target.startLine !== null && target.line !== null ? Math.max(target.startLine, target.line) : target.line;
  return (
    <>
      {!editingSuggestion && (
        <textarea
          className="rc-note"
          rows={3}
          data-autofocus
          aria-label={t('composer.label')}
          placeholder={t('composer.placeholder')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      )}
      {(suggesting || editingSuggestion) && (
        <div className="rc-suggest">
          <div className="rc-suggest-head">
            <Sparkles {...ICON_SM} />
            <span>{t('composer.suggestion')}</span>
            <span className="grow" />
            <span className="rc-suggest-span">{from !== null && to !== null && from !== to ? t('composer.replacesRange', { from, to }) : t('composer.replaces', { line: to ?? '' })}</span>
          </div>
          <textarea
            className="rc-code"
            rows={Math.min(8, Math.max(2, replacement.split('\n').length))}
            data-autofocus={editingSuggestion ? true : undefined}
            aria-label={t('composer.replacement')}
            spellCheck={false}
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
          />
        </div>
      )}
      <div className="rc-tools">
        {canSuggest(target) && !editingSuggestion && !draft && (
          <button type="button" className="btn btn-small" aria-pressed={suggesting} onClick={() => setSuggesting(!suggesting)}>
            <Sparkles {...ICON_SM} />
            {t('composer.suggest')}
          </button>
        )}
        <span className="rc-private">{t('composer.private')}</span>
      </div>
    </>
  );
}

/**
 * The note a person leaves on a line of the diff, or on the whole change request: a text and, where
 * the line is on the head side, a suggestion of the lines that should replace it. It is saved into
 * the draft review, which goes to the host only when the person submits it. Inline under the line
 * on a desktop and a `Sheet` on a phone. Reference: DesktopRevisionHilosNota, MobileRevisionHilosNota.
 */
export function ReviewComposer({ target, lineText = '', draft, busy = false, onSave, onCancel }: ReviewComposerProps) {
  const { t } = useTranslation('reviews');
  const narrow = useMediaQuery(NARROW);
  const [note, setNote] = useState(draft && !draft.suggestion ? draft.body : '');
  const [suggesting, setSuggesting] = useState(!!draft?.suggestion);
  const [replacement, setReplacement] = useState(draft?.suggestion ? draft.body : lineText);

  const editingSuggestion = !!draft?.suggestion;
  const text = note.trim();
  const wantsSuggestion = suggesting || editingSuggestion;
  // A suggestion with nothing to replace the line with is only deleting it: ask for text when it is blank
  const ready = !editingSuggestion ? text.length > 0 || (wantsSuggestion && replacement.trim().length > 0) : replacement.length > 0;

  const place = { path: target.path, side: target.side, line: target.line, startLine: target.startLine };
  const save = () => {
    if (!ready || busy) return;
    const inputs: ReviewDraftInput[] = [];
    if (!editingSuggestion && text) inputs.push({ ...place, body: text, suggestion: false });
    if (wantsSuggestion) inputs.push({ ...place, body: replacement.replace(/\n$/, ''), suggestion: true });
    onSave(inputs);
  };

  const where = target.path === null ? t('title') : `${target.path}${lineLabel(target.line, target.startLine) ?? ''}`;
  const fields = (
    <Fields target={target} draft={draft} note={note} setNote={setNote} suggesting={suggesting} setSuggesting={setSuggesting} replacement={replacement} setReplacement={setReplacement} />
  );
  const actions = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        {t('composer.cancel')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={save}>
        {draft ? t('composer.save') : t('composer.add')}
      </button>
    </>
  );

  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onCancel()} side="bottom" title={draft ? t('composer.edit') : t('composer.new')} description={where} closeLabel={t('composer.close')} footer={<div className="rc-foot is-sheet">{actions}</div>}>
        <div className="rc-body">{fields}</div>
      </Sheet>
    );
  }
  return (
    <section className="rc grad-border" aria-label={draft ? t('composer.edit') : t('composer.new')}>
      <div className="rc-head">
        <span className="rc-where">{where}</span>
        <span className="grow" />
        <span className="rc-kind">{draft ? t('composer.edit') : t('composer.new')}</span>
      </div>
      <div className="rc-body">{fields}</div>
      <div className="rc-foot">{actions}</div>
    </section>
  );
}
