import { setTimeout as sleep } from 'node:timers/promises';
import { liveSnapshot, type LiveChat, type LiveCounts, type LiveOrchestration, type LiveSnapshot } from './live.ts';
import { SseParser } from './sse.ts';

/** How many chats of each state the tray asks for: it names what is live, the counts say how much */
const CHAT_LIMIT = 10;
/** At most one refresh this often, however many events a burst brings */
const REFRESH_GAP_MS = 1_500;
/** While the event stream is down, the state is still read this often */
const POLL_MS = 30_000;
const RECONNECT_MAX_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Events that can change what is live. Everything else on the feed (changes, health, schedules…)
 * leaves the tray as it is, so it costs no request.
 */
const RELEVANT = ['run.', 'permission.', 'orchestration.', 'sessions.', 'stream.'];

export interface LiveMonitorOptions {
  /** The local server the app started, e.g. http://127.0.0.1:43123 */
  origin: string;
  /** Sent with every request: the bearer token when the server is guarded */
  headers?: Record<string, string>;
  onSnapshot: (snapshot: LiveSnapshot) => void;
  log?: (line: string) => void;
  refreshGapMs?: number;
  pollMs?: number;
}

/**
 * Follows what is live in the local server for the tray: the overview's counts, and the working
 * and waiting chats and running orchestrations when there are any, re-read whenever the event feed
 * says something moved. Everything comes from the server's REST API; nothing here talks to Claude.
 */
export class LiveMonitor {
  private readonly abort = new AbortController();
  private refreshing = false;
  private again = false;
  private lastRefresh = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastEventId: string | null = null;

  constructor(private readonly opts: LiveMonitorOptions) {}

  start(): void {
    void this.follow();
    this.refresh();
  }

  stop(): void {
    this.abort.abort();
    clearTimeout(this.refreshTimer);
    clearInterval(this.pollTimer);
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  /** Throttled: a burst of events becomes one read now and, if more came meanwhile, one after the gap */
  refresh(): void {
    if (this.stopped) return;
    if (this.refreshing || this.refreshTimer) {
      this.again = true;
      return;
    }
    const wait = this.lastRefresh + (this.opts.refreshGapMs ?? REFRESH_GAP_MS) - Date.now();
    if (wait > 0) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        this.refresh();
      }, wait);
      return;
    }
    this.refreshing = true;
    this.again = false;
    this.lastRefresh = Date.now();
    void this.read()
      .then((snapshot) => {
        if (!this.stopped) this.opts.onSnapshot(snapshot);
      })
      .catch((err: unknown) => {
        if (!this.stopped) this.opts.log?.(`live state: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.refreshing = false;
        if (this.again) this.refresh();
      });
  }

  private async get<T>(path: string): Promise<T> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const res = await fetch(`${this.opts.origin}${path}`, { headers: this.opts.headers, signal });
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return (await res.json()) as T;
  }

  private async read(): Promise<LiveSnapshot> {
    const { counts } = await this.get<{ counts: LiveCounts }>('/api/overview');
    const [working, waiting, orchestrations] = await Promise.all([
      counts.chatsWorking > 0 ? this.get<LiveChat[]>(`/api/chats?state=working&limit=${CHAT_LIMIT}`) : [],
      counts.chatsWaiting > 0 ? this.get<LiveChat[]>(`/api/chats?state=waiting&limit=${CHAT_LIMIT}`) : [],
      counts.orchestrationsRunning > 0 ? this.get<LiveOrchestration[]>('/api/orchestrations') : [],
    ]);
    return liveSnapshot({ counts, chats: [...working, ...waiting], orchestrations });
  }

  /** Keeps one connection to the event feed open, reconnecting with a backoff; polls while it is down */
  private async follow(): Promise<void> {
    let delay = 1_000;
    while (!this.stopped) {
      try {
        const query = this.lastEventId ? `?since=${encodeURIComponent(this.lastEventId)}` : '';
        const res = await fetch(`${this.opts.origin}/api/events${query}`, {
          headers: { ...this.opts.headers, Accept: 'text/event-stream' },
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`event feed answered ${res.status}`);
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
        delay = 1_000;
        const parser = new SseParser();
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
            if (event.id) this.lastEventId = event.id;
            if (RELEVANT.some((prefix) => event.type.startsWith(prefix))) this.refresh();
          }
        }
      } catch (err) {
        if (this.stopped) return;
        this.opts.log?.(`event feed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.stopped) return;
      // Whatever changed while the feed was down is read on the next poll, and again on reconnect
      this.pollTimer ??= setInterval(() => this.refresh(), this.opts.pollMs ?? POLL_MS);
      await sleep(delay, undefined, { signal: this.abort.signal }).catch(() => undefined);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }
}
