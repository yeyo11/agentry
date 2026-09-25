import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/format';
import { useWidth } from '../../lib/use-width';
import '../../usage-history.css';
import { pathOf, summarise, xOf, yOf, type AccountSeries, type Frame } from '../../lib/usage-history';

/*
 * Drawn from the readings with no library. A line is told apart by its dash and by the label at its
 * end as well as by its colour, so it reads in greyscale; the figures behind it are a table under
 * the chart, and the chart itself has a description a screen reader reads out.
 */

const HEIGHT = 240;
const FRAME_PAD = { left: 40, right: 44, top: 12, bottom: 26 };

/**
 * A line has a colour (`.usage-series-N` in usage-history.css, from tokens that hold their contrast
 * in both themes and mean no status) and a dash of its own.
 */
const SERIES = 6;
const DASHES = ['', '7 4', '2 4', '10 4 2 4', '4 2', '1 3'] as const;

export function UsageChart({
  series,
  from,
  to,
  threshold,
  labelOf,
}: {
  series: readonly AccountSeries[];
  from: number;
  to: number;
  /** The global auto-switch threshold, drawn as a reference line */
  threshold?: number;
  /** How an account is named in the legend */
  labelOf: (account: number) => string;
}) {
  const { t } = useTranslation('accountsConfig');
  const id = useId();
  const [box, width] = useWidth<HTMLElement>(320, 720);
  const frame: Frame = { from, to, width, height: HEIGHT, ...FRAME_PAD };
  const summary = summarise(series);
  const description = summary
    .map((s) => t('history.describeSeries', { account: labelOf(s.account), latest: Math.round(s.latest), peak: Math.round(s.peak) }))
    .join(' ');

  return (
    <figure className="usage-chart" ref={box}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="img" aria-labelledby={`${id}-title ${id}-desc`} className="usage-chart-svg">
        <title id={`${id}-title`}>{t('history.chartTitle')}</title>
        <desc id={`${id}-desc`}>{description}</desc>
        {[0, 25, 50, 75, 100].map((pct) => (
          <g key={pct} aria-hidden>
            <line className="usage-chart-grid" x1={FRAME_PAD.left} x2={width - FRAME_PAD.right} y1={yOf(frame, pct)} y2={yOf(frame, pct)} />
            <text className="usage-chart-axis" x={FRAME_PAD.left - 6} y={yOf(frame, pct) + 4} textAnchor="end">
              {pct}%
            </text>
          </g>
        ))}
        {threshold !== undefined && (
          <g aria-hidden>
            <line className="usage-chart-threshold" x1={FRAME_PAD.left} x2={width - FRAME_PAD.right} y1={yOf(frame, threshold)} y2={yOf(frame, threshold)} strokeDasharray="1 4" />
            {/* Inside the plot, above the line: the right margin is too narrow for the words */}
            <text className="usage-chart-axis" x={width - FRAME_PAD.right} y={yOf(frame, threshold) - 4} textAnchor="end">
              {t('history.threshold', { pct: threshold })}
            </text>
          </g>
        )}
        <g aria-hidden>
          <text className="usage-chart-axis" x={FRAME_PAD.left} y={HEIGHT - 6}>
            {formatDateTime(from)}
          </text>
          <text className="usage-chart-axis" x={width - FRAME_PAD.right} y={HEIGHT - 6} textAnchor="end">
            {formatDateTime(to)}
          </text>
        </g>
        {series.map((s, i) => {
          const last = s.readings.at(-1);
          return (
            <g key={s.account} className={`usage-series usage-series-${i % SERIES}`} aria-hidden>
              <path className="usage-series-line" d={pathOf(s, frame)} strokeDasharray={DASHES[i % DASHES.length] || undefined} />
              {last && last.t >= from && (
                <>
                  <circle className="usage-series-dot" cx={xOf(frame, last.t)} cy={yOf(frame, last.pct)} r={3.5} />
                  <text className="usage-series-label" x={xOf(frame, last.t) + 6} y={yOf(frame, last.pct) + (i % 2 === 0 ? -6 : 12)}>
                    #{s.account}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="usage-legend">
        {series.map((s, i) => (
          <span key={s.account} className={`usage-legend-item usage-series usage-series-${i % SERIES}`}>
            <svg width={28} height={10} aria-hidden>
              <line className="usage-series-line" x1={1} x2={27} y1={5} y2={5} strokeDasharray={DASHES[i % DASHES.length] || undefined} />
            </svg>
            <span className="small">
              #{s.account} · {labelOf(s.account)}
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
