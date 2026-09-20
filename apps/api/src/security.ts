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
 * `Authorization` header, so these three accept the credential as `?token=`. They are the only
 * ones: a token in a query string ends up in access logs, and a route that can be called with
 * `fetch` has no excuse. `GET /api/events` is the one the plan names; the chat stream is the same
 * kind of `EventSource`, and an attachment is what the chat renders inline.
 */
const QUERY_TOKEN = [/^\/api\/events$/, /^\/api\/chats\/[^/]+\/stream$/, /^\/api\/uploads\/[^/]+\/content$/];

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

  app.addHook('onRequest', async (req, reply) => {
    // A CORS preflight carries no credential by definition, and answering it reveals nothing
    if (req.method === 'OPTIONS') return;
    const path = pathOf(req.url);
    const guarded = isGuarded(path) && !OPEN.has(path);
    const mode = core.security.mode;
    if (guarded && mode !== 'none') {
      const actor = await core.security.actorFor(credentialOf(req, path));
      if (!actor) {
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
