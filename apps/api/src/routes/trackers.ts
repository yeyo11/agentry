import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { TrackerStatus, TrackersSettings } from '@agentry/shared';

/**
 * The issue trackers Agentry reads and writes through a CLI: what detection found, derived from the
 * code hosts' cache, a re-detection on demand, and the settings document. Validation lives in core.
 * The settings write and the refresh are refused to a chat's token in `security.ts`: the write names
 * a binary Agentry will run. Jira and YouTrack are listed with the readiness `unknown` and the
 * reason `not-recorded` until their CLIs are recorded.
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

  app.get<{ Params: { id: string } }>('/trackers/:id', async (req): Promise<TrackerStatus> => {
    const status = (await core.trackers.statuses()).find((s) => s.id === req.params.id);
    if (!status) throw Object.assign(new Error(`tracker ${req.params.id} not found`), { statusCode: 404 });
    return status;
  });
};
