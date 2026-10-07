import type { CodeHostId, HostReason, ProjectTrackerSettings, TrackerImportResult, TrackerIssue, TrackerIssuesPage, TrackerId, WorkItem, WorkItemType } from '@agentry/shared';
import { HostParseError, type HostCall, type HostRepo } from '../hosts/code-host.ts';
import { reasonOf } from '../hosts/classify.ts';
import { tryParseJson } from '../hosts/json.ts';
import type { HostResult } from '../hosts/exec.ts';
import { TITLE_MAX, WorkItemError } from '../work-item-validation.ts';
import type { IssueLinkInput, WorkItemService } from '../work-items.ts';
import type { IssueTriage } from '../decisions/issue-triage.ts';
import { trackerAdapter } from './adapters.ts';
import { ISSUE_TEXT_MARK, trackerHost } from './links.ts';
import { ISSUES_PAGE_SIZE, IssueIsPullRequest, MAX_ISSUE_BODY, TrackerInputError, type IssueRead, type TrackerAdapter } from './tracker.ts';

// Importing issues into work items (docs/plans/code-hosts.md, phase 5). The person runs the
// tracker's own query, picks issues, and each becomes one work item with a `work_item_issues` row.
// An issue is untrusted text: it is stored as a quoted source block with its origin on top, never
// as an instruction, and what the tracker said is read again at import so a stale list never
// decides what an item says. Nothing here writes to the tracker: that is the sync's, one write
// per event and never retried.

/** Keys one import takes: a page of the list */
export const IMPORT_MAX_KEYS = ISSUES_PAGE_SIZE;

const TRACKER_LABEL: Record<TrackerId, string> = {
  'github-issues': 'GitHub Issues',
  'gitlab-issues': 'GitLab Issues',
  jira: 'Jira',
  youtrack: 'YouTrack',
};

/** A refusal or a failure of a tracker call, with the reason the screen words. */
export class TrackerError extends WorkItemError {
  constructor(
    message: string,
    statusCode: 400 | 404 | 409,
    /** A host reason, or `not-recorded` for a tracker whose CLI nobody recorded; null for a refusal that has none */
    readonly reason: HostReason | 'not-recorded' | null = null,
    /** The first line the CLI answered with, redacted by the execution layer */
    readonly detail: string | null = null,
  ) {
    super(message, statusCode);
  }
}

/**
 * Where a tracker's calls go. For GitHub and GitLab, what the project's host lends the trackers that
 * reuse it (see `PullRequestService.hostAccess`); for YouTrack, the instance Agentry keeps the
 * address and token of, with `host` null and `hostname` the instance's address.
 */
export interface TrackerAccess {
  host: CodeHostId | null;
  hostname: string;
  repo: HostRepo | null;
  run: (call: HostCall) => Promise<HostResult>;
  /** An issue's address, for a tracker whose answers do not carry it */
  issueUrl?: (key: string) => string;
}

export interface TrackerImportDeps {
  items: WorkItemService;
  /** The project's directory and tracker; null for an id that names no project */
  project: (projectId: string) => { path: string; tracker: ProjectTrackerSettings | null } | null;
  /** Where every import and read passes: refuses a tracker that is turned off before the host is touched */
  access: (projectPath: string, tracker: TrackerId) => Promise<TrackerAccess>;
  /** `issue.triage`: asked with every page and read back as marks; absent where nothing marks */
  triage?: IssueTriage;
}

interface Resolved {
  adapter: TrackerAdapter;
  tracker: ProjectTrackerSettings;
  access: TrackerAccess;
  scope: HostRepo;
}

/** The work item type an issue's labels, or the tracker's own issue type, map to; only `bug` does. */
export function issueType(labels: readonly string[], kind: string | null = null): WorkItemType | null {
  return [...labels, ...(kind === null ? [] : [kind])].some((l) => l.trim().toLowerCase() === 'bug') ? 'bug' : null;
}

/**
 * The description of an imported item: the issue's body as a quoted block under "From <tracker>
 * <key>", so a reader and an agent both see where the text came from and that it is quoted. Cut
 * at the longest body Agentry handles.
 */
export function quotedSource(tracker: TrackerId, key: string, body: string): string {
  const head = `> **From ${TRACKER_LABEL[tracker]} ${tracker === 'github-issues' || tracker === 'gitlab-issues' ? `#${key}` : key}** — ${ISSUE_TEXT_MARK}`;
  const text = body.replace(/\r\n?/g, '\n').trim();
  if (!text) return head;
  const cut = text.length > MAX_ISSUE_BODY ? `${text.slice(0, MAX_ISSUE_BODY)}\n… cut at ${String(MAX_ISSUE_BODY)} characters` : text;
  return [head, '>', ...cut.split('\n').map((line) => (line === '' ? '>' : `> ${line}`))].join('\n');
}

export class TrackerImportService {
  constructor(private readonly deps: TrackerImportDeps) {}

  /** One page of the tracker's own query, each issue marked with the item it was imported as. */
  async list(projectId: string, query: string | null, page: number): Promise<TrackerIssuesPage> {
    const r = await this.resolve(projectId);
    const req = { query: query ?? r.tracker.query, page };
    let call: HostCall;
    try {
      call = r.adapter.list(r.scope, req);
    } catch (err) {
      throw refusal(err);
    }
    const result = await r.access.run(call);
    const issues = this.parse(() => r.adapter.parseList(this.stdout('the issue list', call, result), req));
    issues.issues = issues.issues.map((i) => withUrl(i, r.access));
    const imported = this.deps.items.importedKeys(projectId, r.tracker.id, r.tracker.scope, issues.issues.map((i) => i.key));
    const listed = issues.issues.map((i) => ({ ...tracked(r.tracker.id, i), importedItemId: imported.get(i.key) ?? null }));
    // The question goes in the background and the page does not wait: its marks show on the next read
    this.deps.triage?.onIssues(projectId, r.tracker.id, listed);
    const marks = this.deps.triage?.marksOf(projectId, r.tracker.id, listed.map((i) => i.key));
    return {
      issues: listed.map((i) => ({ ...i, triage: marks?.get(i.key) ?? null })),
      page: issues.page,
      hasMore: issues.hasMore,
    };
  }

  /**
   * One work item per key, skipping what the project already holds. A key the tracker cannot give
   * (gone, a pull request, a host failure) is skipped with its reason and the rest go on. Keys are
   * checked before anything is read, so a bad key refuses the whole request.
   */
  async importIssues(projectId: string, keys: readonly string[]): Promise<TrackerImportResult> {
    const r = await this.resolve(projectId);
    const unique = [...new Set(keys.map((k) => k.trim()))];
    if (!unique.length) throw new TrackerError('keys must name at least one issue', 400);
    if (unique.length > IMPORT_MAX_KEYS) throw new TrackerError(`one import takes at most ${String(IMPORT_MAX_KEYS)} issues`, 400);
    const normal = unique.map((k) => {
      try {
        return r.adapter.key(k);
      } catch (err) {
        throw refusal(err);
      }
    });
    const result: TrackerImportResult = { imported: [], skipped: [] };
    for (const key of [...new Set(normal)]) {
      if (this.deps.items.findIssue(projectId, r.tracker.id, r.tracker.scope, key)) {
        result.skipped.push({ key, reason: 'already-imported' });
        continue;
      }
      let issue: IssueRead;
      try {
        issue = await this.read(r, key);
      } catch (err) {
        if (!(err instanceof TrackerError) || err.reason === null || err.reason === 'not-recorded') throw err;
        result.skipped.push({ key, reason: err.reason });
        continue;
      }
      try {
        const item = this.deps.items.create(
          projectId,
          { title: issue.title.trim().slice(0, TITLE_MAX) || `Issue ${key}`, description: quotedSource(r.tracker.id, key, issue.body), type: issueType(issue.labels, issue.kind ?? null) ?? 'task' },
          undefined,
          linkOf(r.tracker, issue),
        );
        result.imported.push({ key, itemId: item.id, itemKey: item.key });
      } catch (err) {
        // Another import won the unique index between the check and the write
        if (err instanceof WorkItemError && err.statusCode === 409) result.skipped.push({ key, reason: 'already-imported' });
        else throw err;
      }
    }
    return result;
  }

  /** Links one issue to an existing item by its key, as the item page does. */
  async link(itemId: string, key: string): Promise<WorkItem> {
    const item = this.deps.items.find(itemId);
    if (!item) throw new WorkItemError('work item not found', 404);
    const r = await this.resolve(item.projectId);
    let number: string;
    try {
      number = r.adapter.key(key);
    } catch (err) {
      throw refusal(err);
    }
    const issue = await this.read(r, number);
    return this.deps.items.linkIssue(itemId, linkOf(r.tracker, issue));
  }

  private async resolve(projectId: string): Promise<Resolved> {
    const project = this.deps.project(projectId);
    if (!project) throw new WorkItemError('project not found', 404);
    const { tracker } = project;
    if (!tracker) throw new TrackerError('this project has no tracker: choose one in its settings', 409);
    const adapter = trackerAdapter(tracker.id);
    // Jira: acli is not recorded, so nothing is built on it
    if (!adapter) throw new TrackerError(`${TRACKER_LABEL[tracker.id]} is not available yet: its CLI has not been recorded`, 409, 'not-recorded');
    const access = await this.deps.access(project.path, tracker.id);
    if (access.host !== trackerHost(tracker.id)) {
      throw new TrackerError(`${TRACKER_LABEL[tracker.id]} needs a project on ${String(adapter.host)}, and this one is on ${String(access.host)}`, 409, 'unsupported-host');
    }
    const at = tracker.scope.lastIndexOf('/');
    const scope: HostRepo = { host: access.hostname, path: tracker.scope, owner: at === -1 ? '' : tracker.scope.slice(0, at), name: tracker.scope.slice(at + 1) };
    return { adapter, tracker, access, scope };
  }

  private async read(r: Resolved, key: string): Promise<IssueRead> {
    let call: HostCall;
    try {
      call = r.adapter.get(r.scope, key);
    } catch (err) {
      throw refusal(err);
    }
    const result = await r.access.run(call);
    return withUrl(this.parse(() => r.adapter.parseGet(this.stdout(`issue ${key}`, call, result, goneOn(call, result)))), r.access);
  }

  /** The CLI's stdout, or the failure as the error a caller throws. */
  private stdout(what: string, call: HostCall, result: HostResult, otherwise: HostReason = 'unreachable'): string {
    if (result.exitCode === 0) return result.stdout;
    const reason = result.reason ?? reasonOf(result, call.cli);
    throw new TrackerError(`${what} could not be read`, 409, reason === null || reason === 'unreachable' ? otherwise : reason, result.stderrFirstLine || null);
  }

  private parse<T>(read: () => T): T {
    try {
      return read();
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      if (err instanceof IssueIsPullRequest) throw new TrackerError(err.message, 409, 'issue-is-pull-request');
      if (err instanceof HostParseError) throw new TrackerError('the tracker answered in a shape Agentry does not know', 409, 'unexpected-output', err.message);
      throw err;
    }
  }
}

/**
 * What a failed `get` means when nothing more specific is known: matrix F2 says exit 1 from `gh
 * issue view` is a number that is not there, and glab's is exit 1 with an `{"error"}` object on
 * stdout (recorded). Only the shape is looked at, never the message.
 */
function goneOn(call: HostCall, result: HostResult): HostReason {
  // youtrack-app documents and was recorded to answer 4 for an id that is not there
  if (call.cli === 'youtrack-app') return result.exitCode === 4 ? 'not-found' : 'unreachable';
  if (result.exitCode !== 1) return 'unreachable';
  if (call.cli === 'gh') return 'not-found';
  const body = tryParseJson(result.stdout);
  return typeof body === 'object' && body !== null && 'error' in body ? 'not-found' : 'unreachable';
}

/** A refusal before any call: a key that is not a number, a page below 1. */
function refusal(err: unknown): Error {
  return err instanceof TrackerInputError ? new TrackerError(err.message, 400) : err instanceof Error ? err : new Error(String(err));
}

/** The issue with its address, when the tracker's answer does not carry one */
function withUrl(issue: IssueRead, access: TrackerAccess): IssueRead {
  return issue.url === null && access.issueUrl ? { ...issue, url: access.issueUrl(issue.key) } : issue;
}

function linkOf(tracker: Pick<ProjectTrackerSettings, 'id' | 'scope'>, issue: IssueRead): IssueLinkInput {
  return { tracker: tracker.id, scope: tracker.scope, key: issue.key, externalId: issue.externalId, title: issue.title.slice(0, TITLE_MAX), state: issue.status ?? issue.state, url: issue.url };
}

function tracked(tracker: TrackerId, issue: IssueRead): TrackerIssue {
  return {
    tracker,
    key: issue.key,
    externalId: issue.externalId,
    title: issue.title,
    body: issue.body,
    state: issue.status ?? issue.state,
    labels: issue.labels,
    type: issueType(issue.labels, issue.kind ?? null),
    url: issue.url,
    updatedAt: issue.updatedAt,
    importedItemId: null,
    triage: null,
  };
}
