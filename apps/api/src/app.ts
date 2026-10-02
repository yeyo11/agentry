import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import etag from '@fastify/etag';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Core } from '@agentry/core';
import { allowedOrigin } from './origins.ts';
import { registerOpenApi } from './openapi/plugin.ts';
import { registerSecurity } from './security.ts';
import { accountRoutes } from './routes/accounts.ts';
import { chatRoutes } from './routes/chats.ts';
import { configRoutes } from './routes/config.ts';
import { connectorRoutes } from './routes/connectors.ts';
import { appSettingsRoutes } from './routes/app-settings.ts';
import { tunnelRoutes } from './routes/tunnel.ts';
import { eventRoutes } from './routes/events.ts';
import { flowRoutes } from './routes/flow.ts';
import { journalRoutes } from './routes/journal.ts';
import { memoryRoutes } from './routes/memory.ts';
import { orchestrationRoutes } from './routes/orchestrations.ts';
import { pluginRoutes } from './routes/plugins.ts';
import { projectRoutes } from './routes/projects.ts';
import { pushRoutes } from './routes/push.ts';
import { securityRoutes } from './routes/security.ts';
import { scheduleRoutes } from './routes/schedules.ts';
import { supervisorRoutes } from './routes/supervisor.ts';
import { decisionRoutes } from './routes/decisions.ts';
import { providerRoutes } from './routes/providers.ts';
import { changeRequestRoutes } from './routes/change-requests.ts';
import { hostRoutes } from './routes/hosts.ts';
import { trackerRoutes } from './routes/trackers.ts';
import { systemRoutes } from './routes/system.ts';
import { teamRoutes } from './routes/team.ts';
import { toolPresetRoutes } from './routes/tool-presets.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { workItemRoutes } from './routes/work-items.ts';
import { documentRoutes } from './routes/documents.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { webhookRoutes } from './routes/webhooks.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A failure the caller cannot act on: its text is for us, not for them.
 *
 * Core refuses on purpose with a hand-thrown `Error` — or with one that declares its status, the
 * way `ChatConflictError` does — and that text is the answer. Everything else (a `TypeError`, a
 * `SyntaxError`, an `ENOENT` carrying the absolute path it tried to open) is a bug in this
 * process, and its message spells out where the host keeps its files and who runs it.
 */
function deliberate(err: Error & { statusCode?: number; code?: string; validation?: unknown }): boolean {
  if (typeof err.statusCode === 'number') return true;
  if (err.validation !== undefined) return true;
  // Node stamps what it raises itself with `code` / `syscall`; only `new Error(...)` arrives bare
  return Object.getPrototypeOf(err) === Error.prototype && err.code === undefined && !('syscall' in err);
}

/**
 * What the UI bundle is allowed to load and who is allowed to frame it.
 *
 * The panel keeps its bearer token in `localStorage`, so an XSS anywhere — here or in a
 * dependency we did not write — would be a token theft. Everything the bundle needs is
 * same-origin, which makes the policy cheap: the one inline script `index.html` carries (the
 * theme stamp, which has to run before first paint) is allowed by the hash of what is actually on
 * disk, so an injected script has nothing to hide behind.
 *
 * `style-src` keeps `'unsafe-inline'`: Vite's build has no nonce to hand out, and the way in from
 * there is a defacement, not the token — `img-src` and `font-src` already deny CSS the
 * off-origin fetch it would need to send anything anywhere.
 */
function contentSecurityPolicy(indexHtml: string): string {
  const inlineScripts = [...indexHtml.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  const hashes = inlineScripts.map((match) => `'sha256-${createHash('sha256').update(match[1] ?? '', 'utf8').digest('base64')}'`);
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    // Attachments are served from here; a preview before the upload lands is a blob, an icon a data URI
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** `frame-ancestors` is the one browsers honour; `X-Frame-Options` is for whatever does not. */
function uiHeaders(webDist: string): Record<string, string> {
  const index = join(webDist, 'index.html');
  return {
    'Content-Security-Policy': contentSecurityPolicy(existsSync(index) ? readFileSync(index, 'utf8') : ''),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

export interface AppOptions {
  logLevel?: string;
  /** Built UI to serve; skipped when the directory does not exist */
  webDist?: string;
}

export async function buildApp(core: Core, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info' },
    // The event stream is a hijacked, never-ending response: without this a browser tab left open
    // keeps close() waiting until the orchestrator SIGKILLs the process
    forceCloseConnections: true,
  });

  // The UI never needs CORS: in dev it goes through the Vite proxy and in production it is served
  // from this same origin. Enable it only for external browser clients, and from the same list
  // the hijacked streams read, so there is one answer to who may read this API.
  if (process.env.AGENTRY_CORS_ORIGIN) {
    await app.register(cors, { origin: (origin, cb) => cb(null, allowedOrigin(origin) !== null) });
  }

  // Core throws plain Errors for bad input / missing things; map them to 4xx instead of 500.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const refusal = deliberate(err);
    const status = err.statusCode ?? (refusal ? (/not found/i.test(err.message) ? 404 : 400) : 500);
    // A bug here is ours to find: a 400 nobody logs is a server fault blamed on the caller
    if (!refusal || status >= 500) app.log.error({ err, url: req.url }, 'request failed');
    // A server fault's message stays inside unless it was written for the person (`expose`)
    const exposed = (err as { expose?: unknown }).expose === true;
    // A refusal a client acts on by its kind (why no pull request can be opened) names it as a code
    const reason = refusal && status < 500 ? (err as { reason?: unknown }).reason : undefined;
    // A review that was only partly posted names its post, which the person publishes or discards
    const postId = refusal && status < 500 ? (err as { postId?: unknown }).postId : undefined;
    void reply.status(status).send({
      error: status >= 500 && !exposed ? 'internal error' : err.message,
      ...(typeof reason === 'string' ? { code: reason } : {}),
      ...(typeof postId === 'string' ? { postId } : {}),
      // The first line the tracker's CLI answered with (redacted in core), shown under Agentry's sentence
      ...(refusal && status < 500 && typeof (err as { detail?: unknown }).detail === 'string' ? { detail: String((err as { detail?: unknown }).detail) } : {}),
    });
  });

  // Core has no logger of its own, and a push that cannot be delivered is a log line rather than
  // an exception thrown into the event path. This is where that line goes.
  core.push.log = (line) => app.log.warn({ scope: 'push' }, line);

  // Before every route: the guard must also cover /docs and the OpenAPI document
  registerSecurity(app, core);

  // The lists are JSON whose keys repeat on every row, so they shrink to a fifth or less; that is
  // what a phone behind the tunnel feels. The event streams are hijacked replies, which no hook
  // sees, so they stay uncompressed and flush each event as it is written. The tag is computed on
  // the JSON before it is compressed, and is weak because the bytes sent depend on the encoding
  await app.register(etag, { weak: true });
  await app.register(compress);

  // The panel sends the person's language with every request: the chats Agentry starts on its own
  // later, with no request behind them (the flow's runs), are titled in it. After the guard, so only
  // an allowed caller sets it
  app.addHook('onRequest', async (req) => core.noteLanguage(req.headers['accept-language']));

  await registerOpenApi(app, (await core.system()).version);

  await app.register(
    async (api) => {
      // Every answer here is someone's own data and changes at any moment: a browser may keep a
      // copy, but asks with its tag each time, and an unchanged list comes back as an empty 304
      api.addHook('onSend', async (req, reply, payload) => {
        if (req.method === 'GET' && !reply.hasHeader('cache-control')) void reply.header('cache-control', 'private, no-cache');
        return payload;
      });
      await api.register(systemRoutes, { core });
      await api.register(securityRoutes, { core });
      await api.register(accountRoutes, { core });
      await api.register(projectRoutes, { core });
      await api.register(workItemRoutes, { core });
      await api.register(teamRoutes, { core });
      await api.register(flowRoutes, { core });
      await api.register(documentRoutes, { core });
      await api.register(assistantRoutes, { core });
      await api.register(chatRoutes, { core });
      await api.register(eventRoutes, { core });
      await api.register(orchestrationRoutes, { core });
      await api.register(configRoutes, { core });
      await api.register(toolPresetRoutes, { core });
      await api.register(appSettingsRoutes, { core });
      await api.register(tunnelRoutes, { core });
      await api.register(pluginRoutes, { core });
      await api.register(connectorRoutes, { core });
      await api.register(memoryRoutes, { core });
      await api.register(journalRoutes, { core });
      await api.register(uploadRoutes, { core });
      await api.register(scheduleRoutes, { core });
      await api.register(supervisorRoutes, { core });
      await api.register(decisionRoutes, { core });
      await api.register(providerRoutes, { core });
      await api.register(hostRoutes, { core });
      await api.register(trackerRoutes, { core });
      await api.register(changeRequestRoutes, { core });
      await api.register(pushRoutes, { core });
      await api.register(webhookRoutes, { core });
    },
    { prefix: '/api' },
  );

  // In production the API also serves the built UI (single container, single port).
  const webDist = resolve(options.webDist ?? process.env.AGENTRY_WEB_DIST ?? resolve(here, '../../web/dist'));
  if (existsSync(webDist)) {
    const headers = Object.entries(uiHeaders(webDist));
    await app.register(fastifyStatic, {
      root: webDist,
      setHeaders: (reply) => {
        for (const [name, value] of headers) void reply.header(name, value);
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.status(404).send({ error: 'route not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
