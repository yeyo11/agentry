import type { TrackerId } from '@agentry/shared';
import { githubIssuesAdapter } from './github-issues/adapter.ts';
import { gitlabIssuesAdapter } from './gitlab-issues/adapter.ts';
import type { TrackerAdapter } from './tracker.ts';
import { youtrackAdapter } from './youtrack/adapter.ts';

/**
 * The adapters that exist. A tracker listed before its CLI is recorded has none, offers no action,
 * and reads `not-recorded` (docs/plans/code-hosts.md, "Phase 5 in two steps").
 */
const ADAPTERS: Readonly<Partial<Record<TrackerId, TrackerAdapter>>> = {
  'github-issues': githubIssuesAdapter,
  'gitlab-issues': gitlabIssuesAdapter,
  youtrack: youtrackAdapter,
};

/** The adapter of a tracker, or null for one whose CLI is not recorded. */
export function trackerAdapter(id: TrackerId): TrackerAdapter | null {
  return ADAPTERS[id] ?? null;
}

export function trackerAdapters(): TrackerAdapter[] {
  return Object.values(ADAPTERS);
}
