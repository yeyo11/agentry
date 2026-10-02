import type { CodeHostId, IssueRef, ProjectTrackerSettings, TrackerId } from '@agentry/shared';

// How a change request names the issues of its work item (docs/plans/code-hosts.md, phase 5 and
// matrix F9). The item's branch stays `task/<key>`; the issue travels in the title and the body,
// which is what each tracker's own integration links by.

/** The host whose CLI and sign-in a tracker reuses; null for a tracker with its own CLI. */
const TRACKER_HOST: Partial<Record<TrackerId, CodeHostId>> = { 'github-issues': 'github', 'gitlab-issues': 'gitlab' };

export const trackerHost = (id: TrackerId): CodeHostId | null => TRACKER_HOST[id] ?? null;

/** A key that can be put in a title or a body as it is: no space, no markup. */
const PLAIN_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The keys a change request's title carries: only Jira and YouTrack, whose integrations link by a
 * key in the title. GitHub and GitLab link from the body, so their titles stay as they were.
 */
export function titleIssueKeys(issues: readonly Pick<IssueRef, 'tracker' | 'key'>[]): string[] {
  return issues.filter((i) => (i.tracker === 'jira' || i.tracker === 'youtrack') && PLAIN_KEY.test(i.key)).map((i) => i.key);
}

export interface LinkedIssueContext {
  /** The host the change request is opened on */
  host: CodeHostId;
  /** The repository the change request is in (`group/project`); null when it could not be told */
  repoPath: string | null;
  /** The request's base is the project's default branch, the only one a closing word works into */
  closing: boolean;
}

/**
 * The lines of a change request's "Linked issue" section. On GitHub and GitLab: `Closes #12` when the
 * tracker is the request's own host and the base is the default branch, the bare reference
 * otherwise (`#12`, or `group/project#12` when the issue is in another repository). The key of a
 * Jira or YouTrack issue is always written as it is. The repository is the one on the link. An issue of a tracker the project no longer
 * uses is left out: where it lives is not known.
 */
export function linkedIssueLines(issues: readonly Pick<IssueRef, 'tracker' | 'scope' | 'key'>[], tracker: Pick<ProjectTrackerSettings, 'id'>, ctx: LinkedIssueContext): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    if (issue.tracker !== tracker.id || !PLAIN_KEY.test(issue.key)) continue;
    const own = trackerHost(issue.tracker);
    if (own === null) {
      lines.push(issue.key);
      continue;
    }
    // The repository the issue was imported from, not the one the project points at now: an issue
    // whose repository was never recorded is not named, since a bare number would name another one
    if (issue.scope === null) continue;
    const reference = issue.scope.toLowerCase() === ctx.repoPath?.toLowerCase() ? `#${issue.key}` : `${issue.scope}#${issue.key}`;
    lines.push(ctx.closing && own === ctx.host ? `Closes ${reference}` : reference);
  }
  return lines;
}
