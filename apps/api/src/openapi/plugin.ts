import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { routeSchema, TAGS } from './routes.ts';
// Imported rather than read from disk so the document survives bundling into a single file
import schemas from './schemas.json' with { type: 'json' };

const API_PREFIX = '/api';

/**
 * OpenAPI 3.1 document + Scalar reference UI. Must be registered before the routes so the
 * `onRoute` hook can attach each route's documentation (see routes.ts).
 *   /docs          interactive API reference
 *   /openapi.json  the raw document
 */
export async function registerOpenApi(app: FastifyInstance, version: string): Promise<void> {
  // Route schemas are documentation only. Input validation lives in @agentry/core (single source of
  // truth for error messages) and responses must never be stripped down to the documented fields.
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Agentry API',
        version,
        description:
          'REST + SSE API over the Claude Code CLI: runs, sessions, orchestration, plugins, memory and every ' +
          'piece of user or project configuration.\n\nErrors are `{ "error": "…" }` with a 4xx status.\n\n' +
          'Authentication is off by default (`mode: none`), which is what a local install wants. With `token` ' +
          'or `oidc` (see the Security tag) every route needs `Authorization: Bearer …` except `GET /api/health`; ' +
          'Agentry never terminates TLS itself, so put a reverse proxy in front before exposing the port.',
      },
      servers: [{ url: '/', description: 'This wrapper' }],
      tags: TAGS,
      components: { schemas: schemas as never },
    },
    // Component schemas are injected verbatim above; route-level $refs already point at them
    refResolver: { buildLocalReference: (json, _base, _fragment, i) => (typeof json.$id === 'string' ? json.$id : `def-${i}`) },
  });

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(`${API_PREFIX}/`)) return;
    const path = route.url.slice(API_PREFIX.length);
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      const schema = routeSchema(method, path);
      if (schema) route.schema = { ...schema, ...route.schema };
    }
  });

  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  // The Fastify plugin types only cover part of Scalar's configuration; the object is handed to
  // the reference client as is, so the remaining options are valid at runtime.
  const configuration = {
    url: '/openapi.json',
    theme: 'default',
    layout: 'modern',
    metaData: { title: 'Agentry API' },
    hideClientButton: true,
    // Self-hosted and private: no Scalar cloud features, no telemetry
    showToolbar: 'never',
    showDeveloperTools: 'never',
    telemetry: false,
    mcp: { disabled: true },
    agent: { disabled: true },
  };
  await app.register(scalar, { routePrefix: '/docs', configuration: configuration as never });
}
