import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { PluginActionRequest } from '@agentry/shared';

/** Plugins and marketplaces, delegated to `claude plugin`. Actions return the CLI output verbatim. */
export const pluginRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/plugins', () => core.plugins.overview());
  app.get<{ Querystring: { q?: string } }>('/plugins/available', (req) => core.plugins.available(req.query.q));
  app.get<{ Querystring: { plugin?: string } }>('/plugins/details', (req) => core.plugins.details(req.query.plugin));

  for (const action of ['install', 'uninstall', 'enable', 'disable'] as const) {
    app.post<{ Body: PluginActionRequest }>(`/plugins/${action}`, (req) => core.plugins[action](req.body?.plugin, req.body?.scope));
  }

  app.post<{ Body: { source?: unknown } }>('/plugins/marketplaces', (req) => core.plugins.addMarketplace(req.body?.source));
  app.post<{ Body: { name?: unknown } }>('/plugins/marketplaces/update', (req) => core.plugins.updateMarketplace(req.body?.name));
  app.delete<{ Params: { name: string } }>('/plugins/marketplaces/:name', (req) => core.plugins.removeMarketplace(req.params.name));
};
