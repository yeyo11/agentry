import type { TrackerId } from '@agentry/shared';
import { githubIssuesAdapter } from './github-issues/adapter.ts';
import { gitlabIssuesAdapter } from './gitlab-issues/adapter.ts';
import type { TrackerAdapter } from './tracker.ts';
import { youtrackAdapter } from './youtrack/adapter.ts';

/**
 * The adapters that exist. `jira` is not here on purpose: `acli` has no recording yet
 * (docs/plans/code-hosts.md, "Phase 5 in two steps"), so it has no adapter and offers no action.
 * Its readiness reason is `not-recorded`.
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
