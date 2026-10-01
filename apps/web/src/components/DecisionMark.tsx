import type { DecisionFeedback, DecisionRecord, DecisionSubjectKind } from '@agentry/shared';
import * as RadixPopover from '@radix-ui/react-popover';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useMemo, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { formatCost, formatNumber, timeAgo } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { answerLines, type AnswerLine } from '../pages/config/decisions/model';
import { LAYER_ATTR } from '@agentry/ui/components/controls/layer';
import { Sheet } from '@agentry/ui/components/controls/Sheet';
import { ICON_SM } from '@agentry/ui/components/icons';
import { ErrorBox } from '@agentry/ui/components/ui';

/** Enough to cover the subjects on a board or a list: the newest visible decisions of one kind. */
const RECENT = 200;

/** The ids hold dots, which i18next reads as nesting: `flow.refine-needed` is `flowRefineNeeded` (the Decisions tab's keys). */
const pointKey = (id: string) => id.replace(/[.-](\w)/g, (_, c: string) => c.toUpperCase());

const score = (value: number | null) => (value === null ? '—' : formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/**
 * The newest decision that changed something a person sees, per subject id, for one kind of
 * subject. One request per kind however many marks a screen shows: react-query shares it.
 */
export function useVisibleDecisions(subjectKind: DecisionSubjectKind): Map<string, DecisionRecord> {
  const query = { subjectKind, visible: true, limit: RECENT } as const;
  const recent = useQuery({ queryKey: keys.decisionsRecent(query), queryFn: () => api.decisions(query), staleTime: 15_000 });
  return useMemo(() => {
    const bySubject = new Map<string, DecisionRecord>();
    // Newest first: the first row of a subject is the one that stands
    for (const row of recent.data?.items ?? []) if (row.subjectId && !bySubject.has(row.subjectId)) bySubject.set(row.subjectId, row);
    return bySubject;
  }, [recent.data]);
}

/** The mark of the decision on one subject, or nothing when none changed what the person sees. */
export function DecisionMark({ subjectKind, subjectId }: { subjectKind: DecisionSubjectKind; subjectId: string }) {
  const decision = useVisibleDecisions(subjectKind).get(subjectId);
  return decision ? <DecisionMarkOf decision={decision} /> : null;
}

/** The mark sits on rows and cards that open something when clicked: it must not open them too. */
const keep = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * "decided · 0.93", or "suggested" when there is no confidence (the CLI has none). A decision is
 * not a status, so it takes no status colour: the word carries it. It opens the answer in a
 * popover, and in a sheet on a phone.
 */
export function DecisionMarkOf({ decision }: { decision: DecisionRecord }) {
  const { t } = useTranslation('decisions');
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => answerLines(decision), [decision]);
  const said = summaryOf(lines, { yes: t('history.yes'), no: t('history.no') });
  const suggested = decision.confidence === null;
  const face = suggested ? t('mark.suggested') : t('mark.decided', { confidence: score(decision.confidence) });
  const label = t(suggested ? 'mark.labelSuggested' : 'mark.labelDecided', { confidence: score(decision.confidence), answer: said });
  const title = t(`mark.titles.${pointKey(decision.point)}`, { defaultValue: decision.point });
  const body = <DecisionAnswer decision={decision} lines={lines} said={said} />;

  const face$ = <span className="decided-face">{face}</span>;
  if (narrow) {
    return (
      <>
        <button
          type="button"
          className="decided"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          data-decision={decision.id}
          onClick={(event: MouseEvent) => {
            keep(event);
            setOpen(true);
          }}
        >
          {face$}
        </button>
        <Sheet open={open} onOpenChange={setOpen} title={title} description={decision.point}>
          <div className="decided-sheet">{body}</div>
        </Sheet>
      </>
    );
  }
  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <button type="button" className="decided" aria-haspopup="dialog" aria-expanded={open} aria-label={label} data-decision={decision.id} onClick={keep} onKeyDown={keep}>
          {face$}
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content {...LAYER_ATTR} className="decided-pop" role="dialog" aria-label={t('mark.popoverLabel')} align="start" sideOffset={6} collisionPadding={8}>
          <div className="decided-head">
            <div className="col">
              <h2 className="decided-title">{title}</h2>
              <span className="mono decided-point">{decision.point}</span>
            </div>
            <RadixPopover.Close asChild>
              <button type="button" className="icon-btn" aria-label={t('mark.close')}>
                <X {...ICON_SM} />
              </button>
            </RadixPopover.Close>
          </div>
          {body}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** The answer in a few words: one value per question that was answered. */
function summaryOf(lines: AnswerLine[], words: { yes: string; no: string }): string {
  return lines.map((line) => (typeof line.value === 'boolean' ? (line.value ? words.yes : words.no) : line.value)).join(' · ');
}

function DecisionAnswer({ decision, lines, said }: { decision: DecisionRecord; lines: AnswerLine[]; said: string }) {
  const { t } = useTranslation('decisions');
  const qc = useQueryClient();
  const rate = useMutation({
    mutationFn: (feedback: DecisionFeedback) => api.decisionFeedback(decision.id, feedback),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['decisions'] }),
  });
  const rated = rate.data?.feedback ?? decision.feedback;
  const modeWord = t(`points.modes.${decision.mode}`);
  const result = decision.outcome
    ? `${decision.outcome.summary}${decision.resolvedAt ? ` · ${timeAgo(decision.resolvedAt)}` : ''}`
    : rated
      ? t(`history.feedback.${rated}`)
      : t('mark.pending');

  return (
    <>
      {decision.questions.map((question) => (
        <div key={question.id} className="decided-block">
          <span className="section-label">{t('history.question')}</span>
          <p>{question.question}</p>
        </div>
      ))}
      {said && (
        <div className="decided-block">
          <span className="section-label">{t('mark.answer')}</span>
          <p className="is-answer">{said}</p>
        </div>
      )}
      {lines.map((line) =>
        line.bars.length > 0 ? (
          <div key={line.question} className="decided-block">
            <span className="section-label">{t('history.probabilities')}</span>
            <div className="decided-odds">
              {line.bars.map((bar, index) => (
                <div key={bar.id} className={`decided-odd ${index === 0 ? 'is-chosen' : ''}`.trim()}>
                  <span className="ellipsis">{typeof line.value === 'boolean' ? t(bar.id === 'yes' ? 'history.yes' : 'history.no') : bar.label}</span>
                  <span className="meter-track meter-thin" aria-hidden>
                    <span className="meter-fill" style={{ width: `${Math.round(bar.probability * 100)}%` }} />
                  </span>
                  <span className="t-num">{score(bar.probability)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null,
      )}
      <dl className="decided-meta">
        <dt>{t('history.facts.provider')}</dt>
        <dd>{decision.provider === 'jev' ? t('engine.jev') : t('engine.cli')}</dd>
        <dt>{t('history.facts.mode')}</dt>
        <dd>{decision.threshold === null ? modeWord : t('mark.modeThreshold', { mode: modeWord.toLowerCase(), threshold: score(decision.threshold) })}</dd>
        <dt>{t('history.facts.cost')}</dt>
        <dd>
          {decision.costUsd === null ? '—' : formatCost(decision.costUsd)} · {formatNumber(decision.latencyMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s
        </dd>
        <dt>{t('history.facts.result')}</dt>
        <dd>{result}</dd>
      </dl>
      <ErrorBox error={rate.error} />
      <div className="decided-foot">
        <span className="ask">{t('mark.ask')}</span>
        <button type="button" className="btn btn-small" aria-pressed={rated === 'useful'} disabled={rate.isPending} onClick={() => rate.mutate('useful')}>
          <ThumbsUp {...ICON_SM} /> {t('history.useful')}
        </button>
        <button type="button" className="btn btn-small" aria-pressed={rated === 'not_useful'} disabled={rate.isPending} onClick={() => rate.mutate('not_useful')}>
          <ThumbsDown {...ICON_SM} /> {t('history.notUseful')}
        </button>
        <Link to="/settings?tab=decisions">{t('mark.history')}</Link>
      </div>
    </>
  );
}
