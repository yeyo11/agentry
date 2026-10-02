import type { AgentryEvent, HostReason, ProjectTrackerSettings, TrackerId, TrackerMappedStatus, WorkItem } from '@agentry/shared';
import { reasonOf } from '../hosts/classify.ts';
import type { HostCall, HostRepo } from '../hosts/code-host.ts';
import type { HostResult } from '../hosts/exec.ts';
import { WorkItemError } from '../work-item-validation.ts';
import type { WorkItemService } from '../work-items.ts';
import { trackerAdapter } from './adapters.ts';
import { TrackerError, type TrackerAccess } from './import.ts';
import { trackerHost } from './links.ts';
import type { TrackerAdapter } from './tracker.ts';

// Telling the tracker what happened to the work (docs/plans/code-hosts.md, phase 5, "Status
// sync"). It runs from Agentry's own events: the item moved to a column the project mapped, and
// the change request merged. Each event is one write per issue, never retried: the outcome is
// written on the issue's row (`synced`, or `failed` with its reason) and the person's "Sync again"
// is the only second attempt. Nothing here moves an item or merges anything: the merge click is
// the person's, and the pull request service's `merged()` is what moves the item and calls us.

/** What the pull request service tells the sync when the host merged a change request. */
export interface MergedNotice {
  itemId: string;
  /** The request's base is the project's default branch, the only one a closing word works into */
  closingWord: boolean;
  /** The host the change request lives on; a closing word only works for that host's own issues */
  host: string;
}

export interface TrackerSyncDeps {
  items: WorkItemService;
  /** The project's directory and tracker; null for an id that names no project */
  project: (projectId: string) => { path: string; tracker: ProjectTrackerSettings | null } | null;
  /** Where every write passes: refuses a tracker that is turned off before the host is touched */
  access: (projectPath: string, tracker: TrackerId) => Promise<TrackerAccess>;
}

/** The readiness a project's host answered with when it could not be reached, in the reasons a screen words. */
const READINESS_REASON: Record<string, HostReason> = {
  'signed-out': 'tracker-signed-out',
  'not-installed': 'cli-missing',
  incompatible: 'cli-incompatible',
  'unsupported-host': 'unsupported-host',
  'tracker-disabled': 'tracker-disabled',
};

interface Outcome {
  /** The state the tracker reported, when it was read */
  state?: string;
  syncState: 'none' | 'synced' | 'failed';
  reason: HostReason | null;
}

export class TrackerSyncService {
  /** `tracker:key` of the issues with a sync under way: a second one for the same issue is refused, not queued */
  private readonly running = new Set<string>();

  constructor(private readonly deps: TrackerSyncDeps) {}

  /** Everything on the feed goes through here: an item that moved to a mapped column is synced. */
  observe(event: AgentryEvent): void {
    if (event.type !== 'workitem.moved' || event.status === event.previousStatus) return;
    const { status, itemId } = event;
    if (status !== 'in_progress' && status !== 'in_review') return;
    void this.syncItem(itemId, status, false).catch(() => {
      // runs inside someone else's event; a failure is on the issue's row
    });
  }

  /** The host merged the item's change request: `done`. Resolves when every issue has been tried once. */
  async merged(notice: MergedNotice): Promise<void> {
    try {
      await this.syncItem(notice.itemId, 'done', notice.closingWord, notice.host);
    } catch {
      // the item went away, or nothing was configured: nothing to show
    }
  }

  /**
   * `POST /work-items/:itemId/issues/:key/sync`: tries once more what the item's column asks of the
   * tracker. The person asked for it, so a closing word that might have worked is not waited for.
   */
  async syncAgain(itemId: string, tracker: TrackerId, key: string): Promise<WorkItem> {
    const item = this.deps.items.find(itemId);
    if (!item) throw new WorkItemError('work item not found', 404);
    const issue = item.issues?.find((i) => i.tracker === tracker && i.key === key);
    if (!issue) throw new WorkItemError('the item is not linked to that issue', 404);
    const column = item.status;
    if (column !== 'in_progress' && column !== 'in_review' && column !== 'done') {
      throw new TrackerError(`nothing to sync while the item is in ${column}`, 409);
    }
    const r = this.resolve(item.projectId, tracker);
    if (!r) throw new TrackerError('this project does not use that tracker', 409);
    if (!r.tracker.statusMap[column]) throw new TrackerError(`the project does not map ${column} to a status of its tracker`, 409);
    if (!r.adapter) throw new TrackerError('that tracker is not available yet: its CLI has not been recorded', 409, 'not-recorded');
    if (!r.adapter.writes(column)) {
      throw new TrackerError(`${column} is not synced for this tracker`, 409);
    }
    if (this.running.has(`${tracker}:${key}`)) throw new TrackerError('a sync of this issue is already running', 409);
    await this.syncIssue(item, tracker, key, column, false, null);
    const after = this.deps.items.find(itemId);
    if (!after) throw new WorkItemError('work item not found', 404);
    return after;
  }

  /** One attempt per issue of the item that belongs to the project's tracker. */
  private async syncItem(itemId: string, column: TrackerMappedStatus, closingWord: boolean, host: string | null = null): Promise<void> {
    const item = this.deps.items.find(itemId);
    if (!item?.issues?.length) return;
    const project = this.deps.project(item.projectId);
    const tracker = project?.tracker;
    if (!tracker || !tracker.statusMap[column]) return;
    for (const issue of item.issues) {
      if (issue.tracker !== tracker.id) continue;
      await this.syncIssue(item, issue.tracker, issue.key, column, closingWord, host);
    }
  }

  private resolve(projectId: string, id: TrackerId): { tracker: ProjectTrackerSettings; adapter: TrackerAdapter | null; path: string } | null {
    const project = this.deps.project(projectId);
    if (!project?.tracker || project.tracker.id !== id) return null;
    return { tracker: project.tracker, adapter: trackerAdapter(id), path: project.path };
  }

  private async syncIssue(item: WorkItem, id: TrackerId, key: string, column: TrackerMappedStatus, closingWord: boolean, host: string | null): Promise<void> {
    const r = this.resolve(item.projectId, id);
    // Jira and YouTrack have no adapter: there is nothing to write and nothing to say about it
    if (!r?.adapter) return;
    const name = r.tracker.statusMap[column] ?? null;
    if (name === null) return;
    const lock = `${id}:${key}`;
    if (this.running.has(lock)) return;
    this.running.add(lock);
    try {
      const outcome = await this.attempt(r.adapter, r.tracker, r.path, key, column, name, closingWord && host !== null && trackerHost(id) === host);
      if (outcome) this.deps.items.recordIssueSync(item.id, id, key, outcome);
    } finally {
      this.running.delete(lock);
    }
  }

  /**
   * One pass: read, write when the column asks for one and nothing else did it, read again. A read
   * is not a write, so only the single write is never repeated. Null when there was nothing to do.
   */
  private async attempt(
    adapter: TrackerAdapter,
    tracker: ProjectTrackerSettings,
    projectPath: string,
    key: string,
    column: TrackerMappedStatus,
    name: string,
    closingWorked: boolean,
  ): Promise<Outcome | null> {
    const to = { column, name };
    // GitHub and GitLab have one status: only `done` writes, and the others are no work at all
    if (!adapter.writes(column)) return null;
    let access: TrackerAccess;
    try {
      access = await this.deps.access(projectPath, tracker.id);
    } catch (err) {
      const code = err instanceof WorkItemError && 'reason' in err && typeof err.reason === 'string' ? err.reason : null;
      return { syncState: 'failed', reason: (code && READINESS_REASON[code]) || 'unreachable' };
    }
    if (access.host !== adapter.host) return { syncState: 'failed', reason: 'unsupported-host' };
    const scope = scopeOf(tracker.scope, access.hostname);
    const before = await this.read(adapter, access, scope, key);
    if ('reason' in before) return { syncState: 'failed', reason: before.reason };
    if (column === 'done') {
      if (before.state === 'closed') return { state: before.state, syncState: 'synced', reason: null };
      // The merge's closing word may still be on its way: the state is shown, and a click can close it
      if (closingWorked) return { state: before.state, syncState: 'none', reason: null };
    }
    const call = adapter.setStatus(scope, key, to);
    if (call === null) return null;
    const written = await access.run(call);
    if (written.exitCode !== 0) return { state: before.state, syncState: 'failed', reason: failureOf(written, call) };
    const after = await this.read(adapter, access, scope, key);
    if ('reason' in after) return { state: before.state, syncState: 'failed', reason: 'write-unconfirmed' };
    if (column === 'done' && after.state !== 'closed') return { state: after.state, syncState: 'failed', reason: 'write-unconfirmed' };
    return { state: after.state, syncState: 'synced', reason: null };
  }

  private async read(adapter: TrackerAdapter, access: TrackerAccess, scope: HostRepo, key: string): Promise<{ state: string } | { reason: HostReason }> {
    try {
      const call = adapter.get(scope, key);
      const result = await access.run(call);
      if (result.exitCode !== 0) return { reason: failureOf(result, call) };
      return { state: adapter.parseGet(result.stdout).state };
    } catch (err) {
      const reason = err instanceof Error && err.name === 'IssueIsPullRequest' ? 'issue-is-pull-request' : 'unexpected-output';
      return { reason };
    }
  }
}

/** Why a call failed, in the host's reasons; a CLI that only said "1" is `unreachable`. */
function failureOf(result: HostResult, call: HostCall): HostReason {
  return reasonOf(result, call.cli) ?? 'unreachable';
}

function scopeOf(path: string, hostname: string): HostRepo {
  const at = path.lastIndexOf('/');
  return { host: hostname, path, owner: at === -1 ? '' : path.slice(0, at), name: path.slice(at + 1) };
}
