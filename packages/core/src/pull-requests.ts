import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONVENTIONAL_TYPES,
  WORK_ITEM_PR_CAUSE,
  type AgentryEvent,
  type BoardCheckout,
  type ChangeRequestFixOrigin,
  type ChangeRequestThreads,
  type ReviewThread,
  type ChangeRequestKind,
  type CheckoutBehindReason,
  type CodeHostId,
  type CodeHostsSettings,
  type FlowCriterionResult,
  type ProjectCodeHost,
  type PullRequestReadiness,
  type WorkItem,
  type WorkItemActor,
  type WorkItemCause,
  type WorkItemHistoryPullRequest,
  type Check,
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
import { checksFixPrompt, reviewFixPrompt } from './flow.ts';
import { ChecksError, type ChecksService, type ChecksTarget } from './hosts/checks-service.ts';
import { ReviewsError, type ReviewsService } from './hosts/reviews-service.ts';
import type { ChangeRequestRead, ChangeRequestView, ChecksCodeHostAdapter, HostCall, HostRepo } from './hosts/code-host.ts';
import { defaultHostRun, hostSearchPath, resolveHostBinary, type HostRun } from './hosts/detector.ts';
import { runHostCall, type HostResult } from './hosts/exec.ts';
import { githubAdapter } from './hosts/github/adapter.ts';
import { gitlabAdapter } from './hosts/gitlab/adapter.ts';
import { HostRateLimiter } from './hosts/rate-limit.ts';
import { projectReadiness } from './hosts/readiness.ts';
import { firstLine } from './hosts/redact.ts';
import { CodeHostRegistry } from './hosts/registry.ts';
import { parseRemote } from './hosts/remote.ts';
import { hostOf, pullRequestOf, type PullRequestRow } from './work-item-rows.ts';
import { WorkItemError } from './work-item-validation.ts';
import { itemWorktree, ownsPlace } from './work-links.ts';
import type { WorkItemService } from './work-items.ts';

/**
 * A work item's pull request (docs/plans/work-item-pull-requests.md): the person approves the item,
 * and Agentry commits what QA verified, updates the item's branch with the default branch, pushes it
 * and opens the PR (or MR) with the project's host CLI. The person merges it on the host, and the watcher brings the merge back:
 * the item reaches Done and the project's checkout moves forward.
 *
 * The one rule holds: everything goes through `git` and the host's CLI (`hosts/exec.ts`), run by this process on the person's
 * request, as `Orchestrator.pullRequest()` does. No flow run ever pushes; `stageRules` denies it to
 * every stage, the run that resolves a conflict included.
 *
 * GitHub cannot push events to a local CLI, so the watcher is the one deliberate poll in the work
 * item automation: every 60 s, one PR at a time, backing off to 5 min for a project whose host CLI
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

/** How long a project's readiness is trusted: the host's auth probe must not run on every board read */
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

// ---------- running git and the host's CLI without blocking the server ----------

/** A failed step: its code, and the first line git or the host's CLI said about it. */
class StepError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** Runs git with arguments, never a shell string. A failure throws with the first line it wrote on stderr (or stdout). */
function runGit(cwd: string, args: string[], opts: { timeout: number; env: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { cwd, timeout: opts.timeout, env: opts.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve();
      const killed = (err as { killed?: boolean }).killed;
      reject(new Error(firstLine(stderr) || firstLine(stdout) || (killed ? 'git timed out' : err.message)));
    });
  });
}

const messageOf = (err: unknown): string => firstLine(err instanceof Error ? err.message : String(err));

/** The line a person reads beside a failed host call: what the CLI said, else Agentry's own reason. */
const failureOf = (result: HostResult): string => result.stderrFirstLine || result.reason || `exit ${result.exitCode ?? 'none'}`;

const ADAPTERS: Readonly<Record<CodeHostId, ChecksCodeHostAdapter>> = { github: githubAdapter, gitlab: gitlabAdapter };

/** The adapter of a code host: the one place that maps an id to its translator. */
export const codeHostAdapter = (id: CodeHostId): ChecksCodeHostAdapter | undefined => ADAPTERS[id];

/** The cause a fix of failing checks writes on the item's move to In progress; a client words it by its code. */
export const CHECKS_FIX_CAUSE = 'pr.checks-fix';

/** The failing checks a fix is made of: a failure the pipeline lets pass is not one. */
export const failingChecks = (checks: readonly Check[]): Check[] => checks.filter((c) => c.state === 'failed' && !c.allowedToFail);

/** How many failing checks a prompt carries, each with its log tail */
const FIX_CHECKS_MAX = 10;

/** The failing checks with the tail of each log, as the prompt of a fix; a log that cannot be read leaves its check without one. */
export async function fixPromptFor(checks: ChecksService | undefined, crId: string, failing: readonly Check[]): Promise<string> {
  const withLogs = await Promise.all(
    failing.slice(0, FIX_CHECKS_MAX).map(async (c) => {
      let logTail = '';
      if (checks && c.hasLog) {
        try {
          logTail = (await checks.log(crId, c.id)).lines.join('\n');
        } catch {
          // the check goes in without its log
        }
      }
      return { name: c.name, state: c.state, jobId: c.id, url: c.url, logTail };
    }),
  );
  return checksFixPrompt(withLogs);
}

/** The most threads one address hands an agent, as `review.triage` reads at most */
export const ADDRESS_THREADS_MAX = 40;
/** The cause an address of review threads writes on the item's move to In progress */
export const REVIEW_ADDRESS_CAUSE = 'pr.review-address';

/** The threads an address hands over: the ones asked for, or every unresolved one; a code for what cannot be addressed. */
export function threadsToAddress(list: ChangeRequestThreads, threadIds: readonly string[]): { threads: ReviewThread[] } | { code: 'not-found' | 'already-resolved' | 'no-threads' } {
  if (!threadIds.length) {
    const open = list.threads.filter((t) => !t.isResolved).slice(0, ADDRESS_THREADS_MAX);
    return open.length ? { threads: open } : { code: 'no-threads' };
  }
  const chosen: ReviewThread[] = [];
  for (const id of new Set(threadIds)) {
    const thread = list.threads.find((t) => t.id === id);
    if (!thread) return { code: 'not-found' };
    if (thread.isResolved) return { code: 'already-resolved' };
    chosen.push(thread);
  }
  return { threads: chosen.slice(0, ADDRESS_THREADS_MAX) };
}

/** What a refused address says, by its code */
export const ADDRESS_REFUSALS = {
  'not-found': 'one of those threads is not in the list any more',
  'already-resolved': 'one of those threads is resolved already',
  'no-threads': 'no review thread is waiting to be addressed',
} as const;

/** The prompt section for the threads handed over. */
export const addressPromptFor = (threads: readonly ReviewThread[]): string =>
  reviewFixPrompt(threads.map((t) => ({ id: t.id, path: t.path, startLine: t.startLine, line: t.line, diffHunk: t.diffHunk, comments: t.comments.map((c) => ({ author: c.author, body: c.body })) })));

/** What the watcher tells the `checks.fix` decision when a change request's rollup reads `failing` for a head it has not announced. */
export interface ChecksFailingNotice {
  kind: ChangeRequestKind;
  /** The change request's row id: the id the checks routes take */
  id: string;
  /** The work item (work item kind) or the orchestration it belongs to */
  ownerId: string;
  headSha: string | null;
  /** Fixes already started for this head, a person's and a decision's together */
  attempts: number;
}

/**
 * What a ChecksTarget needs that no row holds: the CLI's version, and GitLab's numeric project id
 * (the checks calls address `projects/<id>`). Read once per TTL, since the watcher asks every poll.
 */
export class HostFactsCache {
  private readonly facts = new Map<string, { until: number; projectId: number | undefined; cliVersion: string | null }>();

  constructor(private readonly now: () => number) {}

  async of(adapter: ChecksCodeHostAdapter, repo: HostRepo, binaryPath: string, run: (call: HostCall) => Promise<HostResult>): Promise<{ repo: HostRepo; cliVersion: string | null }> {
    const key = `${adapter.id}\0${repo.host}\0${repo.path}\0${binaryPath}`;
    let hit = this.facts.get(key);
    if (!hit || hit.until <= this.now()) {
      const version = await run(adapter.version());
      const cliVersion = version.exitCode === 0 ? adapter.parseVersion(version.stdout) : null;
      let projectId: number | undefined;
      if (adapter.id === 'gitlab') {
        const view = await run(adapter.defaultBranch(repo));
        try {
          const id: unknown = view.exitCode === 0 ? (JSON.parse(view.stdout) as { id?: unknown }).id : undefined;
          if (typeof id === 'number') projectId = id;
        } catch {
          // a project the CLI could not describe has no checks to read
        }
      }
      hit = { until: this.now() + READINESS_TTL, projectId, cliVersion };
      this.facts.set(key, hit);
    }
    return { repo: hit.projectId === undefined ? repo : { ...repo, projectId: hit.projectId }, cliVersion: hit.cliVersion };
  }
}

export { ciOf } from './hosts/github/adapter.ts';

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
  /** Merged over the process's environment for git and the host CLIs: where a test puts its fakes */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** `hosts.json`: which hosts are on and a binary of the person's own; null means every host is on */
  settings?: () => CodeHostsSettings | null;
  /** Where the host CLIs are looked for; the process's PATH and the usual install directories unless a test narrows it */
  searchPath?: () => Promise<string>;
  /** Runs one host call; the execution layer, with the shared breaker, unless a test brings its own */
  run?: HostRun;
  /** The checks of a change request. The watcher reads through it, and a fix takes its failures from it; without one neither does */
  checks?: ChecksService;
  /** The review threads of a change request; without it nothing is addressed */
  reviews?: ReviewsService;
  /** The project's flow is on, so a fix can be a run of its Developer; off, the person gets the prompt for a chat */
  flowOn?: (projectId: string) => boolean;
  /** The hook of `checks.fix`: a change request turned `failing` for a head not announced before */
  onChecksFailing?: (notice: ChecksFailingNotice) => void;
}

/** What a request to fix a work item's checks answers: whether a run started, and the prompt either way. */
export interface FixChecksResult {
  /** False when the project's flow is off: nothing moved, and the person takes `prompt` to a chat in `worktree` */
  started: boolean;
  prompt: string;
  worktree: string | null;
  item: WorkItem;
  pullRequest: WorkItemPullRequest;
}

export interface ApproveResult {
  /** 202 while it is prepared, 200 when a PR was open (or being prepared) already */
  status: 200 | 202;
  item: WorkItem;
  pullRequest: WorkItemPullRequest;
}

/** What a host call needs about a project: the adapter, the CLI's binary and the repository that pins every call. */
interface HostTarget {
  adapter: ChecksCodeHostAdapter;
  binaryPath: string;
  repo: HostRepo;
}

/** Where `origin` points: what is read from git once per readiness TTL, never the URL with its user. */
interface OriginPath {
  until: number;
  hostname: string;
  path: string;
}

/** `owner/name` of a path with any number of groups: the name is the last segment, the owner the rest. */
function repoOf(hostname: string, path: string): HostRepo {
  const at = path.lastIndexOf('/');
  return { host: hostname, path, owner: at === -1 ? '' : path.slice(0, at), name: path.slice(at + 1) };
}

export class PullRequestService {
  private readonly sql: DatabaseSync;
  private readonly registry = new CodeHostRegistry();
  private readonly breaker: HostRateLimiter;
  private readonly runHost: HostRun;
  private readonly readinessCache = new Map<string, { until: number; value: Promise<PullRequestReadiness> }>();
  private readonly originCache = new Map<string, OriginPath>();
  /** Projects whose host CLI failed, and until when the watcher leaves them alone */
  private readonly backoff = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly hostFacts: HostFactsCache;
  /** Fixes being pushed now, so that a double click pushes once */
  private readonly pushing = new Set<string>();
  /** The prompt of an address under way, by row: a restart loses it, and the run then reads every unresolved thread again */
  private readonly addressed = new Map<string, string>();
  /** The head each open change request was last announced `failing` for, so `checks.fix` is asked once per head and not once per poll */
  private readonly announced = new Map<string, string | null>();

  constructor(private readonly deps: PullRequestDeps) {
    this.sql = deps.db.connection;
    this.hostFacts = new HostFactsCache(() => this.now());
    this.breaker = new HostRateLimiter(this.sql);
    // A probe is never retried: a signed-out `glab auth status` exits 1 like a host that cannot be reached, and would wait 5 s for it
    this.runHost =
      deps.run ??
      ((call, where) => runHostCall(call, { binaryPath: where.binaryPath, cwd: where.cwd, baseEnv: where.env, breaker: this.breaker, ...(call.class === 'probe' ? { retry: { delaysMs: [] } } : {}) }));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private env(): NodeJS.ProcessEnv {
    // Nothing may stop to ask for a password or a confirmation in a process nobody watches
    return { ...process.env, ...this.deps.env, GIT_TERMINAL_PROMPT: '0' };
  }

  private gitAsync(cwd: string, args: string[], timeout = 120_000): Promise<void> {
    return runGit(cwd, args, { timeout, env: this.env() });
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

  /** Forgets what was cached, so the next read asks git and the host's CLI again. */
  forgetReadiness(projectPath?: string): void {
    if (projectPath) {
      this.readinessCache.delete(projectPath);
      this.originCache.delete(projectPath);
    } else {
      this.readinessCache.clear();
      this.originCache.clear();
    }
  }

  private computeReadiness(projectPath: string): Promise<PullRequestReadiness> {
    return projectReadiness(projectPath, { registry: this.registry, adapter: codeHostAdapter, settings: this.deps.settings, run: this.runHost, env: this.env(), ...(this.deps.searchPath ? { resolvePath: this.deps.searchPath } : {}) });
  }

  /** `GET /projects/:id/code-host`: the readiness and where `origin` points, without the URL's user or secret. */
  async codeHost(projectPath: string): Promise<ProjectCodeHost> {
    const readiness = await this.readiness(projectPath);
    let remote: ProjectCodeHost['remote'] = null;
    try {
      const parsed = parseRemote(git(mainCheckout(projectPath), ['remote', 'get-url', 'origin'], 10_000));
      if (parsed) remote = { hostname: readiness.hostname ?? parsed.hostname, path: parsed.path, protocol: parsed.protocol };
    } catch {
      // no origin, or not a repository: the readiness says so
    }
    return { readiness, remote };
  }

  // ---------- reaching the host ----------

  private origin(projectPath: string): OriginPath {
    const cached = this.originCache.get(projectPath);
    if (cached && cached.until > this.now()) return cached;
    const parsed = parseRemote(git(mainCheckout(projectPath), ['remote', 'get-url', 'origin'], 10_000));
    if (!parsed) throw new Error('origin does not name a repository on a host');
    const origin = { until: this.now() + READINESS_TTL, hostname: parsed.hostname, path: parsed.path };
    this.originCache.set(projectPath, origin);
    return origin;
  }

  /** The adapter, binary and repository of a project's host. A row's own hostname wins over the remote's, which may be an SSH alias. */
  private async target(projectPath: string, row: Pick<PullRequestRow, 'host' | 'hostname'>): Promise<HostTarget> {
    const id = hostOf(row.host);
    const adapter = codeHostAdapter(id);
    const manifest = this.registry.get(id);
    if (!adapter || !manifest) throw new Error(`no adapter for ${id}`);
    const origin = this.origin(projectPath);
    const searchPath = await (this.deps.searchPath ? this.deps.searchPath() : hostSearchPath(this.env(), homedir()));
    const binaryPath = await resolveHostBinary(manifest, this.deps.settings?.()?.hosts[id]?.binaryPath ?? null, searchPath);
    if (!binaryPath) throw new Error(`${manifest.cli} is not installed, or Agentry cannot find it`);
    return { adapter, binaryPath, repo: repoOf(row.hostname ?? origin.hostname, origin.path) };
  }

  private call(target: HostTarget, call: HostCall, cwd: string): Promise<HostResult> {
    return this.runHost(call, { binaryPath: target.binaryPath, cwd, env: this.env() });
  }

  /** What `ChecksService` needs to read one of this service's rows; null when the row has no number or its project is gone. */
  async checksTarget(row: PullRequestRow): Promise<ChecksTarget | null> {
    if (row.number === null) return null;
    const project = this.deps.project(row.project_id);
    if (!project) return null;
    const target = await this.target(project.path, row);
    const cwd = mainCheckout(project.path);
    const run = (call: HostCall): Promise<HostResult> => this.call(target, call, cwd);
    const facts = await this.hostFacts.of(target.adapter, target.repo, target.binaryPath, run);
    return { id: row.id, kind: 'work-item', adapter: target.adapter, repo: facts.repo, number: row.number, branch: row.branch, base: row.base, cliVersion: facts.cliVersion, run };
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
          `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, branch, base, host, hostname, approved_at, created_at, updated_at)
           VALUES (?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, itemId, item.projectId, place.branch, base, ready.host ?? 'github', ready.hostname, now, now, now);
    });
    if (existing) return { status: 200, item, pullRequest: pullRequestOf(existing) };
    this.changed(itemId, null, PERSON, null);
    this.track(this.prepare(id));
    const row = this.rowById(id);
    return { status: 202, item: this.deps.items.find(itemId) ?? item, pullRequest: row ? pullRequestOf(row) : pullRequestOf({ ...emptyRow(id, itemId, item.projectId, place.branch, base, now, ready.host ?? 'github', ready.hostname) }) };
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
      const { number, url } = await this.create(row, project.path, wt, { title: pullRequestTitle(item), body });
      this.opened(row, item, number, url);
    } catch (err) {
      const step = err instanceof StepError ? err : new StepError('create', messageOf(err));
      this.failed(row, step.code, step.detail);
    }
  }

  /**
   * Opens the change request and finds it. The lookup by head and base follows every create: it
   * gives the number, and after a failed create it is how one that is already open (opened by hand,
   * say) is adopted. Agentry decides nothing from the CLI's stderr.
   */
  private async create(row: PullRequestRow, projectPath: string, cwd: string, req: { title: string; body: string }): Promise<{ number: number | null; url: string | null }> {
    let target: HostTarget;
    try {
      target = await this.target(projectPath, row);
    } catch (err) {
      throw new StepError('create', messageOf(err));
    }
    const created = await this.call(target, target.adapter.create(target.repo, { head: row.branch, base: row.base, title: req.title, body: req.body }), cwd);
    const found = await this.call(target, target.adapter.find(target.repo, { head: row.branch, base: row.base }), cwd);
    let open: Array<{ number: number; url: string }> = [];
    if (found.exitCode === 0) {
      try {
        open = target.adapter.parseFind(found.stdout).filter((c) => c.state === 'open');
      } catch {
        // an answer in a shape this version does not know finds nothing
      }
    }
    const only = open.length === 1 ? open[0] : undefined;
    if (!only) throw new StepError('create', created.exitCode !== 0 ? failureOf(created) : found.exitCode !== 0 ? failureOf(found) : open.length ? 'more than one pull request is open for the branch' : 'the host lists no open pull request for the branch');
    return { number: only.number, url: only.url };
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

  /** The Developer resolved a merge an approval conflicted, and QA's next pass re-verifies it. */
  awaitingVerify(itemId: string): boolean {
    const row = this.newestRow(itemId);
    return row?.phase === 'awaiting-verify' || (row?.phase === 'open' && row.fix_state === 'awaiting-verify');
  }

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
    // The same hook ends a Developer's run on a fix of failing checks
    if (row?.phase === 'open') return this.settleFix(itemId);
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
    if (row?.phase === 'open' && row.fix_state === 'awaiting-verify') {
      this.verifiedFix(row);
      return;
    }
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
      else if (row?.phase === 'open' && row.fix_state) this.dropFix(row);
    } catch {
      // runs inside someone else's event
    }
  }

  // ---------- fixing failing checks ----------

  /**
   * `POST /change-requests/:id/checks/fix` for a work item. The row stays `open`: the change request
   * is still open on the host, and the fix is a state of it. The item goes back to In progress, as the
   * person's move for a click and the system's for the decision, and the flow's Developer starts
   * with the failures in its prompt. With the flow off nothing moves: the person gets the prompt for
   * a chat of their own, in the item's worktree.
   */
  async fixChecks(itemId: string, origin: ChangeRequestFixOrigin = 'person'): Promise<FixChecksResult> {
    const item = this.deps.items.find(itemId);
    if (!item) throw new PullRequestError('work item not found', 404);
    const row = this.newestRow(itemId);
    if (!row || row.phase !== 'open' || row.number === null) throw new PullRequestError(`${item.key} has no open change request to fix`, 409, 'not-open');
    if (row.fix_state) throw new PullRequestError(`a fix of ${item.key}'s checks is already under way`, 409, 'fix-under-way');
    if (this.deps.busy(itemId)) throw new PullRequestError(`${item.key} is being worked on: wait for its chat or run to end`, 409, 'busy');
    const read = await this.readFailures(row);
    if (!read.failing.length) throw new PullRequestError('no check failed on the head commit', 409, 'no-failing-checks');
    const prompt = await this.fixPromptOf(row.id, read.failing);
    const flow = this.deps.flowOn?.(item.projectId) === true;
    if (!flow) return { started: false, prompt, worktree: item.worktree, item, pullRequest: pullRequestOf(row) };
    if (item.status !== 'in_review') throw new PullRequestError(`${item.key} is not in review: a fix starts from an item waiting in In review`, 409, 'not-in-review');
    const attempts = read.headSha && row.fix_head === read.headSha ? (row.fix_attempts ?? 0) + 1 : 1;
    const at = new Date(this.now()).toISOString();
    // moved_at stamps the start: a person's move after it drops the approval the click was
    const started = this.sql
      .prepare("UPDATE work_item_pull_requests SET fix_state = 'fixing', fix_origin = ?, fix_kind = 'checks', fix_attempts = ?, fix_head = ?, moved_at = ?, error_code = NULL, error_detail = NULL, updated_at = ? WHERE id = ? AND phase = 'open' AND fix_state IS NULL")
      .run(origin, attempts, read.headSha, at, at, row.id).changes;
    if (started !== 1) throw new PullRequestError(`a fix of ${item.key}'s checks is already under way`, 409, 'fix-under-way');
    this.changed(itemId, null, SYSTEM, null);
    try {
      this.deps.items.move(itemId, { status: 'in_progress' }, { actor: origin === 'person' ? PERSON : SYSTEM, cause: prCause(CHECKS_FIX_CAUSE) });
    } catch (err) {
      // The card did not move, so no run will start: the attempt goes
      this.update(row.id, { fix_state: null, fix_origin: row.fix_origin ?? null, fix_attempts: row.fix_attempts ?? 0, fix_head: row.fix_head ?? null });
      this.changed(itemId, null, SYSTEM, null);
      throw err;
    }
    const current = this.rowById(row.id) ?? row;
    return { started: true, prompt, worktree: item.worktree, item: this.deps.items.find(itemId) ?? item, pullRequest: pullRequestOf(current) };
  }

  /** Fixes started for a head: what `checks.fix` weighs against the project's limit. */
  fixAttemptsFor(itemId: string, headSha: string | null): number {
    const row = this.newestRow(itemId);
    return row && headSha && row.fix_head === headSha ? (row.fix_attempts ?? 0) : 0;
  }

  /** The prompt section of a fix under way, for the flow's work run; null when the item has none. */
  async fixPrompt(itemId: string): Promise<string | null> {
    const row = this.newestRow(itemId);
    if (!row || row.phase !== 'open' || row.fix_state !== 'fixing') return null;
    if (row.fix_kind === 'review') return this.addressed.get(row.id) ?? (await this.addressPromptOf(row));
    const read = await this.readFailures(row);
    return read.failing.length ? this.fixPromptOf(row.id, read.failing) : null;
  }

  /**
   * `POST /change-requests/:id/address` for a work item: the chosen threads (every unresolved one
   * when none is named) go to the flow's Developer as a fix of kind `review`, on the path of
   * {@link fixChecks}: the same states, the same push rule. The click is the approval to push the
   * QA-verified fix; nothing here replies to or resolves a thread.
   */
  async addressReview(itemId: string, threadIds: readonly string[], origin: ChangeRequestFixOrigin = 'person'): Promise<FixChecksResult> {
    const item = this.deps.items.find(itemId);
    if (!item) throw new PullRequestError('work item not found', 404);
    const row = this.newestRow(itemId);
    if (!row || row.phase !== 'open' || row.number === null) throw new PullRequestError(`${item.key} has no open change request to address`, 409, 'not-open');
    if (row.fix_state) throw new PullRequestError(`a fix of ${item.key}'s change request is already under way`, 409, 'fix-under-way');
    if (this.deps.busy(itemId)) throw new PullRequestError(`${item.key} is being worked on: wait for its chat or run to end`, 409, 'busy');
    const read = await this.readThreads(row, threadIds);
    const prompt = addressPromptFor(read.threads);
    const flow = this.deps.flowOn?.(item.projectId) === true;
    if (!flow) return { started: false, prompt, worktree: item.worktree, item, pullRequest: pullRequestOf(row) };
    if (item.status !== 'in_review') throw new PullRequestError(`${item.key} is not in review: a fix starts from an item waiting in In review`, 409, 'not-in-review');
    const attempts = read.headSha && row.fix_head === read.headSha ? (row.fix_attempts ?? 0) + 1 : 1;
    const at = new Date(this.now()).toISOString();
    const started = this.sql
      .prepare("UPDATE work_item_pull_requests SET fix_state = 'fixing', fix_origin = ?, fix_kind = 'review', fix_attempts = ?, fix_head = ?, moved_at = ?, error_code = NULL, error_detail = NULL, updated_at = ? WHERE id = ? AND phase = 'open' AND fix_state IS NULL")
      .run(origin, attempts, read.headSha, at, at, row.id).changes;
    if (started !== 1) throw new PullRequestError(`a fix of ${item.key}'s change request is already under way`, 409, 'fix-under-way');
    this.addressed.set(row.id, prompt);
    this.changed(itemId, null, SYSTEM, null);
    try {
      this.deps.items.move(itemId, { status: 'in_progress' }, { actor: origin === 'person' ? PERSON : SYSTEM, cause: prCause(REVIEW_ADDRESS_CAUSE) });
    } catch (err) {
      this.addressed.delete(row.id);
      this.update(row.id, { fix_state: null, fix_origin: row.fix_origin ?? null, fix_kind: row.fix_kind ?? null, fix_attempts: row.fix_attempts ?? 0, fix_head: row.fix_head ?? null });
      this.changed(itemId, null, SYSTEM, null);
      throw err;
    }
    const current = this.rowById(row.id) ?? row;
    return { started: true, prompt, worktree: item.worktree, item: this.deps.items.find(itemId) ?? item, pullRequest: pullRequestOf(current) };
  }

  /** The prompt of an address whose chosen threads were lost to a restart: every unresolved thread, as read now. */
  private async addressPromptOf(row: PullRequestRow): Promise<string | null> {
    try {
      return addressPromptFor((await this.readThreads(row, [])).threads);
    } catch {
      return null;
    }
  }

  private async readThreads(row: PullRequestRow, threadIds: readonly string[]): Promise<{ threads: ReviewThread[]; headSha: string | null }> {
    const reviews = this.deps.reviews;
    if (!reviews) throw new PullRequestError('Agentry cannot read review threads here', 409, 'reviews-unavailable');
    try {
      const list = await reviews.threads(row.id, { refresh: true });
      const chosen = threadsToAddress(list, threadIds);
      if ('code' in chosen) throw new PullRequestError(ADDRESS_REFUSALS[chosen.code], 409, chosen.code);
      return { threads: chosen.threads, headSha: list.headSha };
    } catch (err) {
      if (err instanceof ReviewsError) throw new PullRequestError(`the review threads could not be read${err.detail ? `: ${err.detail}` : ''}`, 409, err.reason);
      throw err;
    }
  }

  private async readFailures(row: PullRequestRow): Promise<{ failing: Check[]; headSha: string | null }> {
    const checks = this.deps.checks;
    if (!checks) throw new PullRequestError('Agentry cannot read checks here', 409, 'checks-unavailable');
    try {
      const list = await checks.list(row.id);
      return { failing: failingChecks(list.checks), headSha: list.headSha };
    } catch (err) {
      if (err instanceof ChecksError) throw new PullRequestError(`the checks could not be read${err.detail ? `: ${err.detail}` : ''}`, 409, err.reason);
      throw err;
    }
  }

  private fixPromptOf(crId: string, failing: readonly Check[]): Promise<string> {
    return fixPromptFor(this.deps.checks, crId, failing);
  }

  /**
   * The Developer's run on a fix ended well: QA verifies next. Nothing to do for a run that was not
   * a fix. Called through {@link settleConflict}, the hook the flow already has.
   */
  settleFix(itemId: string): null {
    const row = this.newestRow(itemId);
    if (row?.phase === 'open' && row.fix_state === 'fixing' && this.update(row.id, { fix_state: 'awaiting-verify' }, ['open'])) this.changed(itemId, null, SYSTEM, null);
    return null;
  }

  /**
   * QA passed a fix. A person's click was the approval to push it, remembered since, unless a person
   * moved the card meanwhile; a decision's fix waits for **Push the fix**.
   */
  private verifiedFix(row: PullRequestRow): void {
    if (this.personMovedSince(row.item_id, row.moved_at ?? row.approved_at)) {
      this.dropFix(row);
      return;
    }
    if (row.fix_origin === 'person') {
      this.track(this.pushFixRow(row));
      return;
    }
    if (this.update(row.id, { fix_state: 'awaiting-push' }, ['open'])) this.changed(row.item_id, null, SYSTEM, null);
  }

  /** A person took the card over: whatever was remembered of the fix goes. Its attempts stay counted. */
  private dropFix(row: PullRequestRow): void {
    const r = this.sql.prepare("UPDATE work_item_pull_requests SET fix_state = NULL, fix_origin = NULL, updated_at = ? WHERE id = ? AND phase = 'open' AND fix_state IS NOT NULL").run(new Date(this.now()).toISOString(), row.id);
    this.addressed.delete(row.id);
    if (r.changes === 1) this.changed(row.item_id, null, SYSTEM, null);
  }

  /** `POST /change-requests/:id/push-fix` for a work item: the person's click on **Push the fix**. */
  async pushFix(itemId: string): Promise<{ item: WorkItem; pullRequest: WorkItemPullRequest }> {
    const item = this.deps.items.find(itemId);
    if (!item) throw new PullRequestError('work item not found', 404);
    const row = this.newestRow(itemId);
    if (!row || row.phase !== 'open' || row.fix_state !== 'awaiting-push') throw new PullRequestError(`${item.key} has no verified fix waiting to be pushed`, 409, 'no-fix-to-push');
    if (this.deps.busy(itemId)) throw new PullRequestError(`${item.key} is being worked on: wait for its chat or run to end`, 409, 'busy');
    await this.pushFixRow(row);
    const after = this.rowById(row.id) ?? row;
    if (after.fix_state === 'awaiting-push' && after.error_code) throw new PullRequestError(`could not push ${row.branch}: ${after.error_detail ?? after.error_code}`, 409, after.error_code);
    return { item: this.deps.items.find(itemId) ?? item, pullRequest: pullRequestOf(after) };
  }

  /**
   * Pushes the item's branch with the fix and lets the change request pick up the new head. The
   * branch is pushed as it is, never forced: a branch that moved on the host is a failure the person
   * sees, with the fix still waiting. A failed push leaves `awaiting-push`, so the button retries it.
   */
  private async pushFixRow(row: PullRequestRow): Promise<void> {
    if (this.pushing.has(row.id)) return;
    this.pushing.add(row.id);
    try {
      const item = this.deps.items.find(row.item_id);
      const project = item ? this.deps.project(item.projectId) : null;
      const place = item && project ? itemWorktree(project.path, { ...item, projectId: item.projectId }) : null;
      try {
        if (!item || !place) throw new StepError('commit', 'the item has no worktree');
        try {
          // Concludes work the Developer left uncommitted, as an approval does
          commitAll(place.worktree, `chore(${item.key.toLowerCase()}): ${row.fix_kind === 'review' ? 'address the review comments' : 'fix the failing checks'}`);
        } catch (err) {
          throw new StepError('commit', messageOf(err));
        }
        try {
          await this.gitAsync(place.worktree, ['push', 'origin', row.branch], 180_000);
        } catch (err) {
          throw new StepError('push', messageOf(err));
        }
      } catch (err) {
        const step = err instanceof StepError ? err : new StepError('push', messageOf(err));
        if (this.update(row.id, { fix_state: 'awaiting-push', error_code: step.code, error_detail: step.detail }, ['open'])) this.changed(row.item_id, null, SYSTEM, null);
        return;
      }
      if (!this.update(row.id, { fix_state: null, fix_origin: null, error_code: null, error_detail: null }, ['open'])) return;
      this.addressed.delete(row.id);
      // The head moved: what was read for the old one is stale
      try {
        this.sql.prepare('DELETE FROM change_request_snapshots WHERE cr_id = ?').run(row.id);
      } catch {
        // the snapshot expires by itself
      }
      this.announced.delete(row.id);
      this.changed(row.item_id, null, SYSTEM, null);
      if (item?.status === 'in_review' && item.waiting !== 'merge') {
        try {
          this.deps.items.setFlowState(item.id, { waiting: 'merge' }, { actor: SYSTEM, cause: null });
        } catch {
          // removed meanwhile
        }
      }
    } finally {
      this.pushing.delete(row.id);
    }
  }

  // ---------- watching ----------

  /** The open PRs to ask the host about, oldest checked first. */
  openRows(): PullRequestRow[] {
    return this.sql.prepare("SELECT * FROM work_item_pull_requests WHERE phase = 'open' ORDER BY COALESCE(checked_at, ''), created_at").all() as unknown as PullRequestRow[];
  }

  /**
   * Asks the host about one open PR and writes what changed. `force` is a person's refresh, which does not
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
    let view: ChangeRequestView;
    let read: ChangeRequestRead | null = null;
    try {
      const checks = this.deps.checks;
      const checksTarget = checks ? await this.checksTarget(row) : null;
      if (checks && checksTarget) {
        // One read through the checks service: the state, the rollup and the head together
        read = await checks.readChangeRequest(checksTarget);
        view = read.view;
      } else {
        const home = mainCheckout(project.path);
        const target = await this.target(project.path, row);
        const out = await this.call(target, target.adapter.view(target.repo, row.number), home);
        if (out.exitCode !== 0) throw new Error(failureOf(out));
        view = target.adapter.parseView(out.stdout);
      }
      this.backoff.delete(row.project_id);
    } catch {
      this.backoff.set(row.project_id, this.now() + WATCH_BACKOFF);
      this.update(row.id, { claimed_until: null });
      return;
    }
    const at = new Date(this.now()).toISOString();
    const ci = view.ci;
    const url = view.url ?? row.url;
    if (view.state === 'merged') {
      const mergedAt = view.mergedAt || at;
      // Guarded on the phase: of two processes, only the one whose update lands handles the merge
      if (this.update(row.id, { phase: 'merged', ci, url, closed_at: mergedAt, checked_at: at, claimed_until: null }, ['open'])) await this.merged({ ...row, url }, project.path);
      return;
    }
    if (view.state === 'closed') {
      if (this.update(row.id, { phase: 'closed', ci, url, closed_at: at, checked_at: at, claimed_until: null }, ['open'])) this.closed({ ...row, url });
      return;
    }
    this.update(row.id, { ci, url, checked_at: at, claimed_until: null }, ['open']);
    if (ci !== row.ci || url !== row.url) this.changed(row.item_id, null, SYSTEM, null);
    this.announceFailing(row, ci, read?.headSha ?? null);
  }

  /**
   * Tells `checks.fix` that the rollup reads `failing` for a head it was not told about, once per
   * head. The memory is this process's: after a restart a head still failing is told again, and the
   * decision owns its own limits (attempts, parallel runs, cost). Nothing is told while a fix is
   * under way.
   */
  private announceFailing(row: PullRequestRow, ci: WorkItemPullRequestCi, headSha: string | null): void {
    if (ci !== 'failing') {
      this.announced.delete(row.id);
      return;
    }
    if (!this.deps.onChecksFailing || row.fix_state) return;
    if (this.announced.has(row.id) && this.announced.get(row.id) === headSha) return;
    this.announced.set(row.id, headSha);
    try {
      this.deps.onChecksFailing({ kind: 'work-item', id: row.id, ownerId: row.item_id, headSha, attempts: headSha && row.fix_head === headSha ? (row.fix_attempts ?? 0) : 0 });
    } catch {
      // the decision's failure is not the watcher's
    }
  }

  /**
   * The host merged it, which was the person's act: the item moves to Done as the person, its worktree
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

  /** `POST /work-items/:itemId/pull-request/refresh`: asks the host about the item's open PR now. */
  async refresh(itemId: string): Promise<WorkItem> {
    const item = this.deps.items.find(itemId);
    if (!item) throw new PullRequestError('work item not found', 404);
    const row = this.newestRow(itemId);
    if (row?.phase === 'open') await this.check(row.id, true);
    return this.deps.items.find(itemId) ?? item;
  }
}

function emptyRow(id: string, itemId: string, projectId: string, branch: string, base: string, now: string, host: string, hostname: string | null): PullRequestRow {
  return {
    id,
    item_id: itemId,
    project_id: projectId,
    phase: 'preparing',
    number: null,
    url: null,
    branch,
    base,
    host,
    hostname,
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

/** What the watcher polls: rows to check, and the check that claims one and writes its outcome. */
export interface WatchSource {
  openRows(): ReadonlyArray<{ id: string }>;
  check(rowId: string, force?: boolean): Promise<void>;
}

/**
 * Asks the host about every open change request of its sources, one at a time: every 60 s, once on
 * start, and on a person's refresh. The one deliberate poll of the work item automation, since a
 * host cannot reach a local CLI. A source is the work items' PRs now; the orchestrations' join them.
 */
export class PullRequestWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly sources: readonly WatchSource[];

  constructor(
    sources: WatchSource | readonly WatchSource[],
    private readonly interval = WATCH_INTERVAL,
  ) {
    this.sources = 'openRows' in sources ? [sources] : sources;
  }

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

  /** One pass over the open rows of every source; a pass still going is not started twice. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        for (const source of this.sources) {
          for (const row of source.openRows()) await source.check(row.id).catch(() => undefined);
        }
      } catch {
        // a closed database (shutting down)
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
