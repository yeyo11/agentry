import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONVENTIONAL_TYPES,
  WORK_ITEM_PR_CAUSE,
  type AgentryEvent,
  type BoardCheckout,
  type CheckoutBehindReason,
  type FlowCriterionResult,
  type PullRequestNotReadyReason,
  type PullRequestReadiness,
  type WorkItem,
  type WorkItemActor,
  type WorkItemCause,
  type WorkItemHistoryPullRequest,
  type WorkItemPullRequest,
  type WorkItemPullRequestCi,
  type WorkItemPullRequestPhase,
} from '@agentry/shared';
import type { Db } from './db.ts';
import {
  aheadCount,
  branchExists,
  commitAll,
  conflictedPaths,
  currentBranch,
  git,
  hasTrackedChanges,
  identity,
  isGitRepo,
  mainCheckout,
  mergeInProgress,
  refExists,
  removeWorktree,
  uncommittedFiles,
} from './git.ts';
import { pullRequestOf, type PullRequestRow } from './work-item-rows.ts';
import { WorkItemError } from './work-item-validation.ts';
import { itemWorktree, ownsPlace } from './work-links.ts';
import type { WorkItemService } from './work-items.ts';

/**
 * A work item's pull request (docs/plans/work-item-pull-requests.md): the person approves the item,
 * and Agentry commits what QA verified, updates the item's branch with the default branch, pushes it
 * and opens the PR with `gh`. The person merges it on GitHub, and the watcher brings the merge back:
 * the item reaches Done and the project's checkout moves forward.
 *
 * The one rule holds: everything goes through `git` and `gh`, run by this process on the person's
 * request, as `Orchestrator.pullRequest()` does. No flow run ever pushes; `stageRules` denies it to
 * every stage, the run that resolves a conflict included.
 *
 * GitHub cannot push events to a local CLI, so the watcher is the one deliberate poll in the work
 * item automation: every 60 s, one PR at a time, backing off to 5 min for a project whose `gh`
 * failed. Several wrapper processes share the database, so a PR's check is claimed and its outcome
 * written with guarded updates, and a merge is handled once.
 */

/** Why an approval is refused, with the status the API answers and the code a client words. */
export class PullRequestError extends WorkItemError {
  constructor(
    message: string,
    statusCode: 400 | 404 | 409,
    readonly reason: string | null = null,
  ) {
    super(message, statusCode);
  }
}

/** How long a project's readiness is trusted: `gh auth status` must not run on every board read */
const READINESS_TTL = 60_000;
export const WATCH_INTERVAL = 60_000;
export const WATCH_BACKOFF = 5 * 60_000;
/** A check claimed longer ago than this was dropped by a process that died: another may take it */
const CLAIM_TTL = 2 * 60_000;
const BODY_MAX = 60_000;
const TITLE_MAX = 72;
const PERSON: WorkItemActor = { kind: 'person', role: null };
const SYSTEM: WorkItemActor = { kind: 'system', role: null };

/** A cause no chat or node is behind: the PR's own event, which a client words by its code. */
function prCause(event: string): WorkItemCause {
  return { kind: 'chat', chatId: null, orchestrationId: null, taskId: null, event };
}

// ---------- running git and gh without blocking the server ----------

/** A failed step: its code, and the first line git or gh said about it. */
class StepError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

interface Ran {
  stdout: string;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  ).slice(0, 500);
}

/**
 * Runs a command with arguments, never a shell string. A failure throws with the first line of what
 * it wrote on stderr (or stdout), which is the line the person reads beside the worded reason.
 */
function run(cmd: string, args: string[], opts: { cwd: string; timeout: number; input?: string; env: NodeJS.ProcessEnv }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout, env: opts.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return reject(Object.assign(new Error(`${cmd}: not found`), { missing: true }));
      const detail = firstLine(stderr) || firstLine(stdout) || (e.killed ? `${cmd} timed out` : e.message);
      reject(new Error(detail));
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const messageOf = (err: unknown): string => firstLine(err instanceof Error ? err.message : String(err));

// ---------- what the PR says ----------

/**
 * `<type>: <title> (<KEY>)`, Conventional Commits. The type is the item's first label that is a
 * Conventional type, or else `fix` for a bug and `feat` for anything else. The part before the key
 * is trimmed to 72 characters.
 */
export function pullRequestTitle(item: Pick<WorkItem, 'key' | 'title' | 'type' | 'labels'>): string {
  const label = item.labels.map((l) => l.trim().toLowerCase()).find((l): l is (typeof CONVENTIONAL_TYPES)[number] => (CONVENTIONAL_TYPES as readonly string[]).includes(l));
  const type = label ?? (item.type === 'bug' ? 'fix' : 'feat');
  let head = `${type}: ${item.title.replace(/\s+/g, ' ').trim()}`;
  if (head.length > TITLE_MAX) head = `${head.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  return `${head} (${item.key})`;
}

/**
 * The item's description, its criteria checked as QA found them with QA's note from its newest
 * passing verification, and a link to the card. Headings in English; the item's own text as written.
 */
export function pullRequestBody(item: Pick<WorkItem, 'key' | 'description' | 'acceptanceCriteria'>, verdicts: readonly FlowCriterionResult[], webOrigin: string | null): string {
  const parts: string[] = [];
  if (item.description.trim()) parts.push(item.description.trim());
  if (item.acceptanceCriteria.length) {
    const lines = ['## Acceptance criteria', ''];
    for (const c of item.acceptanceCriteria) {
      const verdict = verdicts.find((v) => v.id === c.id);
      const mark = c.checked || verdict?.met ? 'x' : ' ';
      lines.push(`- [${mark}] ${c.text}${verdict?.note ? ` — ${verdict.note}` : ''}`);
    }
    parts.push(lines.join('\n'));
  }
  const origin = webOrigin?.replace(/\/+$/, '') ?? null;
  const card = origin ? `[${item.key}](${origin}/tasks/${encodeURIComponent(item.key)})` : `\`${item.key}\``;
  parts.push(['## Work item', '', card].join('\n'));
  const body = parts.join('\n\n');
  return body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n\n… cut at ${BODY_MAX} characters` : body;
}

/**
 * The CI state `statusCheckRollup` comes to: none without checks; failing when one failed, was
 * cancelled or timed out; pending while one is queued or running; passing when all succeeded or
 * were skipped.
 */
export function ciOf(rollup: unknown): WorkItemPullRequestCi {
  const checks = Array.isArray(rollup) ? rollup.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null) : [];
  if (!checks.length) return 'none';
  const up = (v: unknown): string => (typeof v === 'string' ? v.toUpperCase() : '');
  const failing = checks.some((c) => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(up(c.conclusion) || up(c.state)));
  if (failing) return 'failing';
  const pending = checks.some((c) => {
    // A check run has a status and, once completed, a conclusion; a commit status has a state
    if (c.status !== undefined && up(c.status) !== 'COMPLETED') return true;
    return ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(up(c.state));
  });
  return pending ? 'pending' : 'passing';
}

/** The host of a git remote URL, or null for a local path (a bare repository beside the project). */
export function remoteHost(url: string): string | null {
  const scp = /^[\w.-]+@([\w.-]+):/.exec(url);
  if (scp) return scp[1]?.toLowerCase() ?? null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? null : parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

// ---------- the service ----------

export interface PullRequestDeps {
  db: Db;
  items: WorkItemService;
  /** The project's directory; null when it is not imported */
  project: (projectId: string) => { path: string } | null;
  /** A chat or a flow run is working on the item now */
  busy: (itemId: string) => boolean;
  /** QA's criteria from the item's newest passing verification */
  verdicts: (itemId: string) => FlowCriterionResult[];
  /** The origin the web UI is served on, for the card's link; null when unknown */
  webOrigin: () => string | null;
  /** Merged over the process's environment for git and gh: where a test puts its fake gh */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface ApproveResult {
  /** 202 while it is prepared, 200 when a PR was open (or being prepared) already */
  status: 200 | 202;
  item: WorkItem;
  pullRequest: WorkItemPullRequest;
}

export class PullRequestService {
  private readonly sql: DatabaseSync;
  private readonly readinessCache = new Map<string, { until: number; value: Promise<PullRequestReadiness> }>();
  /** Projects whose `gh` failed, and until when the watcher leaves them alone */
  private readonly backoff = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: PullRequestDeps) {
    this.sql = deps.db.connection;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private env(): NodeJS.ProcessEnv {
    // Nothing may stop to ask for a password or a confirmation in a process nobody watches
    return { ...process.env, ...this.deps.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  }

  private gh(cwd: string, args: string[], timeout = 60_000, input?: string): Promise<Ran> {
    return run('gh', args, { cwd, timeout, env: this.env(), ...(input !== undefined ? { input } : {}) });
  }

  private gitAsync(cwd: string, args: string[], timeout = 120_000): Promise<Ran> {
    return run('git', ['-C', cwd, ...args], { cwd, timeout, env: this.env() });
  }

  /** Waits for every approval started so far; for tests and for shutting down cleanly. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private track(work: Promise<void>): void {
    const p = work.catch(() => undefined).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  // ---------- readiness ----------

  /** Whether the project can open PRs, cached for 60 s. */
  readiness(projectPath: string): Promise<PullRequestReadiness> {
    const cached = this.readinessCache.get(projectPath);
    if (cached && cached.until > this.now()) return cached.value;
    const value = this.computeReadiness(projectPath);
    this.readinessCache.set(projectPath, { until: this.now() + READINESS_TTL, value });
    return value;
  }

  /** Forgets what was cached, so the next read asks git and gh again. */
  forgetReadiness(projectPath?: string): void {
    if (projectPath) this.readinessCache.delete(projectPath);
    else this.readinessCache.clear();
  }

  private async computeReadiness(projectPath: string): Promise<PullRequestReadiness> {
    const no = (status: PullRequestNotReadyReason, detail: string | null, defaultBranch: string | null = null): PullRequestReadiness => ({ status, detail, defaultBranch });
    if (!existsSync(projectPath) || !isGitRepo(projectPath)) return no('not-git', null);
    const home = mainCheckout(projectPath);
    let url: string;
    try {
      url = git(home, ['remote', 'get-url', 'origin'], 10_000);
    } catch (err) {
      return no('no-remote', messageOf(err));
    }
    try {
      await this.gh(home, ['--version'], 15_000);
    } catch (err) {
      return no('no-gh', (err as { missing?: boolean }).missing ? null : messageOf(err));
    }
    const host = remoteHost(url);
    if (host && host !== 'github.com') {
      // A GitHub Enterprise host counts only when gh knows it
      try {
        await this.gh(home, ['auth', 'status', '--hostname', host], 30_000);
      } catch (err) {
        return no('not-github', `${host}: ${messageOf(err)}`);
      }
    } else {
      try {
        await this.gh(home, ['auth', 'status', ...(host ? ['--hostname', host] : [])], 30_000);
      } catch (err) {
        return no('gh-unauthenticated', messageOf(err));
      }
    }
    let base: string | null = null;
    try {
      base = git(home, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 10_000).replace(/^origin\//, '') || null;
    } catch {
      // not set locally: gh knows it
    }
    if (!base) {
      try {
        base = (await this.gh(home, ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], 30_000)).stdout.trim() || null;
      } catch (err) {
        const detail = messageOf(err);
        // gh names the case itself when no remote points at a host it knows
        return /known github host|not a github|could not resolve to a repository/i.test(detail) ? no('not-github', detail) : no('no-default-branch', detail);
      }
    }
    if (!base) return no('no-default-branch', null);
    return { status: 'ready', detail: null, defaultBranch: base };
  }

  // ---------- the checkout ----------

  /**
   * The main checkout against `origin/<default>`, from local git only: a board read never fetches.
   * The reason says why the merge watcher left it behind.
   */
  checkout(projectPath: string, base: string): BoardCheckout | null {
    try {
      const home = mainCheckout(projectPath);
      const branch = currentBranch(home);
      if (!refExists(home, `refs/remotes/origin/${base}`)) return { defaultBranch: base, branch, behind: 0, reason: null };
      const behind = aheadCount(home, 'HEAD', `origin/${base}`);
      let reason: CheckoutBehindReason | null = null;
      if (behind > 0) {
        if (branch !== base) reason = 'not-on-default';
        else if (hasTrackedChanges(home)) reason = 'dirty';
        else if (aheadCount(home, `origin/${base}`, 'HEAD') > 0) reason = 'diverged';
      }
      return { defaultBranch: base, branch, behind, reason };
    } catch {
      return null;
    }
  }

  // ---------- rows ----------

  private write<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.sql.exec('ROLLBACK');
      } catch {
        // already ended by SQLite
      }
      throw err;
    }
  }

  private newestRow(itemId: string): PullRequestRow | null {
    return (this.sql.prepare('SELECT * FROM work_item_pull_requests WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(itemId) as PullRequestRow | undefined) ?? null;
  }

  private rowById(id: string): PullRequestRow | null {
    return (this.sql.prepare('SELECT * FROM work_item_pull_requests WHERE id = ?').get(id) as PullRequestRow | undefined) ?? null;
  }

  /** The item's newest PR. */
  newest(itemId: string): WorkItemPullRequest | null {
    const row = this.newestRow(itemId);
    return row ? pullRequestOf(row) : null;
  }

  /** Every PR the item had, oldest first. */
  all(itemId: string): WorkItemPullRequest[] {
    return (this.sql.prepare('SELECT * FROM work_item_pull_requests WHERE item_id = ? ORDER BY created_at, rowid').all(itemId) as unknown as PullRequestRow[]).map(pullRequestOf);
  }

  private update(id: string, fields: Partial<Omit<PullRequestRow, 'id' | 'item_id' | 'project_id'>>, guard?: WorkItemPullRequestPhase[]): boolean {
    const entries = Object.entries({ ...fields, updated_at: new Date(this.now()).toISOString() });
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => (v === undefined ? null : v)) as Array<string | number | null>;
    const where = guard ? ` AND phase IN (SELECT value FROM json_each(?))` : '';
    const r = this.sql.prepare(`UPDATE work_item_pull_requests SET ${sets} WHERE id = ?${where}`).run(...values, id, ...(guard ? [JSON.stringify(guard)] : []));
    return r.changes === 1;
  }

  private changed(itemId: string, entry: WorkItemHistoryPullRequest | null, actor: WorkItemActor, cause: WorkItemCause | null): void {
    try {
      this.deps.items.pullRequestChanged(itemId, entry, { actor, cause });
    } catch {
      // the item was removed meanwhile: its rows went with it
    }
  }

  // ---------- approving ----------

  /**
   * `POST /work-items/:itemId/pull-request`. Refusals are checked here, synchronously; the steps run
   * in the background, since a push can take minutes, and each reaches the feed as it happens.
   */
  async approve(itemId: string): Promise<ApproveResult> {
    const item = this.deps.items.find(itemId);
    if (!item) throw new PullRequestError('work item not found', 404);
    if (item.type === 'epic') throw new PullRequestError(`${item.key} is an epic, which groups work items: open the pull requests of its items instead`, 400);
    const open = this.newestRow(itemId);
    if (open && (open.phase === 'open' || open.phase === 'preparing')) return { status: 200, item, pullRequest: pullRequestOf(open) };
    if (item.status !== 'in_review') throw new PullRequestError(`${item.key} is not in review: only an item waiting in In review is approved into a pull request`, 409, 'not-in-review');
    if (this.deps.busy(itemId)) throw new PullRequestError(`${item.key} is being worked on: wait for its chat or run to end`, 409, 'busy');
    const project = this.deps.project(item.projectId);
    if (!project) throw new PullRequestError("the item's project is not imported", 409, 'not-git');
    const ready = await this.readiness(project.path);
    if (ready.status !== 'ready' || !ready.defaultBranch) {
      throw new PullRequestError(`this project cannot open pull requests (${ready.status})${ready.detail ? `: ${ready.detail}` : ''}`, 409, ready.status);
    }
    const base = ready.defaultBranch;
    const home = mainCheckout(project.path);
    if (!item.branch || !branchExists(home, item.branch)) throw new PullRequestError(`${item.key} has no branch with work on it: nothing to propose`, 409, 'nothing-to-propose');
    const place = itemWorktree(project.path, { ...item, projectId: item.projectId });
    if (!place) throw new PullRequestError(`${item.key} has no branch with work on it: nothing to propose`, 409, 'nothing-to-propose');
    if (place.worktree !== item.worktree || place.branch !== item.branch) this.deps.items.setWorktree(item.id, { worktree: place.worktree, branch: place.branch });
    const against = refExists(place.worktree, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;
    const dirty = uncommittedFiles(place.worktree).length > 0 || conflictedPaths(place.worktree).length > 0;
    if (!dirty && aheadCount(place.worktree, against) === 0) {
      throw new PullRequestError(`${place.branch} has no commit that ${base} lacks, and nothing uncommitted: nothing to propose`, 409, 'nothing-to-propose');
    }
    const now = new Date(this.now()).toISOString();
    const id = randomUUID();
    let existing: PullRequestRow | null = null;
    this.write(() => {
      // Checked again under the lock: two clicks, or two processes, would otherwise both start one
      const newest = this.newestRow(itemId);
      if (newest && (newest.phase === 'open' || newest.phase === 'preparing')) {
        existing = newest;
        return;
      }
      this.sql
        .prepare(
          `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, branch, base, approved_at, created_at, updated_at)
           VALUES (?, ?, ?, 'preparing', ?, ?, ?, ?, ?)`,
        )
        .run(id, itemId, item.projectId, place.branch, base, now, now, now);
    });
    if (existing) return { status: 200, item, pullRequest: pullRequestOf(existing) };
    this.changed(itemId, null, PERSON, null);
    this.track(this.prepare(id));
    const row = this.rowById(id);
    return { status: 202, item: this.deps.items.find(itemId) ?? item, pullRequest: row ? pullRequestOf(row) : pullRequestOf({ ...emptyRow(id, itemId, item.projectId, place.branch, base, now) }) };
  }

  /**
   * Steps 1 to 6 of the plan for a row in `preparing`: commit what is left, update the branch with
   * the default branch, push it and open the PR. A conflict hands the merge to the Developer and
   * pushes nothing; a failure records its step and leaves the item waiting for approval again.
   */
  private async prepare(rowId: string): Promise<void> {
    const row = this.rowById(rowId);
    if (!row || row.phase !== 'preparing') return;
    const item = this.deps.items.find(row.item_id);
    const project = item ? this.deps.project(item.projectId) : null;
    if (!item || !project) return;
    try {
      const place = itemWorktree(project.path, { ...item, projectId: item.projectId });
      if (!place) throw new StepError('commit', 'the item has no worktree');
      const wt = place.worktree;
      // A merge left conflicted by an earlier round is still what someone has to resolve
      let conflicts = conflictedPaths(wt);
      if (!conflicts.length) {
        try {
          // Also concludes a merge a person resolved by hand and did not commit
          commitAll(wt, `chore(${item.key.toLowerCase()}): keep the work QA verified`);
        } catch (err) {
          throw new StepError('commit', messageOf(err));
        }
        try {
          await this.gitAsync(wt, ['fetch', 'origin', row.base], 120_000);
        } catch (err) {
          throw new StepError('fetch', messageOf(err));
        }
        try {
          await this.gitAsync(wt, [...identity(wt), 'merge', '--no-edit', `origin/${row.base}`], 120_000);
        } catch (err) {
          conflicts = conflictedPaths(wt);
          if (!conflicts.length) {
            try {
              if (mergeInProgress(wt)) git(wt, ['merge', '--abort']);
            } catch {
              // nothing to abort
            }
            throw new StepError('merge', messageOf(err));
          }
        }
      }
      if (conflicts.length) {
        this.conflicted(row, item, conflicts);
        return;
      }
      try {
        await this.gitAsync(wt, ['push', '-u', 'origin', row.branch], 180_000);
      } catch (err) {
        throw new StepError('push', messageOf(err));
      }
      const body = pullRequestBody(this.deps.items.find(item.id) ?? item, this.deps.verdicts(item.id), this.deps.webOrigin());
      try {
        await this.gh(wt, ['pr', 'create', '--head', row.branch, '--base', row.base, '--title', pullRequestTitle(item), '--body-file', '-'], 120_000, body);
      } catch (err) {
        // One already open for the branch (opened by hand, say) is the one to watch
        if (!/already exists/i.test(messageOf(err))) throw new StepError('create', messageOf(err));
      }
      let view: { number?: unknown; url?: unknown };
      try {
        view = JSON.parse((await this.gh(wt, ['pr', 'view', row.branch, '--json', 'number,url,state'], 60_000)).stdout) as { number?: unknown; url?: unknown };
      } catch (err) {
        throw new StepError('create', messageOf(err));
      }
      const number = typeof view.number === 'number' ? view.number : null;
      const url = typeof view.url === 'string' ? view.url : null;
      this.opened(row, item, number, url);
    } catch (err) {
      const step = err instanceof StepError ? err : new StepError('create', messageOf(err));
      this.failed(row, step.code, step.detail);
    }
  }

  private opened(row: PullRequestRow, item: WorkItem, number: number | null, url: string | null): void {
    const now = new Date(this.now()).toISOString();
    if (!this.update(row.id, { phase: 'open', number, url, opened_at: now, error_code: null, error_detail: null, conflicts: '[]' }, ['preparing'])) return;
    const cause = prCause(WORK_ITEM_PR_CAUSE.opened);
    this.changed(item.id, { phase: 'open', number, url, conflicts: [] }, PERSON, cause);
    try {
      this.deps.items.setFlowState(item.id, { waiting: 'merge' }, { actor: PERSON, cause });
    } catch {
      // removed meanwhile
    }
  }

  private failed(row: PullRequestRow, code: string, detail: string): void {
    if (!this.update(row.id, { phase: 'failed', error_code: code, error_detail: detail }, ['preparing'])) return;
    this.changed(row.item_id, null, SYSTEM, null);
    const item = this.deps.items.find(row.item_id);
    if (item?.status === 'in_review' && item.waiting !== 'approval') {
      try {
        this.deps.items.setFlowState(item.id, { waiting: 'approval' }, { actor: SYSTEM, cause: null });
      } catch {
        // removed meanwhile
      }
    }
  }

  /**
   * The update conflicted: the merge stays in progress in the worktree, the item goes back to work as
   * the person's move (the approval was theirs), and the flow's Developer, when there is one, starts
   * on it with the conflicting paths named. Nothing is pushed.
   */
  private conflicted(row: PullRequestRow, item: WorkItem, conflicts: string[]): void {
    const now = new Date(this.now()).toISOString();
    if (!this.update(row.id, { phase: 'conflict', conflicts: JSON.stringify(conflicts), moved_at: now }, ['preparing'])) return;
    const cause = prCause(WORK_ITEM_PR_CAUSE.conflict);
    this.changed(item.id, { phase: 'conflict', number: null, url: null, conflicts }, PERSON, cause);
    try {
      this.deps.items.move(item.id, { status: 'in_progress' }, { actor: PERSON, cause });
    } catch {
      // removed meanwhile
    }
  }

  // ---------- the flow's side of a conflict ----------

  /** The merge a work run is to resolve: the default branch and the conflicting paths. */
  conflictOf(itemId: string): { base: string; paths: string[] } | null {
    const row = this.newestRow(itemId);
    if (!row || row.phase !== 'conflict') return null;
    return { base: row.base, paths: pullRequestOf(row).conflicts };
  }

  /**
   * A work run on an item with a merge to resolve ended well. Conflicts left: their paths, and the
   * run fails. Otherwise the merge is committed if the Developer left it open, and the approval is
   * remembered for QA's next pass (`awaiting-verify`).
   */
  settleConflict(itemId: string): string[] | null {
    const row = this.newestRow(itemId);
    if (!row || row.phase !== 'conflict') return null;
    const item = this.deps.items.find(itemId);
    const wt = item?.worktree;
    if (!item || !wt || !existsSync(wt)) return null;
    const left = conflictedPaths(wt);
    if (left.length) {
      this.update(row.id, { conflicts: JSON.stringify(left) }, ['conflict']);
      this.changed(itemId, null, SYSTEM, null);
      return left;
    }
    if (mergeInProgress(wt)) commitAll(wt, `Merge origin/${row.base} into ${row.branch}`);
    if (this.update(row.id, { phase: 'awaiting-verify', conflicts: '[]' }, ['conflict'])) this.changed(itemId, null, SYSTEM, null);
    return null;
  }

  /**
   * QA passed the item. An approval remembered from a conflict opens the PR now, with no second
   * click, unless a person moved the item since the conflict sent it back.
   */
  verified(itemId: string): void {
    const row = this.newestRow(itemId);
    if (!row || row.phase !== 'awaiting-verify') return;
    if (this.personMovedSince(itemId, row.moved_at ?? row.approved_at)) {
      this.drop(row);
      return;
    }
    if (!this.update(row.id, { phase: 'preparing', error_code: null, error_detail: null }, ['awaiting-verify'])) return;
    this.changed(itemId, null, SYSTEM, null);
    this.track(this.prepare(row.id));
  }

  private personMovedSince(itemId: string, since: string): boolean {
    try {
      return this.deps.items
        .history(itemId)
        .some((e) => e.change === 'status' && e.actor.kind === 'person' && e.createdAt >= since && !e.cause?.event.startsWith('pr.'));
    } catch {
      return true;
    }
  }

  /** A remembered approval a person's move overrode: the attempt goes, its history entries stay. */
  private drop(row: PullRequestRow): void {
    const r = this.sql.prepare("DELETE FROM work_item_pull_requests WHERE id = ? AND phase IN ('conflict', 'awaiting-verify')").run(row.id);
    if (r.changes === 1) this.changed(row.item_id, null, SYSTEM, null);
  }

  /** Everything on the feed goes through here: a person's move drops a remembered approval. */
  observe(event: AgentryEvent): void {
    try {
      if (event.type !== 'workitem.moved' || event.status === event.previousStatus) return;
      if (event.actor.kind !== 'person' || event.cause?.event.startsWith('pr.')) return;
      const row = this.newestRow(event.itemId);
      if (row && (row.phase === 'conflict' || row.phase === 'awaiting-verify')) this.drop(row);
    } catch {
      // runs inside someone else's event
    }
  }

  // ---------- watching ----------

  /** The open PRs to ask gh about, oldest checked first. */
  openRows(): PullRequestRow[] {
    return this.sql.prepare("SELECT * FROM work_item_pull_requests WHERE phase = 'open' ORDER BY COALESCE(checked_at, ''), created_at").all() as unknown as PullRequestRow[];
  }

  /**
   * Asks gh about one open PR and writes what changed. `force` is a person's refresh, which does not
   * wait out a project's back-off. Only a change reaches the feed.
   */
  async check(rowId: string, force = false): Promise<void> {
    const row = this.rowById(rowId);
    if (!row || row.phase !== 'open' || row.number === null) return;
    if (!force && (this.backoff.get(row.project_id) ?? 0) > this.now()) return;
    const project = this.deps.project(row.project_id);
    if (!project || !existsSync(project.path)) return;
    const now = this.now();
    let claimed = false;
    this.write(() => {
      claimed =
        this.sql
          .prepare("UPDATE work_item_pull_requests SET claimed_until = ? WHERE id = ? AND phase = 'open' AND (claimed_until IS NULL OR claimed_until < ?)")
          .run(new Date(now + CLAIM_TTL).toISOString(), row.id, new Date(now).toISOString()).changes === 1;
    });
    if (!claimed) return;
    let view: { state?: unknown; mergedAt?: unknown; statusCheckRollup?: unknown; url?: unknown };
    try {
      const out = await this.gh(mainCheckout(project.path), ['pr', 'view', String(row.number), '--json', 'state,mergedAt,statusCheckRollup,url'], 60_000);
      view = JSON.parse(out.stdout) as typeof view;
      this.backoff.delete(row.project_id);
    } catch {
      this.backoff.set(row.project_id, this.now() + WATCH_BACKOFF);
      this.update(row.id, { claimed_until: null });
      return;
    }
    const at = new Date(this.now()).toISOString();
    const ci = ciOf(view.statusCheckRollup);
    const url = typeof view.url === 'string' ? view.url : row.url;
    const state = typeof view.state === 'string' ? view.state.toUpperCase() : 'OPEN';
    if (state === 'MERGED') {
      const mergedAt = typeof view.mergedAt === 'string' && view.mergedAt ? view.mergedAt : at;
      // Guarded on the phase: of two processes, only the one whose update lands handles the merge
      if (this.update(row.id, { phase: 'merged', ci, url, closed_at: mergedAt, checked_at: at, claimed_until: null }, ['open'])) await this.merged({ ...row, url }, project.path);
      return;
    }
    if (state === 'CLOSED') {
      if (this.update(row.id, { phase: 'closed', ci, url, closed_at: at, checked_at: at, claimed_until: null }, ['open'])) this.closed({ ...row, url });
      return;
    }
    this.update(row.id, { ci, url, checked_at: at, claimed_until: null }, ['open']);
    if (ci !== row.ci || url !== row.url) this.changed(row.item_id, null, SYSTEM, null);
  }

  /**
   * GitHub merged it, which was the person's act: the item moves to Done as the person, its worktree
   * goes when nothing is left uncommitted there, and the project's checkout moves forward when it is
   * on the default branch and clean.
   */
  private async merged(row: PullRequestRow, projectPath: string): Promise<void> {
    const cause = prCause(WORK_ITEM_PR_CAUSE.merged);
    const entry: WorkItemHistoryPullRequest = { phase: 'merged', number: row.number, url: row.url, conflicts: [] };
    const item = this.deps.items.find(row.item_id);
    if (!item) return;
    this.changed(item.id, entry, PERSON, cause);
    try {
      if (item.status !== 'done') this.deps.items.move(item.id, { status: 'done' }, { actor: PERSON, cause });
      else if (item.waiting) this.deps.items.setFlowState(item.id, { waiting: null }, { actor: PERSON, cause });
    } catch {
      // removed meanwhile
    }
    this.removeWorktree(row, item, projectPath);
    await this.forward(projectPath, row.base);
  }

  private removeWorktree(row: PullRequestRow, item: WorkItem, projectPath: string): void {
    const wt = item.worktree;
    if (!wt || !ownsPlace(item) || !existsSync(wt)) return;
    try {
      const left = uncommittedFiles(wt).length;
      if (left > 0) {
        this.update(row.id, { error_code: 'worktree-kept', error_detail: `${left} uncommitted file${left === 1 ? '' : 's'} in ${wt}` });
        this.changed(item.id, null, SYSTEM, null);
        return;
      }
      removeWorktree(mainCheckout(projectPath), wt);
      // The branch stays, so the item's Changes still read it by name
      this.deps.items.setWorktree(item.id, { worktree: null, branch: item.branch });
    } catch (err) {
      this.update(row.id, { error_code: 'worktree-kept', error_detail: messageOf(err) });
      this.changed(item.id, null, SYSTEM, null);
    }
  }

  /** Fetches the default branch into the main checkout and fast-forwards it, only when that touches nothing of the person's. */
  private async forward(projectPath: string, base: string): Promise<void> {
    let home: string;
    try {
      home = mainCheckout(projectPath);
      await this.gitAsync(home, ['fetch', 'origin', base], 120_000);
    } catch {
      return; // the board says it is behind, from what git knows
    }
    try {
      if (currentBranch(home) !== base || hasTrackedChanges(home)) return;
      await this.gitAsync(home, ['merge', '--ff-only', `origin/${base}`], 120_000);
    } catch {
      // diverged: the board says so
    }
  }

  private closed(row: PullRequestRow): void {
    const cause = prCause(WORK_ITEM_PR_CAUSE.closed);
    this.changed(row.item_id, { phase: 'closed', number: row.number, url: row.url, conflicts: [] }, SYSTEM, cause);
    const item = this.deps.items.find(row.item_id);
    if (item?.status === 'in_review') {
      try {
        this.deps.items.setFlowState(item.id, { waiting: 'approval' }, { actor: SYSTEM, cause });
      } catch {
        // removed meanwhile
      }
    }
  }

  /** `POST /work-items/:itemId/pull-request/refresh`: asks gh about the item's open PR now. */
  async refresh(itemId: string): Promise<WorkItem> {
    const item = this.deps.items.find(itemId);
    if (!item) throw new PullRequestError('work item not found', 404);
    const row = this.newestRow(itemId);
    if (row?.phase === 'open') await this.check(row.id, true);
    return this.deps.items.find(itemId) ?? item;
  }
}

function emptyRow(id: string, itemId: string, projectId: string, branch: string, base: string, now: string): PullRequestRow {
  return {
    id,
    item_id: itemId,
    project_id: projectId,
    phase: 'preparing',
    number: null,
    url: null,
    branch,
    base,
    ci: null,
    conflicts: '[]',
    error_code: null,
    error_detail: null,
    approved_at: now,
    moved_at: null,
    opened_at: null,
    closed_at: null,
    checked_at: null,
    claimed_until: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Asks gh about every open PR, one at a time: every 60 s, once on start, and on a person's refresh.
 * The one deliberate poll of the work item automation, since GitHub cannot reach a local CLI.
 */
export class PullRequestWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly service: PullRequestService,
    private readonly interval = WATCH_INTERVAL,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the open PRs; a pass still going is not started twice. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        for (const row of this.service.openRows()) await this.service.check(row.id).catch(() => undefined);
      } catch {
        // a closed database (shutting down)
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
