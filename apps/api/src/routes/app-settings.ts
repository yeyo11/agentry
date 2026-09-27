import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/** The settings that change at runtime, layered under the environment: `app-settings.json`. */
export const appSettingsRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/settings/app', () => core.appSettings.get());

  app.put<{ Body: unknown }>('/settings/app', (req) => core.appSettings.update(req.body));
};
