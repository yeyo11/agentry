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
 * After a 401 or 403 nothing is asked for this long, doubling up to the maximum. A refusal does not
 * fix itself in 15 seconds, and every retry lands on the address the owner's own window and chats
 * share, so a monitor that kept asking would be noise in the logs at best.
 */
const REFUSED_MS = 5 * 60_000;
const REFUSED_MAX_MS = 30 * 60_000;
/** A 429 without a usable `Retry-After`: the longest wait the server hands out */
const THROTTLED_MS = 60_000;

/** A status the monitor has to answer by asking less, not by asking again */
class Refusal extends Error {
  constructor(
    what: string,
    readonly status: number,
    /** From `Retry-After`, in milliseconds, when the server said */
    readonly retryAfterMs: number | undefined,
  ) {
    super(`${what} answered ${String(status)}`);
  }
}

/** `Retry-After` as seconds or as an HTTP date; undefined when it is neither */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(at - now, 0);
}

const refusalOf = (what: string, res: Response): Refusal | undefined =>
  res.status === 401 || res.status === 403 || res.status === 429 ? new Refusal(what, res.status, retryAfterMs(res.headers.get('retry-after'))) : undefined;

/**
 * Events that can change what is live. Everything else on the feed (changes, health, schedules…)
 * leaves the tray as it is, so it costs no request.
 */
const RELEVANT = ['run.', 'permission.', 'orchestration.', 'sessions.', 'stream.'];

/**
 * The tray's credential. The app's own per-launch secret comes first: the server it spawned always
 * knows it, whatever guard the owner turned on since, while `AGENTRY_AUTH_TOKEN` only seeds a
 * fresh install and goes stale the moment the token is rotated from the Security panel. The
 * variable is still used when there is no secret to send.
 */
export function monitorHeaders(desktopSecret: string | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const token = desktopSecret?.trim() || env.AGENTRY_AUTH_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface LiveMonitorOptions {
  /** The local server the app started, e.g. http://127.0.0.1:43123 */
  origin: string;
  /** Sent with every request: the bearer token when the server is guarded */
  headers?: Record<string, string>;
  onSnapshot: (snapshot: LiveSnapshot) => void;
  log?: (line: string) => void;
  refreshGapMs?: number;
  pollMs?: number;
  refusedMs?: number;
  refusedMaxMs?: number;
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
  /** Nothing is asked before this instant, after the server refused or throttled the monitor */
  private quietUntil = 0;
  /** The last wait after a 401 or 403, which the next one doubles; 0 once a request succeeds */
  private refusedFor = 0;
  /** Said once per spell of refusals, not once per attempt */
  private refusalLogged = false;

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
    const now = Date.now();
    const wait = Math.max(this.lastRefresh + (this.opts.refreshGapMs ?? REFRESH_GAP_MS), this.quietUntil) - now;
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
        if (this.stopped) return;
        this.accepted();
        this.opts.onSnapshot(snapshot);
      })
      .catch((err: unknown) => {
        if (this.stopped) return;
        if (err instanceof Refusal) this.refused(err, 'live state');
        else this.opts.log?.(`live state: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.refreshing = false;
        if (this.again) this.refresh();
      });
  }

  private async get<T>(path: string): Promise<T> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const res = await fetch(`${this.opts.origin}${path}`, { headers: this.opts.headers, signal });
    const refusal = refusalOf(`GET ${path}`, res);
    if (refusal) throw refusal;
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
      // The overview may have been refused while this slept: its quiet spell holds for the feed too
      const quiet = this.quietUntil - Date.now();
      if (quiet > 0) {
        await sleep(quiet, undefined, { signal: this.abort.signal }).catch(() => undefined);
        continue;
      }
      try {
        const query = this.lastEventId ? `?since=${encodeURIComponent(this.lastEventId)}` : '';
        const res = await fetch(`${this.opts.origin}/api/events${query}`, {
          headers: { ...this.opts.headers, Accept: 'text/event-stream' },
          signal: this.abort.signal,
        });
        const refusal = refusalOf('event feed', res);
        if (refusal) throw refusal;
        if (!res.ok || !res.body) throw new Error(`event feed answered ${res.status}`);
        this.accepted();
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
        if (err instanceof Refusal) this.refused(err, 'event feed');
        else this.opts.log?.(`event feed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.stopped) return;
      // Whatever changed while the feed was down is read on the next poll, and again on reconnect.
      // While the server refuses, the poll asks nothing: `refresh` waits out the same quiet spell.
      this.pollTimer ??= setInterval(() => this.refresh(), this.opts.pollMs ?? POLL_MS);
      await sleep(Math.max(delay, this.quietUntil - Date.now()), undefined, { signal: this.abort.signal }).catch(() => undefined);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  private accepted(): void {
    if (this.refusedFor || this.refusalLogged) this.opts.log?.('the server answers the tray again');
    this.refusedFor = 0;
    this.refusalLogged = false;
    this.quietUntil = 0;
  }

  /**
   * Both the feed and the overview can be refused at once; the second inside a quiet spell the
   * first already started neither doubles the wait nor says it again.
   */
  private refused(refusal: Refusal, what: string): void {
    const now = Date.now();
    if (now < this.quietUntil) return;
    let wait: number;
    if (refusal.status === 429) {
      wait = refusal.retryAfterMs ?? THROTTLED_MS;
    } else {
      const first = this.opts.refusedMs ?? REFUSED_MS;
      this.refusedFor = this.refusedFor ? Math.min(this.refusedFor * 2, this.opts.refusedMaxMs ?? REFUSED_MAX_MS) : first;
      wait = this.refusedFor;
    }
    this.quietUntil = now + wait;
    if (this.refusalLogged) return;
    this.refusalLogged = true;
    this.opts.log?.(`${what}: ${refusal.message}; the tray asks again in ${String(Math.ceil(wait / 1000))} s, and less often while it is refused`);
  }
}
