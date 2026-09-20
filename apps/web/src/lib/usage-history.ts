import type { UsageHistoryPoint } from '@agentry/shared';

export type UsageRange = '24h' | '7d' | '30d';

export const USAGE_RANGES: readonly UsageRange[] = ['24h', '7d', '30d'];

const RANGE_MS: Record<UsageRange, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};

/** Start of a range, as the ISO time the route filters on. */
export function sinceOf(range: UsageRange, now = Date.now()): string {
  return new Date(now - RANGE_MS[range]).toISOString();
}

/** Readings come every few minutes while the wrapper runs; a longer silence is a gap, not a flat line. */
export const GAP_MS = 2 * 3_600_000;

export interface Reading {
  t: number;
  pct: number;
}

export interface AccountSeries {
  account: number;
  readings: Reading[];
}

/** One line per account, each oldest first, whatever order the points arrived in. */
export function seriesOf(points: readonly UsageHistoryPoint[]): AccountSeries[] {
  const byAccount = new Map<number, Reading[]>();
  for (const point of points) {
    const t = Date.parse(point.at);
    if (!Number.isFinite(t)) continue;
    const list = byAccount.get(point.account) ?? [];
    list.push({ t, pct: point.pct });
    byAccount.set(point.account, list);
  }
  return [...byAccount.entries()]
    .sort(([a], [b]) => a - b)
    .map(([account, readings]) => ({ account, readings: readings.sort((x, y) => x.t - y.t) }));
}

export interface Frame {
  from: number;
  to: number;
  width: number;
  height: number;
  /** Space kept clear for the axes */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const xOf = (frame: Frame, t: number): number => {
  const span = Math.max(1, frame.to - frame.from);
  return frame.left + ((t - frame.from) / span) * (frame.width - frame.left - frame.right);
};

/** 0 at the bottom, 100 at the top; a reading outside that is drawn on the edge rather than off the chart. */
export const yOf = (frame: Frame, pct: number): number => {
  const clamped = Math.min(100, Math.max(0, pct));
  return frame.top + (1 - clamped / 100) * (frame.height - frame.top - frame.bottom);
};

const fixed = (n: number) => Number(n.toFixed(1));

/** The path of a series, lifted between two readings further apart than `GAP_MS`. */
export function pathOf(series: AccountSeries, frame: Frame): string {
  const parts: string[] = [];
  let previous: Reading | null = null;
  for (const reading of series.readings) {
    if (reading.t < frame.from || reading.t > frame.to) continue;
    const command = previous && reading.t - previous.t <= GAP_MS ? 'L' : 'M';
    parts.push(`${command}${fixed(xOf(frame, reading.t))} ${fixed(yOf(frame, reading.pct))}`);
    previous = reading;
  }
  return parts.join(' ');
}

export interface SeriesSummary {
  account: number;
  readings: number;
  latest: number;
  latestAt: number;
  peak: number;
}

/** What the table behind the chart says about each line, and what the chart's description reads out. */
export function summarise(series: readonly AccountSeries[]): SeriesSummary[] {
  return series.flatMap((s) => {
    const last = s.readings.at(-1);
    if (!last) return [];
    return [{ account: s.account, readings: s.readings.length, latest: last.pct, latestAt: last.t, peak: Math.max(...s.readings.map((r) => r.pct)) }];
  });
}
