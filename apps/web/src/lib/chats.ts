import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TRANSCRIPT_PAGE_MAX } from '@agentry/shared';
import type { AgentTranscript, Chat, RunEvent } from '@agentry/shared';
import { api, BASE, enc, keys } from '../api';
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

/**
 * Holds a contiguous run of a transcript, `[from, total)`, from the newest page back. The query
 * fetches the newest page and keeps it current; pages read further back are kept here and spliced
 * on, so following a live conversation never re-reads what is already held.
 */
function usePages<T>(
  page: { items: T[]; from: number; total: number } | undefined,
  fetchBefore: (before: number, limit?: number) => Promise<{ items: T[]; from: number; total: number }>,
  reset: unknown,
): Paged<T> {
  const [earlier, setEarlier] = useState<{ items: T[]; from: number }>({ items: [], from: -1 });
  const [loadingMore, setLoadingMore] = useState(false);
  const busy = useRef(false);
  // A page that lands after the reader switched transcripts belongs to the previous one
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setEarlier({ items: [], from: -1 });
    setLoadingMore(false);
    busy.current = false;
  }, [reset]);

  const tail = page?.items ?? [];
  const tailFrom = page?.from ?? 0;
  // The newest page slid past what is held (the conversation grew faster than it was read): the
  // pages no longer meet, and the honest thing is to show the newest run rather than a false one.
  const joined = earlier.from >= 0 && earlier.from + earlier.items.length >= tailFrom;
  const items = joined ? [...earlier.items.slice(0, tailFrom - earlier.from), ...tail] : tail;
  const from = joined ? earlier.from : tailFrom;
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
      setEarlier((held) =>
        held.from >= 0 && held.from <= older.from ? held : { items: [...older.items, ...(held.from >= 0 ? held.items : [])], from: older.from },
      );
      return older.from;
    },
    [fetchBefore],
  );

  const loadEarlier = useCallback(() => {
    if (busy.current || from <= 0) return;
    busy.current = true;
    setLoadingMore(true);
    void readBefore(from)
      .catch(() => {
        // the page stays as it is; the reader can ask again
      })
      .finally(() => {
        busy.current = false;
        setLoadingMore(false);
      });
  }, [readBefore, from]);

  const reach = useCallback(
    async (index: number) => {
      // A page the reader asked for is already on its way: wait for it rather than read it twice
      while (busy.current) await new Promise((resolve) => setTimeout(resolve, 50));
      busy.current = true;
      setLoadingMore(true);
      try {
        let at = fromNow.current;
        while (at > index) {
          const next = await readBefore(at, stretch(at, index));
          if (next >= at) break;
          at = next;
        }
      } finally {
        busy.current = false;
        setLoadingMore(false);
      }
    },
    [readBefore],
  );

  return { items, from, total, more: from > 0, loadingMore, loadEarlier, reach };
}

/** How often a live chat is read again for the signals only time can fire. */
const HEALTH_REFRESH_MS = 30_000;

/**
 * A chat and its transcript, newest page first, reading backwards on demand. The chat comes with
 * the page, so the header and the conversation are never out of step.
 */
export function useChatTranscript(id: string, sidechains: boolean) {
  const fallback = useFallbackInterval();
  const query = useQuery({
    queryKey: keys.chat(id, sidechains),
    queryFn: () => api.chat(id, sidechains),
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

/** Text generated so far for the block Claude is streaming right now (ephemeral, never stored). */
export interface StreamingPartial {
  block: 'text' | 'thinking';
  text: string;
}

/** A stored event that means the streamed block is now final (or the turn is over). */
function endsPartial(event: RunEvent): boolean {
  if (event.kind === 'message') return event.entry?.role === 'assistant';
  if (event.kind === 'result') return true;
  return event.kind === 'status' && event.status !== 'busy';
}

/**
 * What the transcript file cannot show in time: the block being written right now. Stored events
 * are not kept here — a stored message only asks the page to read the transcript again, so there
 * is one source for what has been said.
 *
 * The stream starts past every stored event: the page already has them, and replaying a chat that
 * has been going for hours to throw the replay away would be the cost of opening it.
 */
export function useChatStream(id: string, enabled: boolean): { partial: StreamingPartial | null; connected: boolean } {
  const client = useQueryClient();
  const [partial, setPartial] = useState<StreamingPartial | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setPartial(null);
    setConnected(false);
    if (!enabled) return;
    let frame = 0;
    let stale: ReturnType<typeof setTimeout> | undefined;
    let next: StreamingPartial | null | undefined;
    const apply = () => {
      frame = 0;
      if (next !== undefined) setPartial(next);
      next = undefined;
    };
    const source = new EventSource(`${BASE}/chats/${enc(id)}/stream?since=${Number.MAX_SAFE_INTEGER}`);
    source.onopen = () => setConnected(true);
    // The browser reconnects by itself, and says so through readyState
    source.onerror = () => setConnected(source.readyState === EventSource.OPEN);
    source.onmessage = (msg) => {
      let event: RunEvent;
      try {
        event = JSON.parse(String(msg.data)) as RunEvent;
      } catch {
        return; // keep-alives and malformed frames
      }
      if (event.kind === 'partial') {
        next = { block: event.block ?? 'text', text: event.text ?? '' };
      } else if (endsPartial(event)) {
        next = null;
        // Wait for the CLI to write what was just said before asking for it
        clearTimeout(stale);
        stale = setTimeout(() => void client.invalidateQueries({ queryKey: ['chat', id] }), 400);
      } else {
        return;
      }
      if (!frame) frame = requestAnimationFrame(apply);
    };
    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(stale);
      source.close();
    };
  }, [id, enabled, client]);

  return { partial, connected };
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
