import { entryText } from '@agentry/shared';
import type { ChatDetail, TranscriptEntry } from '@agentry/shared';

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

/**
 * The newest entries read back (`fresh`, a short page from the end) spliced onto what is held, so
 * following a live chat costs what it said since, not the newest page again. Everything from where
 * `fresh` starts is replaced, which confirms (or corrects) the entries the stream put there; those
 * the stream appended after the read started (`since`), or too recently for the CLI to have written
 * them, are kept after it. Null when the two do not meet or disagree where they overlap (the transcript was
 * rewritten, or grew by more than `fresh` holds): then only a whole page is honest.
 */
export function spliceTail(held: ChatDetail, fresh: ChatDetail, since = Number.POSITIVE_INFINITY, now = Date.now()): ChatDetail | null {
  const confirmedEnd = held.from + held.entries.length - unconfirmedTail(held);
  if (fresh.from < held.from || fresh.total < confirmedEnd) return null;
  const at = fresh.from - held.from;
  // They overlap by one confirmed entry at least and agree on it, or nothing held was confirmed
  // and the read starts where the page does
  const meets = fresh.from < confirmedEnd ? held.entries[at]?.uuid === fresh.entries[0]?.uuid : confirmedEnd === held.from && at === 0;
  if (!meets) return null;
  const read = new Set(fresh.entries.map((entry) => entry.uuid));
  // The wrapper names the user messages it writes itself, and the transcript names its copy
  // otherwise: one sent while the read was on its way is matched by what it says instead
  const said = new Set(fresh.entries.filter((entry) => entry.role === 'user').map(entryText));
  const late: TranscriptEntry[] = [];
  for (const entry of held.entries.slice(at)) {
    const readBack = read.has(entry.uuid) || (entry.role === 'user' && said.has(entryText(entry)));
    const mark = streamed.get(entry);
    if (mark && (mark.mark > since || now - mark.at < WRITE_GRACE_MS) && !readBack) late.push(entry);
    // What is replaced is confirmed now, even where the read hands back the very same objects
    else streamed.delete(entry);
  }
  return { ...fresh, from: held.from, entries: [...held.entries.slice(0, at), ...fresh.entries, ...late], total: fresh.total + late.length };
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

  constructor(readonly chatId: string) {}

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
