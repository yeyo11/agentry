import type { UsagePoint, UsageSlice } from '@agentry/shared';

/** What a chart plots. Cost is what the CLI reported; a chat started from a terminal has tokens only. */
export type UsageMetric = 'cost' | 'tokens' | 'chats';

export type RangePreset = '7d' | '30d' | '90d' | 'all' | 'custom';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` in the browser's zone: the range the person picks is a range of their own days. */
export function toDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A real calendar day, so `2026-02-31` is not accepted. */
export function parseDay(value: string): Date | null {
  const match = DAY_RE.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

/** The days a preset covers, inclusive of today; `all` leaves both ends open. */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, now: Date): { from?: string; to?: string } {
  if (preset === 'all') return {};
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: toDay(from), to: toDay(now) };
}

/** Why a custom range cannot be asked for, or null when it can. */
export function customRangeError(from: string, to: string): 'invalid' | 'order' | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return 'invalid';
  return a.getTime() > b.getTime() ? 'order' : null;
}

/** The API refuses more than 1000 points, so a long custom range goes by the week. */
export function bucketFor(range: { from?: string; to?: string }, wanted: 'day' | 'week'): 'day' | 'week' {
  const a = range.from ? parseDay(range.from) : null;
  const b = range.to ? parseDay(range.to) : null;
  if (a && b && (b.getTime() - a.getTime()) / 86_400_000 > 900) return 'week';
  return wanted;
}

export function metricValue(point: Pick<UsagePoint, 'costUsd' | 'tokens' | 'chats'>, metric: UsageMetric): number | null {
  return metric === 'cost' ? point.costUsd : metric === 'tokens' ? point.tokens : point.chats;
}

/** Sum of what was reported; null when nothing was, so "no figure" never reads as "free". */
export function sumMetric(points: ReadonlyArray<Pick<UsagePoint, 'costUsd' | 'tokens' | 'chats'>>, metric: UsageMetric): number | null {
  let total: number | null = null;
  for (const point of points) {
    const value = metricValue(point, metric);
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

/**
 * A round ceiling for the axis with `ticks + 1` evenly spaced gridlines from zero. `integer` keeps
 * the steps whole, so a chart of chats never has a gridline at 0.4.
 */
export function niceScale(max: number, ticks = 3, integer = false): { max: number; ticks: number[] } {
  const line = (step: number) => Array.from({ length: ticks + 1 }, (_, i) => Number((step * i).toPrecision(12)));
  if (!(max > 0)) return { max: integer ? ticks : 1, ticks: line(integer ? 1 : 1 / ticks) };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 3, 4, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw - 1e-12) ?? 10 * magnitude;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { max: Number((step * ticks).toPrecision(12)), ticks: line(step) };
}

/**
 * Slices by the chosen metric, most first, folding the tail into one "other" slice so a chart of
 * forty projects stays readable. Slices with no figure for the metric go last and are never folded
 * into a total that would read as zero.
 */
export function topSlices(
  slices: readonly UsageSlice[],
  metric: UsageMetric,
  limit: number,
): { shown: UsageSlice[]; rest: UsageSlice | null } {
  const value = (s: UsageSlice) => metricValue(s, metric);
  const sorted = [...slices].sort((a, b) => (value(b) ?? -1) - (value(a) ?? -1));
  if (sorted.length <= limit) return { shown: sorted, rest: null };
  const shown = sorted.slice(0, limit - 1);
  const tail = sorted.slice(limit - 1);
  const rest = { key: '', label: '', costUsd: sumMetric(tail, 'cost'), tokens: sumMetric(tail, 'tokens') ?? 0, chats: sumMetric(tail, 'chats') ?? 0 };
  return { shown, rest };
}

/** How many x labels fit: one every `every` points so neighbours never touch. */
export function labelStride(count: number, width: number, minGap = 64): number {
  if (count <= 0 || width <= 0) return 1;
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / minGap))));
}
