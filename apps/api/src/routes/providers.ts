import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { ProviderStatus, ProvidersSettings } from '@agentry/shared';

/**
 * The agents Agentry can drive: what each one's detection found (served from the detector's cache),
 * a re-detection on demand, and the settings document. Validation lives in core. The settings write
 * is refused to a chat's token in `security.ts`: it names a binary Agentry will run.
 */
export const providerRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/providers', (): Promise<ProviderStatus[]> => core.providers.statuses());

  app.post('/providers/refresh', (): Promise<ProviderStatus[]> => core.providers.refresh());

  app.get('/providers/settings', (): ProvidersSettings => core.providersSettings.get());

  app.put<{ Body: unknown }>('/providers/settings', async (req): Promise<ProvidersSettings> => {
    const settings = await core.providersSettings.set(req.body);
    // The answer does not wait for the probes: `providers.changed` tells every page what they found
    core.providers.settingsChanged().catch((err: unknown) => app.log.warn({ err }, 'providers: re-detection after a settings change failed'));
    return settings;
  });

  app.get<{ Params: { id: string } }>('/providers/:id', async (req): Promise<ProviderStatus> => {
    const status = (await core.providers.statuses()).find((s) => s.id === req.params.id);
    if (!status) throw Object.assign(new Error(`provider ${req.params.id} not found`), { statusCode: 404 });
    return status;
  });
};
