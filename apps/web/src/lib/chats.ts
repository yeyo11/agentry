import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TRANSCRIPT_PAGE_MAX } from '@agentry/shared';
import type { AgentTranscript, Chat, ChatDetail, RunEvent, TranscriptEntry } from '@agentry/shared';
import { api, BASE, enc, keys } from '../api';
import { withToken } from './auth';
import { appendStreamed, ChatStreamStore, spliceTail, streamMark, type StreamingPartial, type StreamSnapshot } from './chat-stream';
import { useFallbackInterval } from './feed';

// ---------- reads ----------

/** A chat's own tasks, for the panel that shows one of them: it may be open on a page that holds no chat. */
export const useChatTasks = (id: string) =>
  useQuery({ queryKey: keys.chatTasks(id), queryFn: () => api.chatTasks(id), refetchInterval: useFallbackInterval() });

export const useChatPermissions = (id: string, live: boolean) => {
  const fallback = useFallbackInterval();
  return useQuery({ queryKey: keys.chatPermissions(id), queryFn: () => api.chatPermissions(id), refetchInterval: live ? fallback : false });
};

export interface Paged<T> {
  items: T[];
  /** Index of the first item held, within the whole transcript */
  from: number;
  total: number;
  /** Something is still above what is held */
  more: boolean;
  loadingMore: boolean;
  loadEarlier: () => void;
  /** Reads back until `index` is held, however many pages that takes */
  reach: (index: number) => Promise<void>;
}

/** How many entries to read at once to get back to `index` from `from`. */
const stretch = (from: number, index: number) => Math.min(TRANSCRIPT_PAGE_MAX, Math.max(1, from - index));

/** Nothing held: one array for all of them, so an empty page is not a new one each render. */
const NO_ITEMS: never[] = [];

/**
 * Holds a contiguous run of a transcript, `[from, total)`, from the newest page back. The query
 * fetches the newest page and keeps it current; pages read further back are kept here and spliced
 * on, so following a live conversation never re-reads what is already held.
 */
function usePages<T>(
  page: { items: T[]; from: number; total: number } | undefined,
  fetchBefore: (before: number, limit?: number) => Promise<{ items: T[]; from: number; total: number }>,
  reset: string,
): Paged<T> {
  // Pages read further back, with the transcript they belong to: another transcript shows none of
  // them from its very first render, rather than for the one render before an effect clears them
  const [held, setHeld] = useState<{ owner: string; items: T[]; from: number }>({ owner: reset, items: [], from: -1 });
  const [loadingFor, setLoadingFor] = useState<string | null>(null);
  const busy = useRef(false);
  // A page that lands after the reader switched transcripts belongs to the previous one
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    busy.current = false;
  }, [reset]);

  const own = held.owner === reset;
  const earlierItems = own ? held.items : NO_ITEMS;
  const earlierFrom = own ? held.from : -1;
  const tail = page?.items ?? NO_ITEMS;
  const tailFrom = page?.from ?? 0;
  // The newest page slid past what is held (the conversation grew faster than it was read): the
  // pages no longer meet, and the honest thing is to show the newest run rather than a false one.
  const joined = earlierFrom >= 0 && earlierFrom + earlierItems.length >= tailFrom;
  // The same array until something is added: the rows are worked out from it
  const items = useMemo(
    () => (joined ? [...earlierItems.slice(0, tailFrom - earlierFrom), ...tail] : tail),
    [joined, earlierItems, earlierFrom, tailFrom, tail],
  );
  const from = joined ? earlierFrom : tailFrom;
  const total = page?.total ?? 0;
  const fromNow = useRef(from);
  useEffect(() => {
    fromNow.current = from;
  }, [from]);

  /** Reads the page before `before` and splices it on; resolves to where what is held now starts. */
  const readBefore = useCallback(
    async (before: number, limit?: number): Promise<number> => {
      const started = generation.current;
      const older = await fetchBefore(before, limit);
      if (started !== generation.current || older.items.length === 0) return before;
      setHeld((current) => {
        const kept = current.owner === reset && current.from >= 0 ? current : null;
        return kept && kept.from <= older.from ? kept : { owner: reset, items: [...older.items, ...(kept ? kept.items : [])], from: older.from };
      });
      return older.from;
    },
    [fetchBefore, reset],
  );

  const loadEarlier = useCallback(() => {
    if (busy.current || from <= 0) return;
    busy.current = true;
    setLoadingFor(reset);
    void readBefore(from)
      .catch(() => {
        // the page stays as it is; the reader can ask again
      })
      .finally(() => {
        busy.current = false;
        setLoadingFor((owner) => (owner === reset ? null : owner));
      });
  }, [readBefore, from, reset]);

  const reach = useCallback(
    async (index: number) => {
      // A page the reader asked for is already on its way: wait for it rather than read it twice
      while (busy.current) await new Promise((resolve) => setTimeout(resolve, 50));
      busy.current = true;
      setLoadingFor(reset);
      try {
        let at = fromNow.current;
        while (at > index) {
          const next = await readBefore(at, stretch(at, index));
          if (next >= at) break;
          at = next;
        }
      } finally {
        busy.current = false;
        setLoadingFor((owner) => (owner === reset ? null : owner));
      }
    },
    [readBefore, reset],
  );

  return { items, from, total, more: from > 0, loadingMore: loadingFor === reset, loadEarlier, reach };
}

/** How often a live chat is read again for the signals only time can fire. */
const HEALTH_REFRESH_MS = 30_000;

/**
 * Entries read back at once to follow a chat whose page is held. What the chat said since the last
 * read is usually a handful; a burst longer than this is read as a whole page instead.
 */
const TAIL_READ = 50;

/**
 * A chat and its transcript, newest page first, reading backwards on demand. The chat comes with
 * the page, so the header and the conversation are never out of step.
 */
export function useChatTranscript(id: string, sidechains: boolean) {
  const client = useQueryClient();
  const fallback = useFallbackInterval();
  const query = useQuery({
    queryKey: keys.chat(id, sidechains),
    // Once a page is held, only its end is read again and spliced on: every event that says the
    // chat moved asks for this, and reading the newest page each time would re-send all of it
    queryFn: async (): Promise<ChatDetail> => {
      const key = keys.chat(id, sidechains);
      if (!client.getQueryData<ChatDetail>(key)) return api.chat(id, sidechains);
      const since = streamMark();
      const fresh = await api.chat(id, sidechains, { limit: TAIL_READ });
      const held = client.getQueryData<ChatDetail>(key);
      return (held && spliceTail(held, fresh, since)) ?? api.chat(id, sidechains);
    },
    // Only a chat something is working on changes by itself; the events say when, and this covers the
    // feed being down. Its health is a fact of the clock (a command running too long sends no event),
    // so a live execution is read again at a slow pace even with the feed up.
    refetchInterval: (q) => {
      const chat = q.state.data?.chat;
      if (!chat) return false;
      if (chat.execution) return fallback || HEALTH_REFRESH_MS;
      return chat.state !== 'idle' ? fallback : false;
    },
  });
  const fetchBefore = useCallback(
    (before: number, limit?: number) => api.chat(id, sidechains, { before, limit }).then((d) => ({ items: d.entries, from: d.from, total: d.total })),
    [id, sidechains],
  );
  const page = query.data ? { items: query.data.entries, from: query.data.from, total: query.data.total } : undefined;
  const chat: Chat | undefined = query.data?.chat;
  return { query, chat, ...usePages(page, fetchBefore, `${id}:${sidechains}`) };
}

// ---------- the live stream of a chat ----------

/** A quiet spell after stored messages, after which what the stream put on the page is read back. */
const CONFIRM_AFTER_MS = 1000;
/** ...and the longest a busy stream goes without that. */
const CONFIRM_AT_LEAST_EVERY_MS = 4000;
/** A block stored while its page was not held shows until the page is read, or this long at most. */
const SETTLE_FALLBACK_MS = 3000;
/** Longest wait between attempts to open a stream the server refused. */
const RECONNECT_MAX_MS = 30_000;
/**
 * A hidden tab lets go of its stream after this long. Browsers allow six connections per host
 * over HTTP/1.1, shared by every tab, and a few chats left open in the background would take them.
 */
const HIDDEN_CLOSE_MS = 30_000;

/** What a component shows of the stream, read so it renders again only when that changes. */
export function useStreamSnapshot<T>(store: ChatStreamStore, select: (snapshot: StreamSnapshot) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/**
 * What the transcript file cannot show in time: the block being written right now, and each
 * stored message the moment it is said, put on the cached page until a read of the transcript
 * confirms it. Returns the chat's stream store; the page subscribes to what it shows of it.
 *
 * The stream starts past every stored event: the page already has them, and replaying a chat that
 * has been going for hours to throw the replay away would be the cost of opening it.
 */
export function useChatStream(id: string, enabled: boolean): ChatStreamStore {
  const client = useQueryClient();
  // Made during render, one per chat: the first render of another chat already reads its own
  const store = useMemo(() => new ChatStreamStore(id), [id]);

  useEffect(() => {
    store.clearPartial();
    store.setConnected(false);
    if (!enabled) return;
    const transcripts = [keys.chat(id, false), keys.chat(id, true)];
    let source: EventSource | null = null;
    let frame = 0;
    let next: StreamingPartial | null | undefined;
    let streaming: { block: 'text' | 'thinking'; since: string } | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let hidden: ReturnType<typeof setTimeout> | undefined;
    let confirm: ReturnType<typeof setTimeout> | undefined;
    let confirmBy = 0;
    let turnEnd: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let dropped = false;
    // The last stored event seen: a stream opened again replays what came after it
    let lastSeq = 0;

    const apply = () => {
      frame = 0;
      if (next) store.setPartial(next);
      else if (next === null) store.clearPartial();
      next = undefined;
    };
    const flush = () => {
      if (!frame) return;
      cancelAnimationFrame(frame);
      apply();
    };
    const confirmNow = () => {
      clearTimeout(confirm);
      confirm = undefined;
      confirmBy = 0;
      for (const queryKey of transcripts) void client.invalidateQueries({ queryKey, exact: true });
    };
    const scheduleConfirm = () => {
      const now = Date.now();
      if (!confirmBy) confirmBy = now + CONFIRM_AT_LEAST_EVERY_MS;
      clearTimeout(confirm);
      confirm = setTimeout(confirmNow, Math.max(0, Math.min(CONFIRM_AFTER_MS, confirmBy - now)));
    };
    /** Puts a stored message on the pages held; says whether one of them now shows it. */
    const show = (entry: TranscriptEntry): 'appended' | 'present' | 'skipped' => {
      let outcome: 'appended' | 'present' | 'skipped' = 'skipped';
      for (const queryKey of transcripts) {
        client.setQueryData<ChatDetail>(queryKey, (page) => {
          if (!page) return page;
          const result = appendStreamed(page, entry);
          if (result.outcome === 'appended' || outcome === 'skipped') outcome = result.outcome;
          return result.page;
        });
      }
      return outcome;
    };

    const onMessage = (msg: MessageEvent) => {
      let event: RunEvent;
      try {
        event = JSON.parse(String(msg.data)) as RunEvent;
      } catch {
        return; // keep-alives and malformed frames
      }
      if (event.kind === 'partial') {
        const block = event.block ?? 'text';
        // The same block growing keeps its start; a new one (thinking gave way to text) starts again
        const since = streaming && streaming.block === block ? streaming.since : event.ts || new Date().toISOString();
        streaming = { block, since };
        next = { block, text: event.text ?? '', since };
        if (!frame) frame = requestAnimationFrame(apply);
        return;
      }
      lastSeq = Math.max(lastSeq, event.seq);
      if (event.kind === 'message' && event.entry) {
        const outcome = show(event.entry);
        scheduleConfirm();
        if (event.entry.role !== 'assistant') return;
        // The block is final: whatever text of it is still waiting for a frame goes first
        flush();
        streaming = null;
        if (outcome === 'present') return store.clearPartial();
        // It leaves once the transcript shows the message (the page settles it), never before
        store.endPartial();
        clearTimeout(settle);
        settle = setTimeout(() => {
          if (store.ending) store.clearPartial();
        }, SETTLE_FALLBACK_MS);
        return;
      }
      if (event.kind === 'result' || (event.kind === 'status' && event.status !== 'busy')) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        next = undefined;
        streaming = null;
        // A block cut off by an interrupt is never stored; one that was stays until it shows
        if (!store.ending) store.clearPartial();
        // The turn is over: everything the chat's page reads may have moved, once
        clearTimeout(confirm);
        confirm = undefined;
        confirmBy = 0;
        clearTimeout(turnEnd);
        turnEnd = setTimeout(() => void client.invalidateQueries({ queryKey: keys.chatScope(id) }), 400);
      }
    };

    const connect = () => {
      retry = undefined;
      const es = new EventSource(withToken(`${BASE}/chats/${enc(id)}/stream?since=${lastSeq || Number.MAX_SAFE_INTEGER}`));
      source = es;
      es.onopen = () => {
        attempts = 0;
        store.setConnected(true);
        if (!dropped) return;
        dropped = false;
        // What was being written while the stream was down has been stored or dropped by now, and
        // a message said in the gap may not be replayed: read the transcript back
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        next = undefined;
        streaming = null;
        store.clearPartial();
        confirmNow();
      };
      es.onerror = () => {
        dropped = true;
        // While the browser is retrying by itself it says CONNECTING; CLOSED means it gave up (the
        // server answered with an error), and only a new EventSource can recover
        store.setConnected(es.readyState === EventSource.OPEN);
        if (es.readyState !== EventSource.CLOSED) return;
        es.close();
        source = null;
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, RECONNECT_MAX_MS));
      };
      es.onmessage = onMessage;
    };
    const disconnect = () => {
      clearTimeout(retry);
      retry = undefined;
      source?.close();
      source = null;
    };

    const onVisibility = () => {
      clearTimeout(hidden);
      if (document.visibilityState === 'hidden') {
        hidden = setTimeout(() => {
          if (!source && !retry) return;
          disconnect();
          dropped = true;
          store.setConnected(false);
        }, HIDDEN_CLOSE_MS);
        return;
      }
      if (source) return;
      clearTimeout(retry);
      attempts = 0;
      connect();
    };

    connect();
    if (document.visibilityState === 'hidden') onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (frame) cancelAnimationFrame(frame);
      for (const timer of [hidden, confirm, turnEnd, settle]) clearTimeout(timer);
      disconnect();
    };
  }, [id, enabled, client, store]);

  return store;
}

// ---------- what a branch shows: a subagent's transcript and a task's output ----------

/**
 * What the events cannot say: a subagent writes to its own transcript and a task to its own output
 * file, and neither announces each line. So while one is running, its panel asks again this often,
 * which is cheap because both reads are incremental.
 */
const RUNNING_POLL_MS = 2500;

/** More than any reasonable panel scrolls through; older output is dropped from the front. */
const MAX_OUTPUT_CHARS = 1_000_000;

/** Reads a chunk at a time until the end; a burst larger than one chunk is never left half read. */
const MAX_OUTPUT_CHUNKS = 16;

/** Which agent a panel shows: a subagent, or with `workflowId` an agent of that workflow. */
export interface AgentRef {
  chatId: string;
  agentId: string;
  workflowId?: string;
}

/**
 * One agent's detail and transcript. Every fetch asks only for the entries after the ones already
 * cached and appends them, so following a long transcript costs its growth, not its size.
 */
export function useAgentDetail(ref: AgentRef, running: boolean) {
  const client = useQueryClient();
  const fallback = useFallbackInterval();
  const key = keys.agent(ref.chatId, ref.workflowId ?? '', ref.agentId);
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<AgentTranscript> => {
      const before = client.getQueryData<AgentTranscript>(key);
      const next = ref.workflowId
        ? await api.workflowAgent(ref.chatId, ref.workflowId, ref.agentId, before?.total)
        : await api.subagent(ref.chatId, ref.agentId, before?.total);
      // `from` is 0 when the server had to start over (the file was rewritten): then it is all there is
      if (!before || next.from === 0) return next;
      return { ...next, entries: [...before.entries.slice(0, next.from), ...next.entries], from: 0 };
    },
    // Entries are appended by identity, so comparing thousands of them deeply on each poll is waste
    structuralSharing: false,
    refetchInterval: (query) => ((query.state.data ? query.state.data.status === 'running' : running) ? RUNNING_POLL_MS : fallback),
  });
}

/** A background task's output as followed so far. */
export interface FollowedOutput {
  text: string;
  /** Size of the file when last read */
  bytes: number;
  /** Where the next read resumes */
  offset: number;
  /** The start of the output is not in `text`: the file was longer than what is kept */
  cutHead: boolean;
}

/** A task's output, following the file as it grows: each fetch resumes from where the last one ended. */
export function useTaskOutput(chatId: string, taskId: string, running: boolean) {
  const client = useQueryClient();
  const fallback = useFallbackInterval();
  const key = keys.output(chatId, taskId);
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<FollowedOutput> => {
      const before = client.getQueryData<FollowedOutput>(key);
      let text = before?.text ?? '';
      let cutHead = before?.cutHead ?? false;
      let offset = before?.offset;
      let bytes = before?.bytes ?? 0;
      for (let i = 0; i < MAX_OUTPUT_CHUNKS; i++) {
        const chunk = await api.taskOutput(chatId, taskId, offset);
        if (offset === undefined || chunk.reset) {
          text = chunk.output;
          cutHead = chunk.truncated;
        } else {
          text += chunk.output;
        }
        offset = chunk.offset;
        bytes = chunk.bytes;
        // Nothing came back while bytes remain: the rest is the start of a character still being written
        if (offset >= bytes || !chunk.output) break;
      }
      if (text.length > MAX_OUTPUT_CHARS) {
        text = text.slice(-MAX_OUTPUT_CHARS);
        cutHead = true;
      }
      return { text, bytes, offset: offset ?? 0, cutHead };
    },
    structuralSharing: false,
    refetchInterval: running ? RUNNING_POLL_MS : fallback,
  });
}
