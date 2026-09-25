import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// `web-push` is CommonJS and builds its exports object from bound methods, which Node's lexer
// cannot read as named exports: the default import is the whole module, and the only one that works.
import webpush from 'web-push';
import {
  DEFAULT_LEVEL,
  interrupts,
  KINDS,
  LEVELS,
  notificationsFor,
  type AgentryEvent,
  type NotificationDraft,
  type NotificationKind,
  type NotificationLevel,
  type PushKeyInfo,
  type PushPayload,
  type PushSendResult,
  type PushSubscriptionSummary,
  type RegisterPushSubscriptionRequest,
} from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { Db, PushSubscriptionRecord } from './db.ts';
import type { EventBus } from './events.ts';
import type { CoreConfig } from './paths.ts';

/*
 * Web Push, served by this wrapper and nobody else. The server signs a VAPID JWT with its own
 * keypair and posts the encrypted payload to whatever endpoint the browser handed us, so a
 * self-hosted Agentry behind a NAT still reaches a phone: the connection is outbound.
 *
 * What is worth a notification is not decided here. `notificationsFor` in `@agentry/shared` is the
 * same function the browser runs on the same event, which is the only way the in-page toast and the
 * push on a lock screen can be guaranteed to agree.
 *
 * The one hard rule of this file: a push that cannot be delivered is a log line. The sender hangs
 * off the event bus, and an endpoint that is gone, slow or broken must never throw into it.
 */

/** The push service keeps the message this long while the device is offline. */
const TTL_SECONDS = 3600;

/** A payload is capped by the push services at ~4 KB; this leaves room for the encryption overhead. */
const MAX_PAYLOAD_BYTES = 3500;

/** Enough of what a push service answered to act on, and not enough to fill a log with HTML. */
const MAX_REASON = 200;

/** Keys of the dedupe window we still remember; past this the oldest half goes. */
const MAX_RECENT_KEYS = 2000;

const MAX_LABEL = 120;
const MAX_ENDPOINT = 1000;

interface PushDoc {
  publicKey: string;
  privateKey: string;
  /** The VAPID `sub` claim last configured; the keypair is fixed for ever, this is not */
  subject: string;
  createdAt: string;
}

/** What a send attempt did to one install, which is all the caller needs to count. */
type Delivery = 'sent' | 'removed' | 'failed';

/** That, and why — the reason is what turns "push failed" into something a person can act on. */
interface Outcome {
  delivery: Delivery;
  reason: string | null;
}

export interface PushSendOptions {
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
  TTL: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
}

/** The transport, injectable so the tests can drive the sender without a push service. */
export type PushTransport = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: PushSendOptions,
) => Promise<unknown>;

const defaultTransport: PushTransport = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);

/** A payload travels through a relay we do not run, so it carries only what a lock screen shows anyway. */
export function payloadOf(draft: NotificationDraft): PushPayload {
  return {
    kind: draft.kind,
    key: draft.key,
    title: draft.title,
    body: draft.body,
    href: draft.href,
    at: draft.at,
    priority: draft.priority,
    runId: draft.runId,
    orchestrationId: draft.orchestrationId,
  };
}

/** Same install, same id, whatever the row: the browser recognises itself by the id its registration returned. */
export const idOfEndpoint = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

/**
 * Enough of an endpoint to tell two installs apart, and not enough to notify one: the full URL is a
 * capability, and the list of registered devices is not the place to hand it out.
 */
export function truncateEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const tail = url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    return `${url.origin}/…${tail.slice(-6)}`;
  } catch {
    return `${endpoint.slice(0, 24)}…`;
  }
}

export function summaryOf(record: PushSubscriptionRecord): PushSubscriptionSummary {
  return {
    id: record.id,
    endpoint: truncateEndpoint(record.endpoint),
    label: record.label,
    kinds: record.kinds,
    level: record.level,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
  };
}

/** An endpoint has to be an absolute https URL: it is a URL this server will POST to. */
function parseEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('endpoint is required');
  const endpoint = value.trim();
  if (endpoint.length > MAX_ENDPOINT) throw new Error(`endpoint is longer than ${String(MAX_ENDPOINT)} characters`);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('endpoint must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw new Error('endpoint must be an https URL');
  return endpoint;
}

/** Validates what a browser sent. A bad value is refused rather than replaced: a wrong key never delivers. */
export function parseRegistration(input: unknown): Required<RegisterPushSubscriptionRequest> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('a push subscription must be a JSON object');
  const body = input as Record<string, unknown>;
  const endpoint = parseEndpoint(body.endpoint);
  const keys = body.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('keys must hold p256dh and auth');
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== 'string' || !p256dh.trim()) throw new Error('keys.p256dh is required');
  if (typeof auth !== 'string' || !auth.trim()) throw new Error('keys.auth is required');
  if (body.kinds !== undefined && !Array.isArray(body.kinds)) throw new Error('kinds must be an array');
  const asked = Array.isArray(body.kinds) ? (body.kinds as unknown[]) : null;
  if (asked) {
    const unknownKind = asked.find((kind) => !KINDS.includes(kind as NotificationKind));
    if (unknownKind !== undefined) throw new Error(`unknown notification kind: ${String(unknownKind)}`);
  }
  const kinds = asked ? (asked as NotificationKind[]) : [...KINDS];
  if (body.level !== undefined && !LEVELS.includes(body.level as NotificationLevel)) throw new Error(`level must be one of ${LEVELS.join(', ')}`);
  const level = (body.level as NotificationLevel | undefined) ?? DEFAULT_LEVEL;
  if (body.label !== undefined && typeof body.label !== 'string') throw new Error('label must be a string');
  const label = (typeof body.label === 'string' ? body.label : '').trim().slice(0, MAX_LABEL);
  return { endpoint, keys: { p256dh: p256dh.trim(), auth: auth.trim() }, kinds, level, label: label || 'This device' };
}

function parseRef(input: unknown, what: string): { id?: string; endpoint?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${what} must be a JSON object`);
  const body = input as Record<string, unknown>;
  if (typeof body.endpoint === 'string' && body.endpoint.trim()) return { endpoint: parseEndpoint(body.endpoint) };
  if (typeof body.id === 'string' && body.id.trim()) return { id: body.id.trim() };
  return {};
}

export interface PushServiceOptions {
  config: CoreConfig;
  db: Db;
  events: EventBus;
  /** Replaced in the tests; in production every push goes out through `web-push` */
  transport?: PushTransport;
}

/**
 * The VAPID keypair, the registered installs, and the sender that turns an event on the bus into a
 * notification on a phone.
 */
export class PushService {
  private readonly config: CoreConfig;
  private readonly db: Db;
  private readonly transport: PushTransport;
  private readonly file: string;
  private readonly unobserve: () => void;
  private doc: PushDoc | null = null;
  /** In flight while the keypair is being made, so a burst of events cannot each make their own */
  private making: Promise<PushDoc | null> | null = null;
  /** Keyed by the draft's dedupe key: the same news inside its window is not pushed twice. */
  private readonly recent = new Map<string, number>();
  /** Nothing in core has a logger; the API hands it one, and until then a failure is silent. */
  log: (line: string) => void = () => undefined;

  constructor({ config, db, events, transport = defaultTransport }: PushServiceOptions) {
    this.config = config;
    this.db = db;
    this.transport = transport;
    this.file = join(config.dataDir, 'push.json');
    if (existsSync(this.file)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        this.doc = readDoc(raw);
      } catch {
        // A keypair we cannot read is a keypair nobody is subscribed against either; the next
        // `ensureKeys` writes a fresh one rather than leaving push broken for good.
        this.doc = null;
      }
    }
    // `observe`, not `subscribe`: the sender is core reacting to its own events, and it must not
    // count as a client and keep the watchers awake that only run while someone is listening.
    this.unobserve = events.observe((event) => this.onEvent(event));
  }

  /** What a browser needs to subscribe. Makes the keypair on first use, so an install needs no setup step. */
  async keyInfo(): Promise<PushKeyInfo> {
    const doc = await this.ensureKeys();
    return { configured: doc !== null, publicKey: doc?.publicKey ?? null };
  }

  list(): PushSubscriptionSummary[] {
    return this.db.pushSubscriptions().map(summaryOf);
  }

  /** Registers an install, or refreshes the row that already holds its endpoint. */
  register(input: unknown): PushSubscriptionSummary {
    const request = parseRegistration(input);
    const now = new Date().toISOString();
    const record = this.db.savePushSubscription({
      id: idOfEndpoint(request.endpoint),
      endpoint: request.endpoint,
      p256dh: request.keys.p256dh,
      auth: request.keys.auth,
      kinds: request.kinds,
      level: request.level,
      label: request.label,
      createdAt: now,
      lastSeenAt: now,
    });
    return summaryOf(record);
  }

  /** `removed: false` when there was no such install, which is what a second unsubscribe is. */
  remove(input: unknown): { removed: boolean } {
    const ref = parseRef(input, 'the subscription to remove');
    if (!ref.id && !ref.endpoint) throw new Error('provide the endpoint or the id of the subscription to remove');
    return { removed: this.db.deletePushSubscription(ref) };
  }

  /**
   * One notification a person asked for, so they can prove push works without waiting for a chat to
   * stop. Aimed at one install, or at every registered one when the body names none.
   */
  async test(input: unknown): Promise<PushSendResult> {
    const ref = input === undefined || input === null ? {} : parseRef(input, 'the subscription to test');
    const named = ref.id !== undefined || ref.endpoint !== undefined;
    const targets = named
      ? [this.db.pushSubscription(ref)].filter((record): record is PushSubscriptionRecord => record !== null)
      : this.db.pushSubscriptions();
    if (!targets.length) throw new Error(named ? 'that push subscription is not registered' : 'no push subscription is registered');
    const at = new Date().toISOString();
    return this.deliver(targets, {
      kind: 'activity',
      key: `push:test:${at}`,
      title: 'Agentry push works',
      body: 'This is the test notification you asked for.',
      href: null,
      at,
      priority: 'normal',
      runId: null,
      orchestrationId: null,
    });
  }

  close(): void {
    this.unobserve();
    this.recent.clear();
  }

  /**
   * The keypair as a document in the data directory, mode 600 inside the mode 700 data dir, like
   * the credentials file. Made once and never again: every subscription in the table was taken out
   * against this public key, and replacing it would silently orphan all of them.
   */
  private ensureKeys(): Promise<PushDoc | null> {
    if (this.doc) return Promise.resolve(this.withSubject(this.doc));
    this.making ??= this.makeKeys().finally(() => {
      this.making = null;
    });
    return this.making;
  }

  private async makeKeys(): Promise<PushDoc | null> {
    try {
      const keys = webpush.generateVAPIDKeys();
      const doc: PushDoc = { ...keys, subject: this.config.pushSubject, createdAt: new Date().toISOString() };
      await this.store(doc);
      this.doc = doc;
      return doc;
    } catch (error) {
      this.log(`could not create the VAPID keypair: ${messageOf(error)}`);
      return null;
    }
  }

  private async store(doc: PushDoc): Promise<void> {
    await writeAtomic(this.file, `${JSON.stringify(doc, null, 2)}\n`);
    chmodSync(this.file, 0o600);
  }

  /**
   * The configured `sub` claim, over the one the file was written with. The keypair itself can never
   * change — every subscription was taken out against it — but the claim is only an address a push
   * service can complain to, and an install whose stored one is refused (Apple answers `403
   * BadJwtToken` to a `sub` that names no real domain) has to be able to fix it by setting
   * `AGENTRY_PUSH_SUBJECT` and restarting, rather than by throwing its keypair and every registered
   * phone away.
   */
  private withSubject(doc: PushDoc): PushDoc {
    if (doc.subject === this.config.pushSubject) return doc;
    const next: PushDoc = { ...doc, subject: this.config.pushSubject };
    this.doc = next;
    // The send that asked for this already has what it needs; the file is caught up for the next
    // boot, and a write that fails is retried by the next send rather than failing the push.
    void this.store(next).catch((error: unknown) => this.log(`could not store the new push subject: ${messageOf(error)}`));
    return next;
  }

  /** Every event on the bus, read through the same function the browser reads it through. */
  private onEvent(event: AgentryEvent): void {
    const drafts = notificationsFor(event);
    if (!drafts.length) return;
    // Nothing is claimed before this: an event that arrives with nobody subscribed must not spend
    // the dedupe key that the next one of its kind would be collapsed against.
    const subscriptions = this.db.pushSubscriptions();
    if (!subscriptions.length) return;
    for (const draft of drafts) {
      if (!this.claim(draft)) continue;
      const targets = subscriptions.filter((record) => record.kinds.includes(draft.kind) && interrupts(draft, record.level));
      if (!targets.length) continue;
      // The bus calls this synchronously: the sending is deliberately not awaited, and every
      // failure inside it is already a log line rather than a rejection.
      void this.deliver(targets, payloadOf(draft));
    }
  }

  /**
   * False when this news already went out inside its dedupe window. The same key the browser uses to
   * collapse its own list, so a chat that asks twice replaces its notification instead of stacking.
   */
  private claim(draft: NotificationDraft): boolean {
    const now = Date.now();
    const last = this.recent.get(draft.key);
    if (last !== undefined && draft.dedupeMs > 0 && now - last < draft.dedupeMs) return false;
    if (last !== undefined && draft.dedupeMs === 0) return false; // a key that is unique forever
    this.recent.set(draft.key, now);
    if (this.recent.size > MAX_RECENT_KEYS) {
      for (const key of [...this.recent.keys()].slice(0, MAX_RECENT_KEYS / 2)) this.recent.delete(key);
    }
    return true;
  }

  private async deliver(targets: readonly PushSubscriptionRecord[], payload: PushPayload): Promise<PushSendResult> {
    const result: PushSendResult = { sent: 0, removed: 0, failed: 0 };
    const doc = await this.ensureKeys();
    if (!doc) {
      result.failed = targets.length;
      result.reason = 'the server has no VAPID keypair';
      return result;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
      // Nothing we put in a payload is this long, so this is a bug rather than a delivery problem
      this.log(`push payload for ${payload.key} is ${String(Buffer.byteLength(body))} bytes and was not sent`);
      result.failed = targets.length;
      result.reason = 'the notification is too long for a push service to carry';
      return result;
    }
    const outcomes = await Promise.all(targets.map((record) => this.deliverOne(record, body, payload, doc)));
    for (const outcome of outcomes) {
      result[outcome.delivery]++;
      // The first one that has something to say: a list of identical 403s helps nobody
      if (outcome.reason !== null && result.reason === undefined) result.reason = outcome.reason;
    }
    return result;
  }

  private async deliverOne(record: PushSubscriptionRecord, body: string, payload: PushPayload, doc: PushDoc): Promise<Outcome> {
    try {
      await this.transport({ endpoint: record.endpoint, keys: { p256dh: record.p256dh, auth: record.auth } }, body, {
        vapidDetails: { subject: doc.subject, publicKey: doc.publicKey, privateKey: doc.privateKey },
        TTL: TTL_SECONDS,
        urgency: payload.priority === 'high' ? 'high' : payload.priority === 'low' ? 'low' : 'normal',
      });
      return { delivery: 'sent', reason: null };
    } catch (error) {
      // A push endpoint answers 404 or 410 when it is gone for good. Anything kept after that is a
      // dead row the sender would retry for every event from now on.
      if (error instanceof webpush.WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
        this.db.deletePushSubscription({ endpoint: record.endpoint });
        this.log(`push subscription ${record.id} is gone (${String(error.statusCode)}); removed`);
        return { delivery: 'removed', reason: null };
      }
      const reason = reasonFor(error);
      this.log(`push to ${record.id} failed: ${reason}`);
      return { delivery: 'failed', reason };
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * What the push service actually said. `web-push` throws "Received unexpected response code" for
 * every refusal alike, and the status and body it hides are the whole diagnosis: a `403
 * {"reason":"BadJwtToken"}` from Apple is a misconfigured `sub` claim, not a phone that has gone.
 */
function reasonFor(error: unknown): string {
  if (!(error instanceof webpush.WebPushError)) return messageOf(error);
  const body = error.body.trim().slice(0, MAX_REASON);
  return body ? `${String(error.statusCode)} ${body}` : String(error.statusCode);
}

/** A stored document is only worth reading when it holds both halves of a keypair. */
function readDoc(raw: unknown): PushDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  const { publicKey, privateKey } = doc;
  if (typeof publicKey !== 'string' || !publicKey || typeof privateKey !== 'string' || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    // Empty rather than a default: `withSubject` puts the configured claim on it before any send
    subject: typeof doc.subject === 'string' ? doc.subject : '',
    createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : new Date().toISOString(),
  };
}
