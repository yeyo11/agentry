import { entryText } from '@agentry/shared';
import type { ChatDetail, MessageDelivery, TranscriptEntry } from '@agentry/shared';

// ---------- the transcript, kept current from the stream ----------

/**
 * Entries put on a page because the stream said them, before any read of the transcript has
 * confirmed them, each with when it was put there. Marked on the entry, not the page: other caches
 * patch the page (the activity line) and a mark on the page object would be lost with it.
 */
const streamed = new WeakMap<TranscriptEntry, { mark: number; at: number }>();
let appended = 0;

/**
 * How long a message the stream said may be missing from a read of the transcript before the read
 * is believed. The CLI streams a message and writes its line in no set order, so a read that lands
 * in between would take back what was just shown until some later read, which can be a whole tool
 * call away.
 */
const WRITE_GRACE_MS = 2000;

/** Where the stream's appends are now: a read started here cannot hold what is appended after. */
export const streamMark = (): number => appended;

/** Whether this entry is on the page because the stream said it, and no read has confirmed it yet. */
export const isStreamed = (entry: TranscriptEntry): boolean => streamed.has(entry);

/** How long an entry counts as having just arrived: what an entrance animation is allowed to play for. */
const FRESH_MS = 1200;

/**
 * Whether the stream put this entry on the page a moment ago. A windowed transcript mounts a row
 * again every time it scrolls back into view, so "new" cannot be "mounted": it is this.
 */
export const justStreamed = (entry: TranscriptEntry, now = Date.now()): boolean => {
  const mark = streamed.get(entry);
  return mark !== undefined && now - mark.at < FRESH_MS;
};

/** How many entries at the end of `page` came from the stream and have not been read back yet. */
export function unconfirmedTail(page: ChatDetail): number {
  let count = 0;
  for (let i = page.entries.length - 1; i >= 0; i--) {
    const entry = page.entries[i];
    if (!entry || !streamed.has(entry)) break;
    count++;
  }
  return count;
}

/** How far back a stored message is looked for before it is taken to be new. */
const DEDUPE_WINDOW = 50;

/**
 * `page` with `entry` at its end, the moment the stream says it, so what was just said shows
 * without reading the transcript again. `present`: it is on the page already (a replay, or a read
 * that got there first). A subagent's entry is left to the next read: where it falls among the
 * chat's own is the transcript's to say.
 */
export function appendStreamed(page: ChatDetail, entry: TranscriptEntry, now = Date.now()): { page: ChatDetail; outcome: 'appended' | 'present' | 'skipped' } {
  if (entry.isSidechain) return { page, outcome: 'skipped' };
  // Older than the page's end: a replay (a restarted server replays a restored chat whole), whose
  // place is somewhere above and not at the end
  const last = page.entries.at(-1)?.timestamp;
  if (entry.timestamp && last && entry.timestamp < last) return { page, outcome: 'skipped' };
  if (entry.uuid) {
    for (let i = page.entries.length - 1; i >= Math.max(0, page.entries.length - DEDUPE_WINDOW); i--) {
      if (page.entries[i]?.uuid === entry.uuid) return { page, outcome: 'present' };
    }
  }
  streamed.set(entry, { mark: ++appended, at: now });
  return { page: { ...page, entries: [...page.entries, entry], total: page.total + 1 }, outcome: 'appended' };
}

/** What a message says, as a transcript line and the stream's copy of it both put it. */
const said = (entry: TranscriptEntry): string => entryText(entry).trim();

/**
 * The streamed messages of the person that the read's new user entries stand for, each entry
 * consuming at most one of them, or the run of them it was made of: the CLI reads every message
 * waiting when a turn ends as one prompt, their texts joined by a newline, under the last one's id.
 * Matched by id first; by words only against what the read holds that the page had not confirmed, so
 * an earlier "ok" never stands for the one just sent.
 */
function readBack(fresher: TranscriptEntry[], candidates: TranscriptEntry[]): Map<TranscriptEntry, TranscriptEntry> {
  const matched = new Map<TranscriptEntry, TranscriptEntry>();
  for (const entry of fresher) {
    const text = said(entry);
    const left = candidates.filter((c) => !matched.has(c));
    const own = left.findIndex((c) => c.uuid === entry.uuid);
    if (own !== -1) {
      matched.set(left[own] as TranscriptEntry, entry);
      // The messages merged in ahead of it, when its words are theirs and its own joined
      for (let from = own - 1; from >= 0; from--) {
        const run = left.slice(from, own + 1);
        if (run.map(said).join('\n') !== text) continue;
        for (const c of run) matched.set(c, entry);
        break;
      }
      continue;
    }
    for (let from = 0; from < left.length; from++) {
      let joined = '';
      let to = from;
      for (; to < left.length; to++) {
        const next = said(left[to] as TranscriptEntry);
        joined = to === from ? next : `${joined}\n${next}`;
        if (joined === text || !text.startsWith(joined)) break;
      }
      if (joined !== text) continue;
      for (const c of left.slice(from, to + 1)) matched.set(c, entry);
      break;
    }
  }
  return matched;
}

/**
 * The newest entries read back (`fresh`, a short page from the end) spliced onto what is held, so
 * following a live chat costs what it said since, not the newest page again. Everything from where
 * `fresh` starts is replaced, which confirms (or corrects) the entries the stream put there. What the
 * stream said that the read does not confirm is kept: a message the person sent stays where it was
 * sent, until a read shows it, and anything appended after the read started goes after it. Null when
 * the two do not meet or disagree where they overlap (the transcript was rewritten, or grew by more
 * than `fresh` holds): then only a whole page is honest.
 */
export function spliceTail(held: ChatDetail, fresh: ChatDetail, since = Number.POSITIVE_INFINITY, now = Date.now()): ChatDetail | null {
  // Where each entry the page holds sits in the transcript: one the stream said and no read has
  // confirmed has no place there yet
  const confirmed: number[] = [];
  held.entries.forEach((entry, i) => {
    if (!streamed.has(entry)) confirmed.push(i);
  });
  const confirmedEnd = held.from + confirmed.length;
  if (fresh.from < held.from || fresh.total < confirmedEnd) return null;
  const k = fresh.from - held.from;
  // They overlap by one confirmed entry at least and agree on it, or nothing held was confirmed
  // and the read starts where the page does
  let at: number;
  if (k < confirmed.length) {
    if (held.entries[confirmed[k] as number]?.uuid !== fresh.entries[0]?.uuid) return null;
    at = k === 0 ? 0 : (confirmed[k - 1] as number) + 1;
  } else if (confirmed.length === 0 && k === 0) at = 0;
  else return null;

  const region = held.entries.slice(at);
  const read = new Set(fresh.entries.map((entry) => entry.uuid));
  const fresher = fresh.entries.slice(Math.max(0, confirmedEnd - fresh.from)).filter((entry) => entry.role === 'user');
  const matched = readBack(fresher, region.filter((entry) => entry.role === 'user' && streamed.has(entry) && !read.has(entry.uuid)));

  // Each message kept goes after the entry it followed on the page; one with nothing before it in
  // the read goes first, and what the read cannot have known of goes last
  const after = new Map<string | null, TranscriptEntry[]>();
  const late: TranscriptEntry[] = [];
  let anchor: string | null = null;
  for (const entry of region) {
    const mark = streamed.get(entry);
    const back = read.has(entry.uuid) ? entry.uuid : (matched.get(entry)?.uuid ?? null);
    if (!mark || back !== null) {
      // What is replaced is confirmed now, even where the read hands back the very same objects
      streamed.delete(entry);
      if (back !== null) anchor = back;
      continue;
    }
    if (mark.mark > since) late.push(entry);
    else if (entry.role === 'user') after.set(anchor, [...(after.get(anchor) ?? []), entry]);
    else if (now - mark.at < WRITE_GRACE_MS) late.push(entry);
    else streamed.delete(entry);
  }
  const entries: TranscriptEntry[] = [...(after.get(null) ?? [])];
  for (const entry of fresh.entries) entries.push(entry, ...(after.get(entry.uuid) ?? []));
  entries.push(...late);
  return { ...fresh, from: held.from, entries: [...held.entries.slice(0, at), ...entries], total: fresh.total + entries.length - fresh.entries.length };
}

// ---------- what is being written right now ----------

/** Text generated so far for the block Claude is streaming right now (ephemeral, never stored). */
export interface StreamingPartial {
  block: 'text' | 'thinking';
  text: string;
  /** When this block started streaming (ISO): what the ticker counts from */
  since: string;
}

export interface StreamSnapshot {
  partial: StreamingPartial | null;
  connected: boolean;
}

/** A partial not updated for this long is not being written any more, whatever became of it. */
const QUIET_MS = 1000;

/**
 * The live state of one chat's stream, outside React: it changes up to once a frame while Claude
 * writes, and only what shows the text being written subscribes to it, so the rest of the page is
 * not rendered again that often. One per chat, so switching chats never shows the last one's text.
 */
export class ChatStreamStore {
  private snapshot: StreamSnapshot = { partial: null, connected: false };
  private readonly listeners = new Set<() => void>();
  /** The stored message that finalises the partial arrived; it goes once the transcript shows that */
  private ended = false;
  private updatedAt = 0;
  /** What the stream said became of each message since the page opened it, by the message's id */
  private readonly deliveries = new Map<string, MessageDelivery>();
  private readonly deliveryListeners = new Set<() => void>();
  private deliveryCount = 0;

  constructor(readonly chatId: string) {}

  readonly subscribeDeliveries = (listener: () => void): (() => void) => {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  };

  /** Changes whenever a delivery is heard: what a component re-reads {@link delivery} on */
  readonly deliveryVersion = (): number => this.deliveryCount;

  /** The stream said the agent took a message, or that it was lost */
  deliver(delivery: MessageDelivery): void {
    this.deliveries.set(delivery.id, delivery);
    this.deliveryCount++;
    for (const listener of this.deliveryListeners) listener();
  }

  delivery(id: string): MessageDelivery | undefined {
    return this.deliveries.get(id);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): StreamSnapshot => this.snapshot;

  private set(next: Partial<StreamSnapshot>): void {
    const merged = { ...this.snapshot, ...next };
    if (merged.partial === this.snapshot.partial && merged.connected === this.snapshot.connected) return;
    this.snapshot = merged;
    for (const listener of this.listeners) listener();
  }

  setConnected(connected: boolean): void {
    this.set({ connected });
  }

  setPartial(partial: StreamingPartial, now = Date.now()): void {
    this.ended = false;
    this.updatedAt = now;
    this.set({ partial });
  }

  /** The block was stored: keep showing it until the transcript does, so it never blinks out. */
  endPartial(): void {
    if (this.snapshot.partial) this.ended = true;
  }

  get ending(): boolean {
    return this.ended;
  }

  clearPartial(): void {
    this.ended = false;
    this.set({ partial: null });
  }

  /**
   * The transcript's last entry changed. A partial whose message has been stored is in it now; one
   * that has gone quiet lost its message to a gap in the stream and would otherwise stay forever.
   */
  settle(now = Date.now()): void {
    if (this.snapshot.partial && (this.ended || now - this.updatedAt > QUIET_MS)) this.clearPartial();
  }
}
