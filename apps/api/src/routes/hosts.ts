import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { CodeHostStatus, CodeHostsSettings } from '@agentry/shared';

/**
 * The code hosts Agentry reaches through their own CLI (gh, glab): what detection found, served
 * from the detector's cache, a re-detection on demand, and the settings document. Validation lives
 * in core. The settings write and the refresh are refused to a chat's token in `security.ts`: the
 * write names a binary Agentry will run.
 */
export const hostRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/hosts', (): Promise<CodeHostStatus[]> => core.hosts.statuses());

  app.post('/hosts/refresh', (): Promise<CodeHostStatus[]> => core.hosts.refresh());

  app.get('/hosts/settings', (): CodeHostsSettings => core.hostsSettings.get());

  app.put<{ Body: unknown }>('/hosts/settings', async (req): Promise<CodeHostsSettings> => {
    const settings = await core.hostsSettings.set(req.body);
    // A host turned off changes what every project reads even when no status differs, so the
    // readiness cache goes now rather than when `hosts.changed` happens to fire
    core.pullRequests.forgetReadiness();
    // The answer does not wait for the probes: `hosts.changed` tells every page what they found
    core.hosts.settingsChanged().catch((err: unknown) => app.log.warn({ err }, 'hosts: re-detection after a settings change failed'));
    return settings;
  });

  app.get<{ Params: { id: string } }>('/hosts/:id', async (req): Promise<CodeHostStatus> => {
    const status = (await core.hosts.statuses()).find((s) => s.id === req.params.id);
    if (!status) throw Object.assign(new Error(`code host ${req.params.id} not found`), { statusCode: 404 });
    return status;
  });
};
