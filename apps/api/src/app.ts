import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Core } from '@agentry/core';
import { registerOpenApi } from './openapi/plugin.ts';
import { accountRoutes } from './routes/accounts.ts';
import { configRoutes } from './routes/config.ts';
import { eventRoutes } from './routes/events.ts';
import { memoryRoutes } from './routes/memory.ts';
import { orchestrationRoutes } from './routes/orchestrations.ts';
import { pluginRoutes } from './routes/plugins.ts';
import { runRoutes } from './routes/runs.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { systemRoutes } from './routes/system.ts';
import { uploadRoutes } from './routes/uploads.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  logLevel?: string;
  /** Built UI to serve; skipped when the directory does not exist */
  webDist?: string;
}

export async function buildApp(core: Core, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info' } });

  // The UI never needs CORS: in dev it goes through the Vite proxy and in production it is served
  // from this same origin. Enable it only for external browser clients.
  const corsOrigin = process.env.AGENTRY_CORS_ORIGIN;
  if (corsOrigin) await app.register(cors, { origin: corsOrigin === '*' ? true : corsOrigin.split(',') });

  // Core throws plain Errors for bad input / missing things; map them to 4xx instead of 500.
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const notFound = /not found/i.test(err.message);
    const status = err.statusCode ?? (notFound ? 404 : 400);
    if (status >= 500) app.log.error(err);
    void reply.status(status).send({ error: err.message });
  });

  await registerOpenApi(app, (await core.system()).version);

  await app.register(
    async (api) => {
      await api.register(systemRoutes, { core });
    await api.register(accountRoutes, { core });
      await api.register(sessionRoutes, { core });
      await api.register(eventRoutes, { core });
      await api.register(runRoutes, { core });
      await api.register(orchestrationRoutes, { core });
      await api.register(configRoutes, { core });
      await api.register(pluginRoutes, { core });
      await api.register(memoryRoutes, { core });
      await api.register(uploadRoutes, { core });
    },
    { prefix: '/api' },
  );

  // In production the API also serves the built UI (single container, single port).
  const webDist = resolve(options.webDist ?? process.env.AGENTRY_WEB_DIST ?? resolve(here, '../../web/dist'));
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.status(404).send({ error: 'route not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
