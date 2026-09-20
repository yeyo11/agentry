import type { ChatModelTokens, ChatProject, UsageReport, UsageTotals } from '@agentry/shared';
import { addTokenUsage, emptyTokenUsage, type DayTokens } from './usage.ts';

/** What one chat spent, as the report reads it: where it belongs and what it spent on which day. */
export interface ChatSpend {
  chatId: string;
  project: ChatProject | null;
  orchestration: { id: string; name: string } | null;
  /** From the transcript: tokens per day and model, sidechains included */
  days: DayTokens[];
  /** What the CLI reported, per day it was spent: only chats Agentry launched have any */
  costs: Array<{ day: string; usd: number }>;
  /**
   * The same money split by model, as the CLI reported it per model; a cost with no split (an
   * execution recorded before the CLI's figure was kept) is put on the model the execution ran.
   * Only the breakdown reads it, so the report's totals stay what `costs` says.
   */
  modelCosts?: Array<{ day: string; model: string | null; usd: number }>;
}

/** Days are `YYYY-MM-DD`, so comparing them as strings is comparing them as dates. */
export interface DayRange {
  from?: string;
  to?: string;
}

class Bucket {
  private cost: number | null = null;
  private readonly byModel = new Map<string | null, ChatModelTokens>();
  private readonly chats = new Set<string>();
  private readonly costed = new Set<string>();

  addTokens(chatId: string, row: ChatModelTokens): void {
    this.chats.add(chatId);
    let into = this.byModel.get(row.model);
    if (!into) this.byModel.set(row.model, (into = { model: row.model, ...emptyTokenUsage() }));
    addTokenUsage(into, row);
  }

  addCost(chatId: string, usd: number): void {
    this.chats.add(chatId);
    this.costed.add(chatId);
    this.cost = (this.cost ?? 0) + usd;
  }

  totals(): UsageTotals {
    const tokens = [...this.byModel.values()].sort((a, b) => b.total - a.total);
    const total = emptyTokenUsage();
    for (const row of tokens) addTokenUsage(total, row);
    return { costUsd: this.cost, chatsWithoutCost: this.chats.size - this.costed.size, tokens, total };
  }
}

/** A map of buckets that makes them as they are asked for. */
class Buckets<K> {
  private readonly map = new Map<string, { key: K; bucket: Bucket }>();
  constructor(private readonly id: (key: K) => string) {}

  of(key: K): Bucket {
    const id = this.id(key);
    let entry = this.map.get(id);
    if (!entry) this.map.set(id, (entry = { key, bucket: new Bucket() }));
    return entry.bucket;
  }

  rows(): Array<{ key: K; totals: UsageTotals }> {
    return [...this.map.values()].map(({ key, bucket }) => ({ key, totals: bucket.totals() }));
  }
}

const bySpent = (a: { totals: UsageTotals }, b: { totals: UsageTotals }): number => b.totals.total.total - a.totals.total.total;

/**
 * Sums what the chats spent per day, per project and per orchestration, over the days asked for.
 * Tokens come from transcripts, so they cover every chat; cost only exists for what Agentry
 * launched, so it is summed where there is one and each total says how many chats it leaves out.
 * Nothing here is estimated.
 */
export function usageReport(chats: ChatSpend[], range: DayRange = {}): UsageReport {
  const inRange = (day: string): boolean => (range.from === undefined || day >= range.from) && (range.to === undefined || day <= range.to);
  const all = new Bucket();
  const days = new Buckets<string>((d) => d);
  const projects = new Buckets<ChatProject | null>((p) => p?.id ?? '\0loose');
  const orchestrations = new Buckets<{ id: string; name: string }>((o) => o.id);

  for (const chat of chats) {
    const buckets = (day: string): Bucket[] => [
      all,
      days.of(day),
      projects.of(chat.project),
      ...(chat.orchestration ? [orchestrations.of(chat.orchestration)] : []),
    ];
    for (const row of chat.days) if (inRange(row.day)) for (const b of buckets(row.day)) b.addTokens(chat.chatId, row);
    for (const cost of chat.costs) if (inRange(cost.day)) for (const b of buckets(cost.day)) b.addCost(chat.chatId, cost.usd);
  }

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    total: all.totals(),
    days: days.rows().map(({ key, totals }) => ({ day: key, ...totals })).sort((a, b) => a.day.localeCompare(b.day)),
    projects: projects.rows().sort(bySpent).map(({ key, totals }) => ({ project: key, ...totals })),
    orchestrations: orchestrations.rows().sort(bySpent).map(({ key, totals }) => ({ orchestration: key, ...totals })),
  };
}
