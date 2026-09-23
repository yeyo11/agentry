import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Core } from '@agentry/core';
import { ROUTE_DOCS } from './openapi/routes.ts';

/**
 * The guard in front of every route, and the audit trail behind every write.
 *
 * Both are hooks on the root instance rather than a plugin around the API: `/docs` and
 * `/openapi.json` are registered outside the `/api` prefix and must be guarded too, and a hook is
 * the only thing a hijacked reply (the event streams) still goes through.
 */

const API_PREFIX = '/api';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Liveness has to answer a probe that carries no credential. It says nothing about the install. */
const OPEN = new Set([`${API_PREFIX}/health`]);

/**
 * `EventSource` and the browser's own GETs (an `<img src>`, a link) cannot carry an
 * `Authorization` header, so these five accept the credential as `?token=`. They are the only
 * ones: a token in a query string ends up in access logs, and a route that can be called with
 * `fetch` has no excuse. `GET /api/events` is the one the plan names; the chat stream is the same
 * kind of `EventSource`, an attachment is what the chat renders inline, and a transcript export is
 * a download link the browser follows itself — fetching a whole transcript into a blob to save it
 * would hold it twice in memory for no gain. A project export is the same download, only longer.
 */
const QUERY_TOKEN = [
  /^\/api\/events$/,
  /^\/api\/chats\/[^/]+\/stream$/,
  /^\/api\/uploads\/[^/]+\/content$/,
  /^\/api\/chats\/[^/]+\/export$/,
  /^\/api\/projects\/[^/]+\/export$/,
];

/**
 * Loopback is always ours: it is where a local install lives, and it is the address a rebinding
 * name resolves to on the second lookup. `::ffff:127.x.x.x` is the same address seen through a
 * dual-stack socket.
 */
const LOOPBACK = /^(?:localhost|::1|(?:::ffff:)?127(?:\.\d{1,3}){3})$/;

/** The authority without its port, with IPv6 brackets removed, lowercased so a name compares. */
function hostNameOf(authority: string): string {
  const value = authority.trim().toLowerCase();
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close === -1 ? value.slice(1) : value.slice(1, close);
  }
  const colon = value.indexOf(':');
  // Two colons and no brackets is an address written bare, not a name followed by a port
  return colon === -1 || value.includes(':', colon + 1) ? value : value.slice(0, colon);
}

/**
 * Whether this wrapper answers to the authority the client dialled.
 *
 * A browser sends the name it was pointed at, so a page served from a name with a one-second TTL
 * that rebinds to 127.0.0.1 arrives here carrying that name, and same-origin policy has stopped
 * protecting the install. Refusing an authority nobody configured is what closes it: a local
 * install is reached through loopback, and `AGENTRY_ALLOWED_HOSTS` names whatever else a
 * deployment answers to.
 *
 * A request with no `Host` at all passes: HTTP/1.1 requires one and every browser sends one, so it
 * cannot be the rebinding case, and refusing it would only cost an HTTP/1.0 probe.
 */
function hostAllowed(authority: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (authority === undefined) return true;
  const name = hostNameOf(authority);
  return LOOPBACK.test(name) || allowed.has(name);
}

/** Failed authentications a client address gets for free before it is asked to wait. */
const FAILURES_BEFORE_WAIT = 10;
const FIRST_WAIT_MS = 1_000;
const MAX_WAIT_MS = 60_000;
/** A client that stops failing for this long is forgotten: a mistyped token leaves no trace. */
const FORGET_AFTER_MS = 15 * 60_000;
/** The map is fed by whoever can reach the port, so it is bounded rather than trusted. */
const MAX_CLIENTS = 1024;

interface Failures {
  count: number;
  /** The last failure; both the wait and the forgetting are measured from it */
  at: number;
}

/**
 * Failed authentications per client address, with a wait that doubles.
 *
 * Written here rather than pulled in as a rate-limiting plugin, for the reason `cron.ts` gives for
 * its own parser: what this needs is a count and an instant per address, and a plugin would bring
 * a store, a policy language and a dependency to hold them. A token Agentry generates is 32 random
 * bytes and out of reach of guessing, but a token someone chooses is accepted from 16 characters,
 * and 16 characters under an unlimited online attack are not enough.
 *
 * The wait is per address and not per credential, so an honest client sharing an address with an
 * attacker pays it too: the cap is what keeps that to a minute instead of a lockout.
 */
export class FailureBackoff {
  private readonly clients = new Map<string, Failures>();

  /** The clock is a parameter so a test can watch a wait grow and a client be forgotten. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds before this client's credential is looked at again; 0 when it may try now. */
  retryAfter(client: string): number {
    const seen = this.clients.get(client);
    if (!seen) return 0;
    const now = this.now();
    if (now - seen.at >= FORGET_AFTER_MS) return 0;
    const remaining = seen.at + this.waitMs(seen.count) - now;
    return remaining > 0 ? Math.ceil(remaining / 1_000) : 0;
  }

  fail(client: string): void {
    const now = this.now();
    const seen = this.clients.get(client);
    const count = seen && now - seen.at < FORGET_AFTER_MS ? seen.count + 1 : 1;
    // Re-inserted, so the map runs least-recent first and eviction drops from the front
    this.clients.delete(client);
    this.clients.set(client, { count, at: now });
    this.evict(now);
  }

  succeed(client: string): void {
    this.clients.delete(client);
  }

  /** Addresses remembered right now. Bounded by `MAX_CLIENTS`, which is what a test checks. */
  get size(): number {
    return this.clients.size;
  }

  private waitMs(count: number): number {
    if (count < FAILURES_BEFORE_WAIT) return 0;
    return Math.min(FIRST_WAIT_MS * 2 ** (count - FAILURES_BEFORE_WAIT), MAX_WAIT_MS);
  }

  private evict(now: number): void {
    if (this.clients.size <= MAX_CLIENTS) return;
    for (const [client, seen] of this.clients) {
      if (this.clients.size <= MAX_CLIENTS) return;
      if (now - seen.at >= FORGET_AFTER_MS) this.clients.delete(client);
    }
    // Still full: the least recent failure goes, which at worst hands one client a clean slate
    for (const client of this.clients.keys()) {
      if (this.clients.size <= MAX_CLIENTS) return;
      this.clients.delete(client);
    }
  }
}

/**
 * What read-only still lets through. Answering a prompt is the point of it: a person watching a
 * chat has to be able to unblock it. The guard's own switch stays reachable because a switch that
 * cannot be turned back is a trap, and it is administration of the wrapper, not of its work.
 */
const READ_ONLY_ALLOWED = new Set([`POST ${API_PREFIX}/chats/:id/permissions/:requestId`, `PUT ${API_PREFIX}/security/auth`]);

/** Only what this process serves is guarded; the UI bundle is public so a 401 has a page to show. */
const isGuarded = (path: string): boolean => path === '/openapi.json' || path === '/docs' || path.startsWith('/docs/') || path.startsWith(`${API_PREFIX}/`);

const pathOf = (url: string): string => url.split('?')[0] ?? url;

function credentialOf(req: FastifyRequest, path: string): string | undefined {
  const [scheme, ...rest] = (req.headers.authorization ?? '').split(' ');
  if (scheme?.toLowerCase() === 'bearer' && rest.length) return rest.join(' ').trim();
  // A header that is not a bearer token (a proxy's own `Basic`, say) is not ours: fall through
  if (req.method !== 'GET' || !QUERY_TOKEN.some((re) => re.test(path))) return undefined;
  const token = (req.query as { token?: unknown } | undefined)?.token;
  return typeof token === 'string' && token ? token : undefined;
}

/**
 * One line about what a request did, taken from the route's own documentation. Built from the
 * route and never from the payload: a body holds prompts and secrets and is not written down.
 */
export function auditSummary(method: string, routeUrl: string | undefined, path: string): string {
  const pattern = routeUrl?.startsWith(API_PREFIX) ? routeUrl.slice(API_PREFIX.length) : undefined;
  const doc = pattern ? ROUTE_DOCS[`${method} ${pattern}`] : undefined;
  return doc?.summary ?? `${method} ${path}`;
}

export function registerSecurity(app: FastifyInstance, core: Core): void {
  // `null` and not a string: Fastify v5 refuses a shared reference, and the value is per request
  app.decorateRequest('actor', null);

  // Read once and not per request: the allowlist is deployment configuration. It comes from the
  // core's config rather than from `process.env`, so a test can build a wrapper with its own.
  const allowedHosts = new Set(core.config.allowedHosts);
  const backoff = new FailureBackoff();

  app.addHook('onRequest', async (req, reply) => {
    // A CORS preflight carries no credential by definition, and answering it reveals nothing
    if (req.method === 'OPTIONS') return;
    const path = pathOf(req.url);
    const guarded = isGuarded(path) && !OPEN.has(path);
    const mode = core.security.mode;
    // Before the credential, because an authority this wrapper does not serve is refused whether
    // or not the caller holds one: under `mode: 'none'` there is no credential to refuse it by
    if (guarded && !hostAllowed(req.headers.host, allowedHosts)) {
      req.actor = 'anonymous';
      void reply.status(421).send({
        error: 'this wrapper does not answer to that host. Reach it on localhost, or name the host in AGENTRY_ALLOWED_HOSTS.',
      });
      return reply;
    }
    if (guarded && mode !== 'none') {
      const wait = backoff.retryAfter(req.ip);
      if (wait > 0) {
        req.actor = 'anonymous';
        // Not counted as another failure: a client that kept trying would never serve its wait
        void reply.header('Retry-After', String(wait)).status(429).send({ error: 'too many failed authentications from this address', mode });
        return reply;
      }
      const actor = await core.security.actorFor(credentialOf(req, path));
      if (!actor) {
        backoff.fail(req.ip);
        // Still audited when it is a write, and as what it was: nobody we could name
        req.actor = 'anonymous';
        // The mode travels with the refusal: it is what tells the UI whether to ask for a token
        // or to send the person to their identity provider, without an open route to ask first.
        void reply
          .header('WWW-Authenticate', mode === 'token' ? 'Bearer realm="Agentry"' : `Bearer realm="Agentry", error="invalid_token"`)
          .status(401)
          .send({ error: 'authentication required', mode });
        return reply;
      }
      backoff.succeed(req.ip);
      req.actor = actor;
    }
    req.actor ??= 'local';

    if (core.security.readOnly && MUTATING.has(req.method) && isGuarded(path)) {
      const routeUrl = req.routeOptions.url;
      if (!routeUrl || !READ_ONLY_ALLOWED.has(`${req.method} ${routeUrl}`)) {
        void reply.status(405).send({
          error: 'read-only mode is on: this wrapper accepts no changes. Turn it off with PUT /api/security/auth, which stays open for exactly that.',
        });
        return reply;
      }
    }
    return;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const path = pathOf(req.url);
    if (!path.startsWith(`${API_PREFIX}/`)) return;
    core.db.appendAudit({
      at: new Date().toISOString(),
      actor: req.actor ?? 'local',
      method: req.method,
      // The query string is dropped: it can carry `?token=`, and the path is what a filter needs
      path,
      status: reply.statusCode,
      summary: auditSummary(req.method, req.routeOptions.url, path),
    });
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Who made the request: a token id, an OIDC subject, or `local` when nothing guards the API */
    actor: string | null;
  }
}
