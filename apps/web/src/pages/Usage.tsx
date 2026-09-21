import type { UsageBucket, UsagePoint, UsageSlice } from '@agentry/shared';
import { ChartColumn } from 'lucide-react';
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
function dayLabel(at: string, long = false): string {
  const date = parseDay(at);
  if (!date) return at;
  return new Intl.DateTimeFormat(intlLocale(), long ? { dateStyle: 'medium' } : { month: 'short', day: 'numeric' }).format(date);
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

  return (
    <>
      <PageHeader
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        actions={
          <span className="toolbar">
            <Segmented<UsageMetric> label={t('over.metric')} value={metric} onChange={setMetric} options={METRICS.map((value) => ({ value, label: t(`metrics.${value}`) }))} />
            <Segmented<RangePreset> label={t('range.label')} value={preset} onChange={pickPreset} options={PRESETS.map((value) => ({ value, label: t(`range.${value}`) }))} />
          </span>
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

      <div className="usage-tiles">
        <Tile label={t('tiles.cost')} value={series.isPending ? null : fmt('cost', totals.cost)} pending={series.isPending} />
        <Tile label={t('tiles.tokens')} value={series.isPending ? null : fmt('tokens', totals.tokens)} pending={series.isPending} />
        <Tile label={t('tiles.chats')} value={breakdown.isPending ? null : formatNumber(chatCount)} pending={breakdown.isPending} />
      </div>

      <Card
        title={t('over.title')}
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
          <Empty icon={ChartColumn} title={t('over.emptyTitle')}>
            {t('over.emptyBody')}
          </Empty>
        ) : (
          <OverTime points={points} metric={metric} bucket={bucket} active={active} onActive={setActive} />
        )}
        <p className="muted small">{t('over.note')}</p>
      </Card>

      <div className="grid-2 usage-slices">
        <SliceCard kind="project" title={t('byProject.title')} what={t('byProject.what')} slices={breakdown.data?.byProject} pending={breakdown.isPending} metric={metric} />
        <SliceCard kind="model" title={t('byModel.title')} what={t('byModel.what')} slices={breakdown.data?.byModel} pending={breakdown.isPending} metric={metric} />
      </div>
      {project && <ProjectExportCard project={project} wholeProject />}
    </>
  );
}

function Tile({ label, value, pending }: { label: string; value: string | null; pending: boolean }) {
  return (
    <div className="usage-tile">
      <div className="usage-tile-label">{label}</div>
      <div className="usage-tile-value">{pending ? <span className="skeleton" style={{ display: 'block', height: 26, width: 90 }} aria-hidden /> : value}</div>
    </div>
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
  const periodLabel = (at: string) => (bucket === 'week' ? t('weekOf', { day: dayLabel(at, true) }) : dayLabel(at, true));
  const bars = points.map((point) => ({ key: point.at, label: dayLabel(point.at), value: metricValue(point, metric) }));

  const total = sumMetric(points, metric);
  let peak: UsagePoint | null = null;
  for (const point of points) {
    const value = metricValue(point, metric);
    if (value !== null && value > 0 && (peak === null || value > (metricValue(peak, metric) ?? 0))) peak = point;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const description = [
    t('chart.summary', { metric: t(`metrics.${metric}`), count: points.length, bucket: t(`buckets.${bucket}`).toLowerCase(), from: first ? dayLabel(first.at, true) : '', to: last ? dayLabel(last.at, true) : '' }),
    total === null ? t('chart.noFigures') : t('chart.total', { total: fmt(metric, total) }),
    peak ? t('chart.peak', { value: fmt(metric, metricValue(peak, metric)), period: periodLabel(peak.at) }) : '',
  ]
    .filter(Boolean)
    .join(' ');

  const shown = active === null ? undefined : points[active];

  return (
    <div className="stack">
      {/* The hovered bar is read out here, so its figure is text and not a position on a scale */}
      <div className="chart-readout" aria-hidden>
        {shown ? (
          <>
            <strong>{periodLabel(shown.at)}</strong>
            <span>{fmt('cost', shown.costUsd)}</span>
            <span>{t('readout.tokens', { n: formatNumber(shown.tokens) })}</span>
            <span>{t('readout.chats', { count: shown.chats })}</span>
          </>
        ) : (
          <span className="muted">{t('readout.hint')}</span>
        )}
      </div>
      <BarChart
        bars={bars}
        label={t('chart.label', { metric: t(`metrics.${metric}`) })}
        description={description}
        active={active}
        onActive={onActive}
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
              <li key={row.key} className="slice">
                <span className="slice-name ellipsis">{row.label}</span>
                <span className="slice-value">{fmt(metric, value)}</span>
                <span className="slice-track" aria-hidden>
                  <span className="slice-fill" style={{ width: `${max > 0 && value ? Math.max(1, (value / max) * 100) : 0}%` }} />
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

