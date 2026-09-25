import type { UsageBucket, UsagePoint, UsageSlice } from '@agentry/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUsageBreakdown, useUsageSeries, type UsageRange } from '../api';
import { BarChart } from '../components/BarChart';
import { ProjectExportCard } from '../components/ProjectExport';
import { Collapsible, DatePicker } from '../components/controls';
import { Card, Empty, ErrorBox, PageHeader, Segmented, Skeleton } from '../components/ui';
import { formatCost, formatNumber } from '../lib/format';
import { intlLocale } from '../i18n/language';
import { useProjectScope } from '../lib/project-scope';
import { bucketFor, customRangeError, metricValue, parseDay, presetRange, sumMetric, topSlices, toDay, type RangePreset, type UsageMetric } from '../lib/usage-view';
import '../insights.css';

const PRESETS: readonly RangePreset[] = ['7d', '30d', '90d', 'all', 'custom'];
const METRICS: readonly UsageMetric[] = ['cost', 'tokens', 'chats'];
const SLICES_SHOWN = 8;

/** A day as the reader writes it. `at` is `YYYY-MM-DD`, and is read as that calendar day whatever the browser's zone. */
function dayLabel(at: string, style: 'short' | 'long' | 'weekday' = 'short'): string {
  const date = parseDay(at);
  if (!date) return at;
  const options: Intl.DateTimeFormatOptions = style === 'long' ? { dateStyle: 'medium' } : style === 'weekday' ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(intlLocale(), options).format(date);
}

/** The period with the most of `metric`, if any period has some. */
function peakOf(points: readonly UsagePoint[], metric: UsageMetric): UsagePoint | null {
  let peak: UsagePoint | null = null;
  for (const point of points) {
    const value = metricValue(point, metric);
    if (value !== null && value > 0 && (peak === null || value > (metricValue(peak, metric) ?? 0))) peak = point;
  }
  return peak;
}

/** A cost that was never reported reads "not reported", never $0.00. */
function useFormatMetric() {
  const { t } = useTranslation('usage');
  return (metric: UsageMetric, value: number | null): string => {
    if (value === null) return t('notReported');
    return metric === 'cost' ? formatCost(value) : formatNumber(value);
  };
}

/** Cost and tokens over time, and what each project and each model accounts for. Every figure is the CLI's own. */
export function Usage() {
  const { t } = useTranslation(['usage', 'common']);
  // The page's figures cover every project; the export is offered for the one picked in the sidebar
  const { project } = useProjectScope();
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [applied, setApplied] = useState<UsageRange>(() => presetRange('30d', new Date()));
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [wantedBucket, setWantedBucket] = useState<UsageBucket>('day');
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const [active, setActive] = useState<number | null>(null);
  const fmt = useFormatMetric();

  const bucket = bucketFor(applied, wantedBucket);
  const series = useUsageSeries(applied, bucket);
  const breakdown = useUsageBreakdown(applied);

  const customError = preset === 'custom' ? customRangeError(custom.from, custom.to) : null;

  const pickPreset = (next: RangePreset) => {
    setPreset(next);
    setActive(null);
    if (next !== 'custom') setApplied(presetRange(next, new Date()));
  };
  const editCustom = (patch: Partial<typeof custom>) => {
    const next = { ...custom, ...patch };
    setCustom(next);
    setActive(null);
    // Only a range that can be asked for is asked for; until then the last good one stays on screen
    if (customRangeError(next.from, next.to) === null) setApplied({ from: next.from, to: next.to });
  };

  const points = series.data?.points ?? [];
  const totals = { cost: sumMetric(points, 'cost'), tokens: sumMetric(points, 'tokens') };
  const chatCount = (breakdown.data?.byProject ?? []).reduce((sum, slice) => sum + slice.chats, 0);
  const anyData = points.some((p) => p.tokens > 0 || p.chats > 0 || p.costUsd !== null);
  const peak = peakOf(points, metric);
  const metricTotal = sumMetric(points, metric);
  const peakValue = peak ? metricValue(peak, metric) : null;
  const peakShare = peakValue !== null && metricTotal ? formatNumber(peakValue / metricTotal, { style: 'percent' }) : '';
  const first = points[0];
  const last = points[points.length - 1];

  const pickMetric = (next: UsageMetric) => {
    setMetric(next);
    setActive(null);
  };
  const tileValue = (value: UsageMetric): string => (value === 'chats' ? formatNumber(chatCount) : fmt(value, totals[value]));
  const tileSub = (value: UsageMetric): string => {
    if (value === 'cost') return first && last ? t('tiles.costSub', { from: dayLabel(first.at), to: dayLabel(last.at) }) : '';
    if (value === 'tokens') return chatCount > 0 && totals.tokens ? t('tiles.tokensSub', { n: formatNumber(totals.tokens / chatCount, { notation: 'compact', maximumFractionDigits: 1 }) }) : '';
    return t('tiles.chatsSub');
  };

  return (
    <>
      <PageHeader
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        actions={
          <Segmented<RangePreset> label={t('range.label')} value={preset} onChange={pickPreset} options={PRESETS.map((value) => ({ value, label: t(`range.${value}`) }))} />
        }
      />
      {preset === 'custom' && (
        <div className="filter-bar" role="group" aria-label={t('range.custom')}>
          <div className="field usage-date">
            <span className="field-label" aria-hidden>
              {t('range.from')}
            </span>
            <DatePicker aria-label={t('range.from')} value={custom.from} onChange={(from) => editCustom({ from })} max={parseDay(custom.to) ? custom.to : undefined} invalid={custom.from !== '' && parseDay(custom.from) === null} />
          </div>
          <div className="field usage-date">
            <span className="field-label" aria-hidden>
              {t('range.to')}
            </span>
            <DatePicker
              aria-label={t('range.to')}
              value={custom.to}
              onChange={(to) => editCustom({ to })}
              min={parseDay(custom.from) ? custom.from : undefined}
              placeholder={toDay(new Date())}
              invalid={custom.to !== '' && parseDay(custom.to) === null}
            />
          </div>
          {customError && (custom.from !== '' || custom.to !== '') && (
            <span className="muted small" role="status">
              {customError === 'order' ? t('range.order') : t('range.invalid')}
            </span>
          )}
        </div>
      )}
      <ErrorBox error={series.error ?? breakdown.error} />

      {/* The tiles are the metric picker too: the one pressed is what the chart and the breakdowns show */}
      <div className="usage-tiles" role="group" aria-label={t('over.metric')}>
        {METRICS.map((value) => (
          <MetricTile key={value} label={t(`tiles.${value}`)} value={tileValue(value)} sub={tileSub(value)} pending={value === 'chats' ? breakdown.isPending : series.isPending} on={metric === value} onPick={() => pickMetric(value)} />
        ))}
        <div className="usage-tile usage-tile-peak">
          <span className="usage-tile-label">{t(bucket === 'week' ? 'tiles.peakWeek' : 'tiles.peakDay')}</span>
          <span className="usage-tile-value">{series.isPending ? <TileSkeleton /> : peak ? fmt(metric, metricValue(peak, metric)) : t('tiles.noPeak')}</span>
          <span className="usage-tile-sub">{!series.isPending && peak ? t('tiles.peakSub', { period: dayLabel(peak.at, 'weekday'), share: peakShare }) : '\u00a0'}</span>
        </div>
      </div>

      <Card
        className="usage-over"
        title={t('over.per', { metric: t(`metrics.${metric}`), bucket: t(`buckets.${bucket}`).toLowerCase() })}
        actions={
          <span className="toolbar">
            <Segmented<UsageBucket>
              label={t('over.bucket')}
              value={bucket}
              onChange={setWantedBucket}
              options={(['day', 'week'] as const).map((value) => ({ value, label: t(`buckets.${value}`) }))}
            />
          </span>
        }
      >
        {series.isPending ? (
          <Skeleton rows={4} height={30} />
        ) : !anyData ? (
          <Empty illustration="no-results" size="sm" title={t('over.emptyTitle')}>
            {t('over.emptyBody')}
          </Empty>
        ) : (
          <OverTime points={points} metric={metric} bucket={bucket} active={active} onActive={setActive} />
        )}
        <p className="usage-note">{t('over.note')}</p>
      </Card>

      <div className="grid-2 usage-slices">
        <SliceCard kind="project" title={t('byProject.title')} what={t('byProject.what')} slices={breakdown.data?.byProject} pending={breakdown.isPending} metric={metric} />
        <SliceCard kind="model" title={t('byModel.title')} what={t('byModel.what')} slices={breakdown.data?.byModel} pending={breakdown.isPending} metric={metric} />
      </div>
      {project && <ProjectExportCard project={project} wholeProject />}
    </>
  );
}

function TileSkeleton() {
  return <span className="skeleton" style={{ display: 'block', height: 30, width: 110 }} aria-hidden />;
}

function MetricTile({ label, value, sub, pending, on, onPick }: { label: string; value: string; sub: string; pending: boolean; on: boolean; onPick: () => void }) {
  return (
    <button type="button" className={`usage-tile usage-tile-metric ${on ? 'grad-border is-on' : ''}`} aria-pressed={on} onClick={onPick}>
      <span className="usage-tile-label">{label}</span>
      <span className={`usage-tile-value ${on && !pending ? 'grad-text' : ''}`}>{pending ? <TileSkeleton /> : value}</span>
      <span className="usage-tile-sub">{pending || !sub ? '\u00a0' : sub}</span>
    </button>
  );
}

function OverTime({
  points,
  metric,
  bucket,
  active,
  onActive,
}: {
  points: readonly UsagePoint[];
  metric: UsageMetric;
  bucket: UsageBucket;
  active: number | null;
  onActive: (index: number | null) => void;
}) {
  const { t } = useTranslation('usage');
  const fmt = useFormatMetric();
  const periodLabel = (at: string) => (bucket === 'week' ? t('weekOf', { day: dayLabel(at, 'long') }) : dayLabel(at, 'long'));
  const bars = points.map((point) => ({ key: point.at, label: dayLabel(point.at), value: metricValue(point, metric) }));

  const total = sumMetric(points, metric);
  const peak = peakOf(points, metric);
  const first = points[0];
  const last = points[points.length - 1];
  const description = [
    t('chart.summary', { metric: t(`metrics.${metric}`), count: points.length, bucket: t(`buckets.${bucket}`).toLowerCase(), from: first ? dayLabel(first.at, 'long') : '', to: last ? dayLabel(last.at, 'long') : '' }),
    total === null ? t('chart.noFigures') : t('chart.total', { total: fmt(metric, total) }),
    peak ? t('chart.peak', { value: fmt(metric, metricValue(peak, metric)), period: periodLabel(peak.at) }) : '',
  ]
    .filter(Boolean)
    .join(' ');

  const others = METRICS.filter((m) => m !== metric);
  const figure = (point: UsagePoint, m: UsageMetric) =>
    m === 'cost' ? fmt('cost', point.costUsd) : m === 'tokens' ? t('readout.tokens', { n: formatNumber(point.tokens) }) : t('readout.chats', { count: point.chats });
  const tip = (index: number) => {
    const point = points[index];
    if (!point) return null;
    return (
      <>
        <span className="chart-tip-period">{periodLabel(point.at)}</span>
        <strong className="chart-tip-value">{figure(point, metric)}</strong>
        <span className="chart-tip-rest">{others.map((m) => figure(point, m)).join(' · ')}</span>
      </>
    );
  };

  return (
    <div className="stack">
      <BarChart
        bars={bars}
        label={t('chart.label', { metric: t(`metrics.${metric}`) })}
        description={description}
        active={active}
        onActive={onActive}
        tip={tip}
        integer={metric !== 'cost'}
        formatAxis={(value) => (metric === 'cost' ? formatCost(value) : formatNumber(value, { notation: 'compact' }))}
      />
      <Collapsible title={t('table.show')}>
        <div className="table-wrap" tabIndex={0} role="region" aria-label={t('table.label')}>
          <table className="table usage-table">
            <caption className="sr-only">{t('table.caption', { bucket: t(`buckets.${bucket}`).toLowerCase() })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('table.period')}</th>
                <th scope="col" className="num">{t('metrics.cost')}</th>
                <th scope="col" className="num">{t('metrics.tokens')}</th>
                <th scope="col" className="num">{t('metrics.chats')}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.at}>
                  <th scope="row">{periodLabel(point.at)}</th>
                  <td className="num">{fmt('cost', point.costUsd)}</td>
                  <td className="num">{fmt('tokens', point.tokens)}</td>
                  <td className="num">{fmt('chats', point.chats)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Collapsible>
    </div>
  );
}

/**
 * Horizontal bars, drawn as HTML so every row carries its name and its figure as text: nothing
 * depends on the colour of a bar, and a screen reader reads a list.
 */
function SliceCard({ kind, title, what, slices, pending, metric }: { kind: 'project' | 'model'; title: string; what: string; slices: readonly UsageSlice[] | undefined; pending: boolean; metric: UsageMetric }) {
  const { t } = useTranslation('usage');
  const fmt = useFormatMetric();
  // `loose` and `unknown` are the API's keys for "no project" and "no model"; the reader gets words
  const sliceLabel = (slice: UsageSlice) => (kind === 'project' && slice.key === 'loose' ? t('looseChats') : kind === 'model' && slice.key === 'unknown' ? t('unknownModel') : slice.label);
  const { shown, rest } = topSlices(slices ?? [], metric, SLICES_SHOWN);
  const rows: Array<{ key: string; label: string; slice: UsageSlice }> = shown.map((slice) => ({ key: slice.key, label: sliceLabel(slice), slice }));
  if (rest) rows.push({ key: '__rest__', label: t('other', { n: formatNumber((slices?.length ?? 0) - shown.length) }), slice: rest });
  const max = Math.max(0, ...rows.map((row) => metricValue(row.slice, metric) ?? 0));

  return (
    <Card title={title}>
      {pending ? (
        <Skeleton rows={4} height={22} />
      ) : rows.length === 0 ? (
        <p className="muted">{t('noSlices')}</p>
      ) : (
        <ul className="slice-list" aria-label={what}>
          {rows.map((row) => {
            const value = metricValue(row.slice, metric);
            return (
              <li key={row.key} className={`slice ${value ? '' : 'is-empty'}`}>
                <span className="slice-name ellipsis">{row.label}</span>
                <span className="slice-value">{fmt(metric, value)}</span>
                <span className="slice-track" aria-hidden>
                  <span className="slice-fill" style={{ width: `${max > 0 && value ? Math.max(0.6, (value / max) * 100) : 0}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {kind === 'model' && metric === 'cost' && <p className="muted small">{t('byModel.note')}</p>}
    </Card>
  );
}

