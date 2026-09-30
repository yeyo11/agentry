import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DESKTOP_ACTOR, type Core, type RuntimeHosts } from '@agentry/core';
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
 * The allowlist, read once into the two shapes it is matched by: the names answered outright, and
 * the suffixes a `*.` pattern stands for.
 *
 * A pattern exists for a deployment whose name is not fixed — a tunnel that mints a new host on
 * every start, a preview environment per branch — where naming each one would mean editing the
 * configuration as often as the host changes. It covers the subdomains of a domain and never the
 * domain itself, so an apex that is also served is listed on its own. The leading dot is kept in
 * the suffix, and that is the whole of what stops `*.example.com` from also answering to
 * `evil-example.com`.
 */
function allowlist(patterns: readonly string[]): { names: ReadonlySet<string>; suffixes: readonly string[] } {
  const names = new Set<string>();
  const suffixes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) suffixes.push(pattern.slice(1));
    else names.add(pattern);
  }
  return { names, suffixes };
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
function hostAllowed(authority: string | undefined, allowed: ReturnType<typeof allowlist>, runtime: RuntimeHosts): boolean {
  if (authority === undefined) return true;
  const name = hostNameOf(authority);
  return LOOPBACK.test(name) || allowed.names.has(name) || allowed.suffixes.some((suffix) => name.endsWith(suffix)) || runtime.get(name) !== undefined;
}

/**
 * The key `FailureBackoff` counts a failed credential under. Only a presented credential gets
 * here: for local traffic the key is `127.0.0.1`, shared by every process on the machine, so a
 * request carrying none is refused without touching the count (see `FailureBackoff`).
 * Everything through a tunnel arrives from loopback, so keyed by `req.ip` a stranger's ten wrong
 * guesses would make the owner wait too.
 * A request on a runtime host is keyed by the header its owner said carries the client's address,
 * and only there: on any other host nobody vouches for that header, and anybody on the machine
 * could set it to spend someone else's budget. Without a header, or without a value in it, the
 * host's traffic still gets a bucket of its own, apart from loopback.
 */
function backoffKey(req: FastifyRequest, runtime: RuntimeHosts): string {
  // No `Host` is no runtime host: the empty name is never one
  const name = req.headers.host === undefined ? '' : hostNameOf(req.headers.host);
  const host = runtime.get(name);
  if (!host) return req.ip;
  const header = host.clientIpHeader ? req.headers[host.clientIpHeader] : undefined;
  // The last hop is the one the provider added; whatever comes before it the client could write
  const client = (Array.isArray(header) ? header.at(-1) : header)?.split(',').at(-1)?.trim();
  return client ? `runtime:${name}:${client}` : `runtime:${name}`;
}

/**
 * Whether a request came from a process on this machine and was dialled there, which is the only
 * place the desktop app's secret is ever sent from. A loopback socket is not enough on its own:
 * a tunnel and a reverse proxy both arrive from loopback, carrying the public name they were
 * reached on. `req.ip` is the socket's address, since the app does not trust proxy headers.
 */
function fromLocalMachine(req: FastifyRequest): boolean {
  const host = req.headers.host;
  return LOOPBACK.test(req.ip) && host !== undefined && LOOPBACK.test(hostNameOf(host));
}

/**
 * Whether a chat token may be looked at: the socket peer is loopback, the name dialled is loopback,
 * and nothing says the request was relayed. The tunnel (`ssh -R` to 127.0.0.1) and any local
 * reverse proxy arrive from loopback too, so the peer alone would let a leaked chat token in from
 * the internet; they are told apart by the public name they carry and the headers they add. The
 * socket is read rather than `req.ip`, so trusting a proxy one day cannot widen this.
 */
function fromLocalChat(req: FastifyRequest, runtime: RuntimeHosts): boolean {
  const peer = req.socket.remoteAddress;
  const host = req.headers.host;
  if (peer === undefined || !LOOPBACK.test(peer) || host === undefined) return false;
  const name = hostNameOf(host);
  // `localhost` is loopback by definition; a runtime host is refused even if it were named so
  if (!LOOPBACK.test(name) || runtime.get(name) !== undefined) return false;
  if (req.headers.forwarded !== undefined || req.headers['x-forwarded-for'] !== undefined) return false;
  return !runtime.list().some((each) => {
    const header = runtime.get(each)?.clientIpHeader;
    return header !== undefined && req.headers[header] !== undefined;
  });
}

/**
 * What a chat's own token cannot do: administer the guard in front of it. A prompt injection
 * holding it could otherwise rotate the owner's token, switch the guard off or open the tunnel.
 * Stopping the tunnel stays allowed, because it only reduces exposure.
 */
const CHAT_FORBIDDEN = new Set([
  `PUT ${API_PREFIX}/security/auth`,
  `POST ${API_PREFIX}/security/token`,
  `DELETE ${API_PREFIX}/security/token`,
  `POST ${API_PREFIX}/tunnel/start`,
  `PUT ${API_PREFIX}/tunnel/settings`,
]);

/**
 * Consent is the owner's (D12): these widen what the decision engine sends off the machine, so a
 * prompt injection in a chat must not be able to consent to a point or switch the provider to Jev.
 * A project's own override, which does not touch consent, stays open through the project settings.
 */
const CHAT_FORBIDDEN_DECISIONS = new Set([
  `PUT ${API_PREFIX}/decisions/settings`,
  `PUT ${API_PREFIX}/decisions/credentials`,
  `DELETE ${API_PREFIX}/decisions/credentials`,
  `PUT ${API_PREFIX}/decisions/points/:point/consent`,
  // What the person did is theirs to report: a chat must not write the signal a resolver judges by
  `POST ${API_PREFIX}/decisions/:id/palette-action`,
  `POST ${API_PREFIX}/decisions/notification-opened`,
]);

/**
 * The desktop app's secret exists to let its tray read what is live, so it reads and nothing
 * else: a secret that has to sit in a second process's memory is kept to the least it needs.
 */
const DESKTOP_METHODS = new Set(['GET', 'HEAD']);

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
 *
 * Only a credential that was presented and failed is counted. A request with none at all is not a
 * guess: it cannot get closer to the token by repeating itself, and on a local install every
 * process on the machine shares 127.0.0.1, so a tray, a stale tab or a chat polling without a
 * credential would otherwise make the owner's own authenticated window wait.
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
  // An empty bearer is no credential rather than a wrong one, so it is not counted as a guess
  if (scheme?.toLowerCase() === 'bearer' && rest.length) return rest.join(' ').trim() || undefined;
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

  // Read on every request, because the settings page can change it, but only rebuilt when it did:
  // the store hands out the same array until then. It comes from the core rather than from
  // `process.env`, so a test can build a wrapper with its own.
  let configured = { from: core.appSettings.allowedHosts, allowed: allowlist(core.appSettings.allowedHosts) };
  const allowedHosts = (): ReturnType<typeof allowlist> => {
    const from = core.appSettings.allowedHosts;
    if (from !== configured.from) configured = { from, allowed: allowlist(from) };
    return configured.allowed;
  };
  const runtimeHosts = core.appSettings.runtimeHosts;
  const backoff = new FailureBackoff();

  app.addHook('onRequest', async (req, reply) => {
    // A CORS preflight carries no credential by definition, and answering it reveals nothing
    if (req.method === 'OPTIONS') return;
    const path = pathOf(req.url);
    const guarded = isGuarded(path) && !OPEN.has(path);
    const mode = core.security.mode;
    // Before the credential, because an authority this wrapper does not serve is refused whether
    // or not the caller holds one: under `mode: 'none'` there is no credential to refuse it by
    if (guarded && !hostAllowed(req.headers.host, allowedHosts(), runtimeHosts)) {
      req.actor = 'anonymous';
      void reply.status(421).send({
        error: 'this wrapper does not answer to that host. Reach it on localhost, or name the host in AGENTRY_ALLOWED_HOSTS.',
      });
      return reply;
    }
    if (guarded && mode !== 'none') {
      // Still audited when it is a write, and as what it was: nobody we could name
      const refuse = () => {
        req.actor = 'anonymous';
        // The mode travels with the refusal: it is what tells the UI whether to ask for a token
        // or to send the person to their identity provider, without an open route to ask first.
        return reply
          .header('WWW-Authenticate', mode === 'token' ? 'Bearer realm="Agentry"' : `Bearer realm="Agentry", error="invalid_token"`)
          .status(401)
          .send({ error: 'authentication required', mode });
      };
      const credential = credentialOf(req, path);
      // Nothing to check is nothing guessed: neither counted nor made to wait, so a local process
      // polling without a credential cannot lock the owner out of their own install
      if (credential === undefined) {
        void refuse();
        return reply;
      }
      const client = backoffKey(req, runtimeHosts);
      const wait = backoff.retryAfter(client);
      if (wait > 0) {
        req.actor = 'anonymous';
        // Not counted as another failure: a client that kept trying would never serve its wait
        void reply.header('Retry-After', String(wait)).status(429).send({ error: 'too many failed authentications from this address', mode });
        return reply;
      }
      const owner = await core.security.actorFor(credential, fromLocalMachine(req));
      // The owner's credential first; a chat token is only ever the fallback, and fails the same
      // way. Told apart by where it came from, not by its prefix: an OIDC subject could be anything
      const chat = owner === null ? core.security.chatActorFor(credential, fromLocalChat(req, runtimeHosts)) : null;
      const actor = owner ?? chat;
      if (!actor) {
        backoff.fail(client);
        void refuse();
        return reply;
      }
      backoff.succeed(client);
      req.actor = actor;
      if (actor === DESKTOP_ACTOR && !DESKTOP_METHODS.has(req.method)) {
        void reply.status(403).send({ error: "the desktop app's own credential only reads; sign in with the API token to change anything" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot change the API's authentication" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_DECISIONS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot change what the decision engine sends" });
        return reply;
      }
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
    /** Who made the request: a token id, an OIDC subject, `desktop`, `chat:<chatId>`, or `local` when nothing guards the API */
    actor: string | null;
  }
}
