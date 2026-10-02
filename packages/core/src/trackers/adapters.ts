import type { TrackerId } from '@agentry/shared';
import { githubIssuesAdapter } from './github-issues/adapter.ts';
import { gitlabIssuesAdapter } from './gitlab-issues/adapter.ts';
import type { TrackerAdapter } from './tracker.ts';

/**
 * The adapters that exist. `jira` and `youtrack` are not here on purpose: their CLIs (`acli`,
 * `youtrack-app`) have no recording yet (docs/plans/code-hosts.md, "Phase 5 in two steps"), so
 * they have no adapter and offer no action. Their readiness reason is `not-recorded`.
 */
const ADAPTERS: Readonly<Partial<Record<TrackerId, TrackerAdapter>>> = {
  'github-issues': githubIssuesAdapter,
  'gitlab-issues': gitlabIssuesAdapter,
};

/** The adapter of a tracker, or null for one whose CLI is not recorded. */
export function trackerAdapter(id: TrackerId): TrackerAdapter | null {
  return ADAPTERS[id] ?? null;
}

export function trackerAdapters(): TrackerAdapter[] {
  return Object.values(ADAPTERS);
}
