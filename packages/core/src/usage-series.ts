import type { UsageBreakdown, UsageBucket, UsagePoint, UsageSeries, UsageSlice } from '@agentry/shared';
import type { ChatSpend, DayRange } from './usage-report.ts';

/** The most points a series may have: a chart of more is unreadable and the server has to build them all. */
export const SERIES_MAX_POINTS = 1000;

/** The key a chat under no project is sliced under: a project id is a UUID, so nothing collides with it. */
export const LOOSE_KEY = 'loose';
/** The key of what no message named a model for. */
export const UNKNOWN_MODEL_KEY = 'unknown';

const DAY_MS = 86_400_000;
const pad = (n: number): string => String(n).padStart(2, '0');

// Calendar arithmetic on a `YYYY-MM-DD` runs in UTC: a day is then always 24 hours, whatever the
// server's time zone does with daylight saving
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const dayString = (n: number): string => {
  const d = new Date(n * DAY_MS);
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** The Monday of the week a day number is in. Day 0 (1970-01-01) was a Thursday. */
const mondayOf = (n: number): number => n - ((((n + 3) % 7) + 7) % 7);
const startOf = (n: number, bucket: UsageBucket): number => (bucket === 'week' ? mondayOf(n) : n);

/** Where the bucket a day belongs to starts. A week starts on Monday. */
export function bucketStart(day: string, bucket: UsageBucket): string {
  return dayString(startOf(dayNumber(day), bucket));
}

/** What piles up in one bucket or slice. A cost stays null until one is added: no cost is not a zero cost. */
interface Tally {
  cost: number | null;
  tokens: number;
  chats: Set<string>;
}

const tally = (): Tally => ({ cost: null, tokens: 0, chats: new Set() });
const addCost = (t: Tally, chatId: string, usd: number): void => {
  t.cost = (t.cost ?? 0) + usd;
  t.chats.add(chatId);
};
const addTokens = (t: Tally, chatId: string, tokens: number): void => {
  t.tokens += tokens;
  t.chats.add(chatId);
};

const within =
  (range: DayRange) =>
  (day: string): boolean =>
    (range.from === undefined || day >= range.from) && (range.to === undefined || day <= range.to);

/**
 * Cost and tokens over time, one point per bucket from the first to the last day asked for, empty
 * ones included so a chart has no gaps. Without a range it spans what there is, up to `today`.
 * Days are cut by the range before they are bucketed, so a range that starts mid-week holds only the
 * days it asks for in its first week. `costUsd` is null where no chat in the bucket has a cost the
 * CLI reported.
 */
export function usageSeries(chats: ChatSpend[], bucket: UsageBucket, range: DayRange = {}, today: string = dayString(Math.floor(Date.now() / DAY_MS))): UsageSeries {
  const inRange = within(range);
  const tallies = new Map<string, Tally>();
  const at = (day: string): Tally => {
    const key = bucketStart(day, bucket);
    let t = tallies.get(key);
    if (!t) tallies.set(key, (t = tally()));
    return t;
  };
  const span: { first: string | null; last: string | null } = { first: null, last: null };
  const seen = (day: string): void => {
    if (span.first === null || day < span.first) span.first = day;
    if (span.last === null || day > span.last) span.last = day;
  };
  for (const chat of chats) {
    for (const row of chat.days) {
      if (!inRange(row.day)) continue;
      addTokens(at(row.day), chat.chatId, row.total);
      seen(row.day);
    }
    for (const cost of chat.costs) {
      if (!inRange(cost.day)) continue;
      addCost(at(cost.day), chat.chatId, cost.usd);
      seen(cost.day);
    }
  }

  const from = range.from ?? span.first;
  const to = range.to ?? (span.last !== null && span.last > today ? span.last : today);
  if (from === null || from > to) return { bucket, points: [] };
  const step = bucket === 'week' ? 7 : 1;
  const end = dayNumber(to);
  const points: UsagePoint[] = [];
  for (let n = startOf(dayNumber(from), bucket); n <= end; n += step) {
    if (points.length >= SERIES_MAX_POINTS) throw new Error(`the range holds more than ${String(SERIES_MAX_POINTS)} ${bucket}s: narrow it or use weeks`);
    const t = tallies.get(dayString(n));
    points.push({ at: dayString(n), costUsd: t?.cost ?? null, tokens: t?.tokens ?? 0, chats: t?.chats.size ?? 0 });
  }
  return { bucket, points };
}

type Slices = Map<string, { label: string; t: Tally }>;

const slot = (map: Slices, key: string, label: string): Tally => {
  let entry = map.get(key);
  if (!entry) map.set(key, (entry = { label, t: tally() }));
  return entry.t;
};

const sliced = (map: Slices): UsageSlice[] =>
  [...map.entries()]
    .map(([key, { label, t }]) => ({ key, label, costUsd: t.cost, tokens: t.tokens, chats: t.chats.size }))
    // Most spent first: by cost where there is one, then by tokens, which is all a terminal chat has
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens || a.label.localeCompare(b.label));

/**
 * The same range cut by project and by model. Tokens are the transcripts' and cover every chat;
 * cost is the CLI's, per model where it said so. Nothing is priced from tokens.
 */
export function usageBreakdown(chats: ChatSpend[], range: DayRange = {}): UsageBreakdown {
  const inRange = within(range);
  const byProject: Slices = new Map();
  const byModel: Slices = new Map();
  const model = (name: string | null): Tally => slot(byModel, name ?? UNKNOWN_MODEL_KEY, name ?? 'Unknown model');

  for (const chat of chats) {
    const project = (): Tally => (chat.project ? slot(byProject, chat.project.id, chat.project.name) : slot(byProject, LOOSE_KEY, 'No project'));
    for (const row of chat.days) {
      if (!inRange(row.day)) continue;
      addTokens(project(), chat.chatId, row.total);
      addTokens(model(row.model), chat.chatId, row.total);
    }
    for (const cost of chat.costs) if (inRange(cost.day)) addCost(project(), chat.chatId, cost.usd);
    for (const cost of chat.modelCosts ?? []) if (inRange(cost.day)) addCost(model(cost.model), chat.chatId, cost.usd);
  }
  return { byProject: sliced(byProject), byModel: sliced(byModel) };
}
