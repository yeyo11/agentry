import { isModelName, normalizeMessage, type ChatModelTokens, type TokenUsage, type TranscriptEntry } from '@agentry/shared';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const emptyTokenUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 });

/** Adds `more` into `into`, keeping `total` consistent. */
export function addTokenUsage(into: TokenUsage, more: TokenUsage): void {
  into.input += more.input;
  into.output += more.output;
  into.cacheRead += more.cacheRead;
  into.cacheCreation += more.cacheCreation;
  into.total = into.input + into.output + into.cacheRead + into.cacheCreation;
}

/** What the last response of the main conversation read, and the model that answered it. */
export interface ContextSnapshot {
  /** `input + cacheRead + cacheCreation` of that response */
  used: number;
  model: string | null;
}

interface MessageUsage {
  usage: TokenUsage;
  model: string | null;
  sidechain: boolean;
  /** When the response was written: the day it was spent on */
  at: string | null;
}

/** What was spent on one day with one model. */
export interface DayTokens extends ChatModelTokens {
  /** `YYYY-MM-DD`, in the server's time zone */
  day: string;
}

/** What a transcript says about how much was used, in one piece so it can be kept with the transcript's summary. */
export interface TranscriptUsage {
  context: ContextSnapshot | null;
  /** Everything spent, sidechains included, per model */
  tokens: ChatModelTokens[];
  total: TokenUsage;
  days: DayTokens[];
}

/** The calendar day of a timestamp where the server runs: what a person means by "today". */
export function localDay(iso: string): string | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(t.getFullYear())}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/**
 * Folds a transcript into what was spent and how full the context is, in one pass.
 *
 * The CLI writes one line per content block of an assistant message, each carrying the whole
 * message's usage: summing lines would count a message once per block. Usage is therefore kept by
 * message id, and the last line of an id holds its final figures.
 *
 * Sidechains (a subagent's messages, inside its parent's transcript) count towards what was spent,
 * because it was paid for, but not towards the context, because a subagent has a window of its own.
 */
export class UsageFold {
  // A Map keeps the order ids first appeared in, which is the order of the responses
  private readonly byMessage = new Map<string, MessageUsage>();

  /** `line` is the raw transcript line and `entry` what `normalizeMessage` made of it. */
  add(line: Record<string, unknown>, entry: TranscriptEntry): void {
    if (entry.role !== 'assistant') return;
    const message = line.message as { id?: unknown; usage?: unknown } | undefined;
    const u = message?.usage;
    if (!u || typeof u !== 'object') return;
    const raw = u as Record<string, unknown>;
    const usage: TokenUsage = {
      input: num(raw.input_tokens),
      output: num(raw.output_tokens),
      cacheRead: num(raw.cache_read_input_tokens),
      cacheCreation: num(raw.cache_creation_input_tokens),
      total: 0,
    };
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
    this.byMessage.set(typeof message?.id === 'string' ? message.id : entry.uuid, {
      usage,
      model: isModelName(entry.model) ? entry.model : null,
      sidechain: entry.isSidechain,
      at: entry.timestamp,
    });
  }

  /** An independent copy: a fold kept with a transcript is extended by later passes, and a half-written last line must not leak into it. */
  clone(): UsageFold {
    const copy = new UsageFold();
    for (const [id, m] of this.byMessage) copy.byMessage.set(id, m);
    return copy;
  }

  /** Everything spent, sidechains included, per model. Models appear in the order they were first used. */
  tokens(): ChatModelTokens[] {
    const byModel = new Map<string | null, ChatModelTokens>();
    for (const { usage, model } of this.byMessage.values()) {
      let row = byModel.get(model);
      if (!row) byModel.set(model, (row = { model, ...emptyTokenUsage() }));
      addTokenUsage(row, usage);
    }
    return [...byModel.values()];
  }

  /** What was spent on each day, per model, oldest day first. A response with no timestamp belongs to no day. */
  days(): DayTokens[] {
    const rows = new Map<string, DayTokens>();
    for (const { usage, model, at } of this.byMessage.values()) {
      const day = at ? localDay(at) : null;
      if (!day) continue;
      const key = `${day}\0${model ?? ''}`;
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { day, model, ...emptyTokenUsage() }));
      addTokenUsage(row, usage);
    }
    return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  snapshot(): TranscriptUsage {
    return { context: this.context(), tokens: this.tokens(), total: this.total(), days: this.days() };
  }

  total(): TokenUsage {
    const total = emptyTokenUsage();
    for (const { usage } of this.byMessage.values()) addTokenUsage(total, usage);
    return total;
  }

  /**
   * A snapshot of the last response of the main conversation, not a sum: when the CLI compacts,
   * the number drops. Null before there is one. A response with no tokens at all (the CLI's own
   * placeholders) says nothing about the context, so it is skipped.
   */
  context(): ContextSnapshot | null {
    let last: MessageUsage | null = null;
    for (const m of this.byMessage.values()) {
      if (!m.sidechain && m.usage.input + m.usage.cacheRead + m.usage.cacheCreation > 0) last = m;
    }
    if (!last) return null;
    return { used: last.usage.input + last.usage.cacheRead + last.usage.cacheCreation, model: last.model };
  }
}

/** The fold over transcript lines already parsed. Lines that are not conversation are ignored. */
export function foldUsage(lines: Iterable<Record<string, unknown>>): UsageFold {
  const fold = new UsageFold();
  for (const line of lines) {
    const entry = normalizeMessage(line);
    if (entry) fold.add(line, entry);
  }
  return fold;
}
