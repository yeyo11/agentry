import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/format';
import '../../usage-history.css';
import { pathOf, summarise, xOf, yOf, type AccountSeries, type Frame } from '../../lib/usage-history';

/*
 * Drawn from the readings with no library. A line is told apart by its dash and by the label at its
 * end as well as by its colour, so it reads in greyscale; the figures behind it are a table under
 * the chart, and the chart itself has a description a screen reader reads out.
 */

const WIDTH = 720;
const HEIGHT = 240;
const FRAME_PAD = { left: 40, right: 44, top: 12, bottom: 26 };

/** Theme tokens that hold their contrast in both themes; a line has one each, and a dash of its own. */
const COLORS = ['var(--accent)', 'var(--info)', 'var(--ok)', 'var(--idle)', 'var(--warn)', 'var(--bad)'] as const;
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
  const frame: Frame = { from, to, width: WIDTH, height: HEIGHT, ...FRAME_PAD };
  const summary = summarise(series);
  const description = summary
    .map((s) => t('history.describeSeries', { account: labelOf(s.account), latest: Math.round(s.latest), peak: Math.round(s.peak) }))
    .join(' ');

  return (
    <figure className="usage-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby={`${id}-title ${id}-desc`} className="usage-chart-svg">
        <title id={`${id}-title`}>{t('history.chartTitle')}</title>
        <desc id={`${id}-desc`}>{description}</desc>
        {[0, 25, 50, 75, 100].map((pct) => (
          <g key={pct} aria-hidden>
            <line x1={FRAME_PAD.left} x2={WIDTH - FRAME_PAD.right} y1={yOf(frame, pct)} y2={yOf(frame, pct)} stroke="var(--border)" strokeWidth={1} />
            <text x={FRAME_PAD.left - 6} y={yOf(frame, pct) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">
              {pct}%
            </text>
          </g>
        ))}
        {threshold !== undefined && (
          <g aria-hidden>
            <line x1={FRAME_PAD.left} x2={WIDTH - FRAME_PAD.right} y1={yOf(frame, threshold)} y2={yOf(frame, threshold)} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="1 4" />
            <text x={WIDTH - FRAME_PAD.right + 4} y={yOf(frame, threshold) + 4} fontSize={11} fill="var(--text-muted)">
              {t('history.threshold', { pct: threshold })}
            </text>
          </g>
        )}
        <g aria-hidden>
          <text x={FRAME_PAD.left} y={HEIGHT - 6} fontSize={11} fill="var(--text-muted)">
            {formatDateTime(from)}
          </text>
          <text x={WIDTH - FRAME_PAD.right} y={HEIGHT - 6} textAnchor="end" fontSize={11} fill="var(--text-muted)">
            {formatDateTime(to)}
          </text>
        </g>
        {series.map((s, i) => {
          const last = s.readings.at(-1);
          const color = COLORS[i % COLORS.length] ?? COLORS[0];
          return (
            <g key={s.account} aria-hidden>
              <path d={pathOf(s, frame)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeDasharray={DASHES[i % DASHES.length] || undefined} />
              {last && last.t >= from && (
                <>
                  <circle cx={xOf(frame, last.t)} cy={yOf(frame, last.pct)} r={3.5} fill={color} />
                  <text x={xOf(frame, last.t) + 6} y={yOf(frame, last.pct) + (i % 2 === 0 ? -6 : 12)} fontSize={11} fontWeight={600} fill={color}>
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
          <span key={s.account} className="usage-legend-item">
            <svg width={28} height={10} aria-hidden>
              <line x1={1} x2={27} y1={5} y2={5} stroke={COLORS[i % COLORS.length]} strokeWidth={2} strokeDasharray={DASHES[i % DASHES.length] || undefined} />
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
