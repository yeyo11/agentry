import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
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
import { editorRoutes } from './routes/editor.ts';
import { eventRoutes } from './routes/events.ts';
import { memoryRoutes } from './routes/memory.ts';
import { orchestrationRoutes } from './routes/orchestrations.ts';
import { pluginRoutes } from './routes/plugins.ts';
import { projectRoutes } from './routes/projects.ts';
import { securityRoutes } from './routes/security.ts';
import { scheduleRoutes } from './routes/schedules.ts';
import { supervisorRoutes } from './routes/supervisor.ts';
import { systemRoutes } from './routes/system.ts';
import { toolPresetRoutes } from './routes/tool-presets.ts';
import { uploadRoutes } from './routes/uploads.ts';

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
    void reply.status(status).send({ error: status >= 500 ? 'internal error' : err.message });
  });

  // Before every route: the guard must also cover /docs and the OpenAPI document
  registerSecurity(app, core);

  await registerOpenApi(app, (await core.system()).version);

  await app.register(
    async (api) => {
      await api.register(systemRoutes, { core });
      await api.register(securityRoutes, { core });
      await api.register(accountRoutes, { core });
      await api.register(projectRoutes, { core });
      await api.register(chatRoutes, { core });
      await api.register(eventRoutes, { core });
      await api.register(orchestrationRoutes, { core });
      await api.register(configRoutes, { core });
      await api.register(toolPresetRoutes, { core });
      await api.register(editorRoutes, { core });
      await api.register(pluginRoutes, { core });
      await api.register(connectorRoutes, { core });
      await api.register(memoryRoutes, { core });
      await api.register(uploadRoutes, { core });
      await api.register(scheduleRoutes, { core });
      await api.register(supervisorRoutes, { core });
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
