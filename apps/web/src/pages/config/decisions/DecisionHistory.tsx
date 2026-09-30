import type { DecisionFeedback, DecisionFilter, DecisionPointId, DecisionPointInfo, DecisionRecord } from '@agentry/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ThumbsDown, ThumbsUp, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { Select } from '@agentry/ui/components/controls';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox, Skeleton } from '@agentry/ui/components/ui';
import { formatCost, formatDateTime, formatNumber, timeAgo } from '@agentry/ui/lib/format';
import { answerLines, outcomeOf, type AnswerLine, type HistoryOutcome } from './model';

const PAGE = 20;
const ALL = '';

interface Filters {
  point: string;
  projectId: string;
  provider: string;
  mode: string;
  status: string;
}

const NO_FILTERS: Filters = { point: ALL, projectId: ALL, provider: ALL, mode: ALL, status: ALL };

/** The query the API takes: an empty filter is left out, never sent as an empty string. */
function filterOf(filters: Filters): DecisionFilter {
  return {
    ...(filters.point ? { point: filters.point as DecisionPointId } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.provider === 'cli' || filters.provider === 'jev' ? { provider: filters.provider } : {}),
    ...(filters.mode === 'shadow' || filters.mode === 'active' ? { mode: filters.mode } : {}),
    ...(filters.status === 'answered' || filters.status === 'unavailable' ? { status: filters.status } : {}),
  };
}

/**
 * The History section of Settings → Decisions: what each point was asked and answered, filterable,
 * with the person's word on it (D13). Rows are accumulating records, so the list is paged.
 */
export function DecisionHistory({ id, catalogue, days, focusPoint }: { id: string; catalogue: DecisionPointInfo[]; days: number | null; focusPoint: { point: DecisionPointId; n: number } | null }) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const filter = useMemo(() => filterOf(filters), [filters]);
  const filtered = Object.values(filters).some((value) => value !== ALL);

  // "See in History" on a point's metrics: filter by that point
  useEffect(() => {
    if (focusPoint) setFilters({ ...NO_FILTERS, point: focusPoint.point });
  }, [focusPoint]);

  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api.projects() });
  const history = useInfiniteQuery({
    queryKey: keys.decisionHistory(filter),
    queryFn: ({ pageParam }) => api.decisions({ ...filter, limit: PAGE, cursor: pageParam }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = history.data?.pages.flatMap((page) => page.items) ?? [];
  const complete = history.data !== undefined && !history.hasNextPage;
  const projectName = (projectId: string | null) => (projectId ? (projects.data?.find((p) => p.id === projectId)?.name ?? projectId) : null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['decisions', 'history'] });
    void queryClient.invalidateQueries({ queryKey: ['decisions', 'stats'] });
    void queryClient.invalidateQueries({ queryKey: ['decisions', 'recent'] });
  };
  const clear = useMutation({
    mutationFn: () => api.clearDecisions(filter),
    onSuccess: (result) => {
      setConfirming(false);
      setOpen(null);
      refresh();
      toast.success(t('history.cleared', { count: result.deleted }));
    },
  });

  const set = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOpen(null);
    setConfirming(false);
  };
  const all = (label: string) => ({ value: ALL, label });

  return (
    <section id={id} className="card dp-card" aria-labelledby="decisions-history-title">
      <div className="card-head">
        <h2 id="decisions-history-title">{t('history.title')}</h2>
        {days !== null && <span className="dp-card-sub">{t('history.sub', { days })}</span>}
      </div>
      <div className="dp-hist-filters">
        <Select
          aria-label={t('history.filters.point')}
          value={filters.point}
          onChange={(point) => set({ point })}
          options={[all(t('history.filters.allPoints')), ...catalogue.map((info) => ({ value: info.id as string, label: info.id }))]}
        />
        <Select
          aria-label={t('history.filters.project')}
          value={filters.projectId}
          onChange={(projectId) => set({ projectId })}
          options={[all(t('history.filters.allProjects')), ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))]}
        />
        <Select
          aria-label={t('history.filters.provider')}
          value={filters.provider}
          onChange={(provider) => set({ provider })}
          options={[all(t('history.filters.anyProvider')), { value: 'cli', label: t('engine.cli') }, { value: 'jev', label: t('engine.jev') }]}
        />
        <Select
          aria-label={t('history.filters.mode')}
          value={filters.mode}
          onChange={(mode) => set({ mode })}
          options={[all(t('history.filters.anyMode')), { value: 'shadow', label: t('points.modes.shadow') }, { value: 'active', label: t('points.modes.active') }]}
        />
        <Select
          aria-label={t('history.filters.status')}
          value={filters.status}
          onChange={(status) => set({ status })}
          options={[all(t('history.filters.anyStatus')), { value: 'answered', label: t('history.status.answered') }, { value: 'unavailable', label: t('history.status.unavailable') }]}
        />
        <span className="dp-hist-spacer" />
        {filtered && (
          <button type="button" className="btn btn-ghost btn-small" onClick={() => set(NO_FILTERS)}>
            {t('history.resetFilters')}
          </button>
        )}
        <button type="button" className="btn btn-danger btn-small" disabled={rows.length === 0 || clear.isPending} onClick={() => setConfirming(true)}>
          <Trash2 {...ICON_SM} /> {t('history.clear')}
        </button>
      </div>
      {confirming && (
        <div className="dp-confirm" role="alertdialog" aria-label={t('history.clearTitle')}>
          <TriangleAlert {...ICON} />
          <span className="grow">
            {/* A count is only true when every page is loaded: the API has no way to count without deleting */}
            {complete ? t('history.clearBodyCount', { count: rows.length, formatted: formatNumber(rows.length) }) : t('history.clearBody')}{' '}
            {filtered ? t('history.clearFiltered') : t('history.clearAll')} {t('history.clearWarning')}
          </span>
          <div className="dp-confirm-actions">
            <button type="button" className="btn btn-small" autoFocus onClick={() => setConfirming(false)}>
              {t('history.cancel')}
            </button>
            <button type="button" className="btn btn-small btn-danger-solid" disabled={clear.isPending} onClick={() => clear.mutate()}>
              {clear.isPending ? t('history.clearing') : complete ? t('history.confirmCount', { count: rows.length, formatted: formatNumber(rows.length) }) : t('history.confirm')}
            </button>
          </div>
        </div>
      )}
      <ErrorBox error={history.error ?? clear.error} />
      {history.isPending ? (
        <div className="dp-empty">
          <Skeleton rows={4} />
        </div>
      ) : rows.length === 0 ? (
        <p className="small muted dp-empty">{filtered ? t('history.noneFiltered') : t('history.none')}</p>
      ) : (
        <div role="table" aria-label={t('history.title')} className="dp-hist">
          <div role="row" className="dp-hist-head section-label">
            <span role="columnheader">{t('history.cols.when')}</span>
            <span role="columnheader">{t('history.cols.point')}</span>
            <span role="columnheader">{t('history.cols.provider')}</span>
            <span role="columnheader">{t('history.cols.answer')}</span>
            <span role="columnheader">{t('history.cols.confidence')}</span>
            <span role="columnheader">{t('history.cols.result')}</span>
            <span role="columnheader">{t('history.cols.rating')}</span>
          </div>
          {rows.map((row) => (
            <HistoryRow key={row.id} row={row} project={projectName(row.projectId)} open={open === row.id} onToggle={() => setOpen(open === row.id ? null : row.id)} onChanged={refresh} />
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <div className="dp-hist-foot">
          <span className="dp-card-sub">{t(complete ? 'history.shown' : 'history.shownMore', { count: rows.length, formatted: formatNumber(rows.length) })}</span>
          <span className="dp-hist-spacer" />
          {history.hasNextPage && (
            <button type="button" className="btn btn-small" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
              {history.isFetchingNextPage ? t('history.loading') : t('history.more')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const confidence = (value: number | null) => (value === null ? '—' : formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function HistoryRow({ row, project, open, onToggle, onChanged }: { row: DecisionRecord; project: string | null; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const { t } = useTranslation('decisions');
  const panel = useId();
  const outcome = outcomeOf(row);
  const lines = useMemo(() => answerLines(row), [row]);
  const first = lines[0];

  return (
    <>
      <div role="row" className={`dp-hist-row ${open ? 'open' : ''}`} data-decision={row.id}>
        <span role="cell" className="mono dp-when" title={formatDateTime(row.at)}>
          {timeAgo(row.at)}
        </span>
        <span role="cell" className="dp-cell dp-cell-point">
          <span className="mono ellipsis">{row.point}</span>
          <span className="dp-sub ellipsis">{project ?? '—'}</span>
        </span>
        <span role="cell" className="dp-cell dp-cell-provider">
          <span className="mono ellipsis">{row.model}</span>
          <span className="dp-sub">{t(`points.modes.${row.mode}`)}</span>
        </span>
        <span role="cell" className="dp-cell dp-cell-answer">
          {row.status === 'unavailable' ? (
            <span className="dp-unavailable">
              <span className="badge badge-warn">{t('history.status.unavailable')}</span>
              {row.unavailable && <span className="dp-sub">{t(`engine.reason.${row.unavailable}`)}</span>}
            </span>
          ) : (
            <span className="ellipsis">{first ? typeof first.value === 'boolean' ? t(first.value ? 'history.yes' : 'history.no') : first.value : '—'}</span>
          )}
        </span>
        <span role="cell" className="mono dp-conf">
          {confidence(row.confidence)}
        </span>
        <span role="cell" className="dp-result">
          {outcome === 'match' && <span className="dot dot-ok" aria-hidden />}
          {t(`history.outcome.${outcome}`)}
        </span>
        <span role="cell" className="dp-rating">
          {row.feedback && (
            <span className="dp-rated" role="img" aria-label={t(`history.feedback.${row.feedback}`)} title={t(`history.feedback.${row.feedback}`)}>
              {row.feedback === 'useful' ? <ThumbsUp {...ICON_SM} /> : <ThumbsDown {...ICON_SM} />}
            </span>
          )}
          <button
            type="button"
            className="icon-btn dp-toggle"
            aria-expanded={open}
            aria-controls={panel}
            aria-label={t(open ? 'history.hide' : 'history.show', { point: row.point })}
            onClick={onToggle}
          >
            <ChevronDown {...ICON_SM} className={open ? 'dp-chevron is-open' : 'dp-chevron'} />
          </button>
        </span>
      </div>
      {open && <AnswerPanel id={panel} row={row} lines={lines} outcome={outcome} onChanged={onChanged} />}
    </>
  );
}

function AnswerPanel({ id, row, lines, outcome, onChanged }: { id: string; row: DecisionRecord; lines: AnswerLine[]; outcome: HistoryOutcome; onChanged: () => void }) {
  const { t } = useTranslation('decisions');
  const rate = useMutation({ mutationFn: (feedback: DecisionFeedback) => api.decisionFeedback(row.id, feedback), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => api.deleteDecision(row.id), onSuccess: onChanged });

  return (
    <div className="dp-answer" id={id} role="region" aria-label={t('history.answerOf', { point: row.point })}>
      {row.status === 'unavailable' && <p className="small muted">{t('history.unavailableBody')}</p>}
      {row.questions.map((question) => (
        <div key={question.id} className="dp-answer-block">
          <span className="section-label">{t('history.question')}</span>
          <span className="dp-question">{question.question}</span>
        </div>
      ))}
      {lines.map((line) =>
        line.bars.length > 0 ? (
          <div key={line.question} className="dp-answer-block">
            <span className="section-label">{t('history.probabilities')}</span>
            {line.bars.map((bar) => (
              <div key={bar.id} className="dp-prob">
                <span className="ellipsis">{typeof line.value === 'boolean' ? t(bar.id === 'yes' ? 'history.yes' : 'history.no') : bar.label}</span>
                <span className="meter-track meter-thin" aria-hidden>
                  <span className="meter-fill" style={{ width: `${Math.round(bar.probability * 100)}%` }} />
                </span>
                <span>{confidence(bar.probability)}</span>
              </div>
            ))}
          </div>
        ) : null,
      )}
      <div className="dp-facts">
        <span className="dp-fact">
          <span>{t('history.facts.provider')}</span>
          <span>
            {row.provider} · {row.model}
          </span>
        </span>
        <span className="dp-fact">
          <span>{t('history.facts.mode')}</span>
          <span>{t(`points.modes.${row.mode}`)}</span>
        </span>
        {row.threshold !== null && (
          <span className="dp-fact">
            <span>{t('history.facts.threshold')}</span>
            <span>{confidence(row.threshold)}</span>
          </span>
        )}
        <span className="dp-fact">
          <span>{t('history.facts.latency')}</span>
          <span>{formatNumber(row.latencyMs / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s</span>
        </span>
        {row.costUsd !== null && (
          <span className="dp-fact">
            <span>{t('history.facts.cost')}</span>
            <span>{formatCost(row.costUsd)}</span>
          </span>
        )}
        <span className="dp-fact">
          <span>{t('history.facts.result')}</span>
          <span>{row.outcome ? `${row.outcome.summary}: ${t(`history.outcome.${outcome}`).toLowerCase()}` : t(`history.outcome.${outcome}`)}</span>
        </span>
      </div>
      <ErrorBox error={rate.error ?? remove.error} />
      <div className="dp-answer-actions">
        <button type="button" className="btn btn-small" aria-pressed={row.feedback === 'useful'} disabled={rate.isPending} onClick={() => rate.mutate('useful')}>
          <ThumbsUp {...ICON_SM} /> {t('history.useful')}
        </button>
        <button type="button" className="btn btn-small" aria-pressed={row.feedback === 'not_useful'} disabled={rate.isPending} onClick={() => rate.mutate('not_useful')}>
          <ThumbsDown {...ICON_SM} /> {t('history.notUseful')}
        </button>
        <span className="dp-hist-spacer" />
        <button type="button" className="btn btn-ghost btn-small" disabled={remove.isPending} onClick={() => remove.mutate()}>
          <Trash2 {...ICON_SM} /> {t('history.delete')}
        </button>
      </div>
    </div>
  );
}
