import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { TrackerStatus, TrackersSettings, YoutrackCredentialsStatus } from '@agentry/shared';

/**
 * The issue trackers Agentry reads and writes through a CLI: what detection found, derived from the
 * code hosts' cache, a re-detection on demand, and the settings document. Validation lives in core.
 * The settings write and the refresh are refused to a chat's token in `security.ts`: the write names
 * a binary Agentry will run. YouTrack's address and token are kept by core and the
 * token is never answered back; every credentials route is refused to a chat's token.
 */
export const trackerRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/trackers', (): Promise<TrackerStatus[]> => core.trackers.statuses());

  app.post('/trackers/refresh', (): Promise<TrackerStatus[]> => core.trackers.refresh());

  app.get('/trackers/settings', (): TrackersSettings => core.trackersSettings.get());

  app.put<{ Body: unknown }>('/trackers/settings', async (req): Promise<TrackersSettings> => {
    const settings = await core.trackersSettings.set(req.body);
    // A tracker turned off or given a binary changes what a project's import reads before any
    // status differs, so the readiness cache goes now
    core.pullRequests.forgetReadiness();
    // The answer does not wait for the probes
    core.trackers.settingsChanged().catch((err: unknown) => app.log.warn({ err }, 'trackers: re-detection after a settings change failed'));
    return settings;
  });

  app.get('/trackers/youtrack/credentials', (): YoutrackCredentialsStatus => core.youtrackCredentials.status());

  app.put<{ Body: unknown }>('/trackers/youtrack/credentials', async (req): Promise<YoutrackCredentialsStatus> => {
    let status: YoutrackCredentialsStatus;
    try {
      status = await core.youtrackCredentials.set(req.body);
    } catch (err) {
      throw Object.assign(new Error(err instanceof Error ? err.message : 'invalid credentials'), { statusCode: 400 });
    }
    // The answer waits for the probe: the screen says at once whether the instance took the token
    await core.trackers.credentialsChanged('youtrack');
    return status;
  });

  app.delete('/trackers/youtrack/credentials', async (): Promise<YoutrackCredentialsStatus> => {
    const status = await core.youtrackCredentials.clear();
    await core.trackers.credentialsChanged('youtrack');
    return status;
  });

  app.get<{ Params: { id: string } }>('/trackers/:id', async (req): Promise<TrackerStatus> => {
    const status = (await core.trackers.statuses()).find((s) => s.id === req.params.id);
    if (!status) throw Object.assign(new Error(`tracker ${req.params.id} not found`), { statusCode: 404 });
    return status;
  });
};
