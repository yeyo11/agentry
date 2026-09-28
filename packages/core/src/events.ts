import { randomUUID } from 'node:crypto';
import type { AgentryEvent } from '@agentry/shared';

/** What a source hands the bus: the bus stamps `id` and `at`. */
export type AgentryEventInput = AgentryEvent extends infer E ? (E extends AgentryEvent ? Omit<E, 'id' | 'at'> : never) : never;

/** Enough for a browser tab that slept for a while; past it the client refetches instead. */
const DEFAULT_CAPACITY = 1000;

export type Replay = { events: AgentryEvent[] } | { resync: 'buffer-overflow' | 'server-restarted' };

/**
 * The one place every change in the app is announced, so a UI never has to poll for it.
 *
 * Sources emit typed events; the bus numbers them and keeps the last `capacity` in memory so a
 * client that dropped its connection can pick up where it left off. Ids only mean something
 * within one process, which is why {@link bootId} exists: a client that sees it change knows its
 * cursor belongs to a server that is gone.
 */
export class EventBus {
  readonly bootId = randomUUID();
  private readonly buffer: AgentryEvent[] = [];
  private readonly listeners = new Set<(event: AgentryEvent) => void>();
  private readonly observers = new Set<(event: AgentryEvent) => void>();
  private lastId = 0;
  /** Events emitted while another is being delivered, held so every listener hears them in id order */
  private readonly pending: AgentryEvent[] = [];
  private delivering = false;
  /** Told when the first listener arrives and when the last one leaves, so idle watchers can sleep */
  onDemand: ((wanted: boolean) => void) | null = null;

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  get lastEventId(): number {
    return this.lastId;
  }

  get subscribers(): number {
    return this.listeners.size;
  }

  emit(input: AgentryEventInput): AgentryEvent {
    const event = { ...input, id: ++this.lastId, at: new Date().toISOString() } as AgentryEvent;
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    // A listener that emits (core reacting to its own events) would otherwise have its event reach
    // the later listeners first, and a client drops an id older than one it has already seen
    this.pending.push(event);
    if (!this.delivering) this.drain();
    return event;
  }

  private drain(): void {
    this.delivering = true;
    try {
      for (let next = this.pending.shift(); next; next = this.pending.shift()) {
        for (const listener of [...this.observers, ...this.listeners]) {
          try {
            listener(next);
          } catch {
            // a broken consumer must not stop the others from hearing about it
          }
        }
      }
    } finally {
      this.delivering = false;
    }
  }

  subscribe(listener: (event: AgentryEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.onDemand?.(true);
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.onDemand?.(false);
    };
  }

  /**
   * Hears every event like a subscriber, but is not one: core reacting to its own events must not
   * keep the watchers awake that only run while a client is listening.
   */
  observe(listener: (event: AgentryEvent) => void): () => void {
    this.observers.add(listener);
    return () => void this.observers.delete(listener);
  }

  /**
   * What a client that last saw `id` missed. An id newer than anything emitted can only come from
   * a previous process; one older than the buffer's start means events were dropped.
   */
  since(id: number): Replay {
    if (id > this.lastId) return { resync: 'server-restarted' };
    if (id === this.lastId) return { events: [] };
    const first = this.buffer[0];
    // Ids are contiguous, so the buffer covers `id` exactly when it still holds the event after it
    if (!first || first.id > id + 1) return { resync: 'buffer-overflow' };
    return { events: this.buffer.filter((e) => e.id > id) };
  }
}
