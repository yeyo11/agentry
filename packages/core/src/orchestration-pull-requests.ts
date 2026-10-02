import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Check, CodeHostsSettings, Orchestration, OrchestrationPullRequest, OrchestrationPullRequestPhase, ProjectCodeHost, ReviewThread, WorkItemPullRequestCi } from '@agentry/shared';
import type { Db } from './db.ts';
import type { AgentryEventInput } from './events.ts';
import { aheadCount, commitAll, git, mainCheckout, refExists } from './git.ts';
import { ChecksError, type ChecksService, type ChecksTarget } from './hosts/checks-service.ts';
import type { ChangeRequestRead, ChangeRequestView, ChecksCodeHostAdapter, HostCall, HostRepo, ReviewsCodeHostAdapter } from './hosts/code-host.ts';
import { hostSearchPath, resolveHostBinary, type HostRun } from './hosts/detector.ts';
import { runHostCall, type HostResult } from './hosts/exec.ts';
import { HostRateLimiter } from './hosts/rate-limit.ts';
import { firstLine } from './hosts/redact.ts';
import { CodeHostRegistry } from './hosts/registry.ts';
import { parseRemote } from './hosts/remote.ts';
import { orchestrationPullRequestOf, type OrchestrationPullRequestRow } from './orchestration-pr-rows.ts';
import { reviewDiff } from './hosts/review-diff.ts';
import type { MergeService, PushHold } from './hosts/merge-service.ts';
import { ReviewsError, type ReviewsService, type ReviewsTarget } from './hosts/reviews-service.ts';
import type { PaceOutcome } from './hosts/pacer.ts';
import { ADDRESS_REFUSALS, addressPromptFor, codeHostAdapter, failingChecks, fixPromptFor, HostFactsCache, threadsToAddress, type ChecksFailingNotice } from './pull-requests.ts';
import { hostOf } from './work-item-rows.ts';

/**
 * An orchestration's change request (docs/plans/code-hosts.md, phase 1): the person asks for it on a
 * graph whose integration branch is built and checked, and Agentry pushes that branch and opens the
 * pull request (or merge request) with the project's host CLI, against the default branch. The
 * person merges it on the host; the watcher records the merge or the close. An orchestration has no
 * Done to move, so nothing else follows from either.
 *
 * Everything runs asynchronously: the old synchronous push and `gh` call held the event loop for up
 * to five minutes. Only ever on request: no run pushes.
 */

const BODY_MAX = 60_000;
/** A check claimed longer ago than this was dropped by a process that died: another may take it */
const CLAIM_TTL = 2 * 60_000;

/** What an orchestration's request needs from the project: its readiness and where `origin` points. */
export interface OrchestrationPullRequestDeps {
  db: Db;
  /** The project's readiness and remote; `PullRequestService.codeHost` */
  codeHost: (path: string) => Promise<ProjectCodeHost>;
  emit: (event: AgentryEventInput) => void;
  /** Merged over the process's environment for git and the host CLIs: where a test puts its fakes */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  settings?: () => CodeHostsSettings | null;
  searchPath?: () => Promise<string>;
  /** Runs one host call; the execution layer unless a test brings its own */
  run?: HostRun;
  /** The checks of a change request. The watcher reads through it, and a fix takes its failures from it; without one neither does */
  checks?: ChecksService;
  /** The review threads of a change request; without it nothing is addressed */
  reviews?: ReviewsService;
  /** Turns auto-merge off before a push to the branch of an open change request */
  merge?: MergeService;
  /**
   * Starts the fixer's chat in the integration worktree (the orchestration's fixer model and cost
   * limit) and settles when it ends. It commits on the integration branch and never pushes.
   */
  runFix?: (req: { orchestrationId: string; cwd: string; branch: string; prompt: string }) => Promise<{ ok: boolean }>;
  /** The hook of `checks.fix`: a change request turned `failing` for a head not announced before */
  onChecksFailing?: (notice: ChecksFailingNotice) => void;
}

/** What a request to fix an orchestration's checks answers: the prompt the fixer got, and the request as it stands. */
export interface FixStarted {
  prompt: string;
  pullRequest: OrchestrationPullRequest | null;
}

/** What `POST /orchestrations/:id/pull-request` answers; `url` and `detail` are what it always had. */
export interface OpenedPullRequest {
  branch: string;
  url: string | null;
  detail: string;
  pullRequest: OrchestrationPullRequest | null;
}

/** Why a request is refused or stopped, with the reason code a client words. */
export class OrchestrationPullRequestError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

const messageOf = (err: unknown): string => firstLine(err instanceof Error ? err.message : String(err));
const failureOf = (result: HostResult): string => result.stderrFirstLine || result.reason || `exit ${result.exitCode ?? 'none'}`;

/** Runs git without blocking the server; a failure carries the first line git wrote. */
function pushBranch(cwd: string, branch: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, 'push', '-u', 'origin', branch], { cwd, timeout: 180_000, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve();
      const killed = (err as { killed?: boolean }).killed;
      reject(new Error(firstLine(stderr) || firstLine(stdout) || (killed ? 'git timed out' : err.message)));
    });
  });
}

/** The request's text: objective, how the checks went and the final result, cut at 60 000 characters. */
export function orchestrationPullRequestBody(orch: Pick<Orchestration, 'name' | 'objective' | 'verification' | 'finalResult'>): string {
  const checked = orch.verification && orch.verification.status !== 'pending' ? `Verification: ${orch.verification.status}. ${orch.verification.report}` : null;
  const body = [orch.objective, checked, orch.finalResult].filter(Boolean).join('\n\n---\n\n') || orch.name;
  return body.slice(0, BODY_MAX);
}

export class OrchestrationPullRequestService {
  private readonly sql: DatabaseSync;
  private readonly registry = new CodeHostRegistry();
  private readonly runHost: HostRun;
  private readonly breaker: HostRateLimiter;
  private readonly hostFacts: HostFactsCache;
  private readonly pending = new Set<Promise<void>>();
  private readonly pushing = new Set<string>();
  /** The head each open request was last announced `failing` for: `checks.fix` is asked once per head */
  private readonly announced = new Map<string, string | null>();

  constructor(private readonly deps: OrchestrationPullRequestDeps) {
    this.sql = deps.db.connection;
    this.hostFacts = new HostFactsCache(() => this.now());
    const breaker = (this.breaker = new HostRateLimiter(this.sql));
    this.runHost = deps.run ?? ((call, where) => runHostCall(call, { binaryPath: where.binaryPath, cwd: where.cwd, baseEnv: where.env, breaker }));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private env(): NodeJS.ProcessEnv {
    // Nothing may stop to ask for a password in a process nobody watches
    return { ...process.env, ...this.deps.env, GIT_TERMINAL_PROMPT: '0' };
  }

  // ---------- rows ----------

  private rowById(id: string): OrchestrationPullRequestRow | null {
    return (this.sql.prepare('SELECT * FROM orchestration_pull_requests WHERE id = ?').get(id) as OrchestrationPullRequestRow | undefined) ?? null;
  }

  private newestRow(orchestrationId: string): OrchestrationPullRequestRow | null {
    return (this.sql.prepare('SELECT * FROM orchestration_pull_requests WHERE orchestration_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(orchestrationId) as OrchestrationPullRequestRow | undefined) ?? null;
  }

  /** The orchestration's newest change request, for its read model. */
  newest(orchestrationId: string): OrchestrationPullRequest | null {
    const row = this.newestRow(orchestrationId);
    return row ? orchestrationPullRequestOf(row) : null;
  }

  private update(id: string, fields: Partial<Omit<OrchestrationPullRequestRow, 'id' | 'orchestration_id'>>, guard?: OrchestrationPullRequestPhase[]): boolean {
    const entries = Object.entries({ ...fields, updated_at: this.iso() });
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => (v === undefined ? null : v)) as Array<string | number | null>;
    const where = guard ? ' AND phase IN (SELECT value FROM json_each(?))' : '';
    return this.sql.prepare(`UPDATE orchestration_pull_requests SET ${sets} WHERE id = ?${where}`).run(...values, id, ...(guard ? [JSON.stringify(guard)] : [])).changes === 1;
  }

  /** Inserts under `BEGIN IMMEDIATE`: of two clicks, or two processes, the unique index lets one in. */
  private insert(row: OrchestrationPullRequestRow): boolean {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql
        .prepare(
          `INSERT INTO orchestration_pull_requests (id, orchestration_id, cwd, host, hostname, phase, branch, base, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?)`,
        )
        .run(row.id, row.orchestration_id, row.cwd, row.host, row.hostname, row.branch, row.base, row.created_at, row.updated_at);
      this.sql.exec('COMMIT');
      return true;
    } catch (err) {
      try {
        this.sql.exec('ROLLBACK');
      } catch {
        // already ended by SQLite
      }
      if (this.newestRow(row.orchestration_id)?.phase === 'preparing' || this.newestRow(row.orchestration_id)?.phase === 'open') return false;
      throw err;
    }
  }

  private announce(row: OrchestrationPullRequestRow, title: string): void {
    const current = this.rowById(row.id) ?? row;
    this.deps.emit({ type: 'orchestration.pull-request', title, orchestrationId: row.orchestration_id, pullRequest: orchestrationPullRequestOf(current) });
  }

  // ---------- reaching the host ----------

  private async target(host: ProjectCodeHost, id: string): Promise<{ adapter: ReviewsCodeHostAdapter; binaryPath: string; repo: HostRepo }> {
    const adapter = codeHostAdapter(hostOf(id));
    const manifest = this.registry.get(hostOf(id));
    if (!adapter || !manifest || !host.remote) throw new Error(`no adapter for ${id}`);
    const searchPath = await (this.deps.searchPath ? this.deps.searchPath() : hostSearchPath(this.env(), homedir()));
    const binaryPath = await resolveHostBinary(manifest, this.deps.settings?.()?.hosts[hostOf(id)]?.binaryPath ?? null, searchPath);
    if (!binaryPath) throw new Error(`${manifest.cli} is not installed, or Agentry cannot find it`);
    const at = host.remote.path.lastIndexOf('/');
    const repo: HostRepo = { host: host.remote.hostname, path: host.remote.path, owner: at === -1 ? '' : host.remote.path.slice(0, at), name: host.remote.path.slice(at + 1) };
    return { adapter, binaryPath, repo };
  }

  private call(binaryPath: string, call: HostCall, cwd: string): Promise<HostResult> {
    return this.runHost(call, { binaryPath, cwd, env: this.env() });
  }

  /** What `ChecksService` needs to read a row; the remote comes from git, the row's own hostname wins over it. */
  async checksTarget(row: OrchestrationPullRequestRow): Promise<ChecksTarget | null> {
    if (row.number === null) return null;
    const home = mainCheckout(row.cwd);
    const parsed = parseRemote(git(home, ['remote', 'get-url', 'origin'], 10_000));
    if (!parsed) throw new Error('origin does not name a repository on a host');
    const project: ProjectCodeHost = { readiness: { status: 'ready', detail: null, defaultBranch: row.base, host: hostOf(row.host), hostname: row.hostname, remedy: null }, remote: { hostname: row.hostname ?? parsed.hostname, path: parsed.path, protocol: parsed.protocol } };
    const target = await this.target(project, row.host);
    const run = (call: HostCall): Promise<HostResult> => this.call(target.binaryPath, call, home);
    const facts = await this.hostFacts.of(target.adapter, target.repo, target.binaryPath, run);
    return { id: row.id, kind: 'orchestration', adapter: target.adapter, repo: facts.repo, number: row.number, branch: row.branch, base: row.base, cliVersion: facts.cliVersion, run };
  }

  /** What `ReviewsService` needs for one row: the checks target and the local diff the person reviews. */
  async reviewsTarget(row: OrchestrationPullRequestRow): Promise<ReviewsTarget | null> {
    const base = await this.checksTarget(row);
    const adapter = codeHostAdapter(hostOf(row.host));
    if (!base || !adapter) return null;
    const home = mainCheckout(row.cwd);
    return { id: base.id, kind: base.kind, adapter, repo: base.repo, number: base.number, run: base.run, diff: async () => reviewDiff(home, row.base, row.branch) };
  }

  // ---------- opening ----------

  /**
   * Publishes the integration branch and opens its change request. Refused, with nothing pushed, when
   * the project is not ready or the branch has nothing the default branch lacks (GitLab would accept
   * an empty merge request). A request already being opened, or open, is answered as it stands.
   */
  async open(orch: Orchestration): Promise<OpenedPullRequest> {
    const integration = orch.integration;
    if (!integration) throw new OrchestrationPullRequestError('the orchestration has no integrated branch yet', 'nothing-to-propose');
    const branch = integration.branch;
    const live = this.newestRow(orch.id);
    if (live && (live.phase === 'open' || live.phase === 'preparing')) return this.answer(live, branch);
    const project = await this.deps.codeHost(orch.cwd);
    const ready = project.readiness;
    if (ready.status !== 'ready' || !ready.defaultBranch) {
      throw new OrchestrationPullRequestError(`this project cannot open pull requests (${ready.status})${ready.detail ? `: ${ready.detail}` : ''}`, ready.status);
    }
    const base = ready.defaultBranch;
    const against = refExists(orch.cwd, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;
    if (aheadCount(orch.cwd, against, branch) === 0) {
      throw new OrchestrationPullRequestError(`${branch} has no commit that ${base} lacks: nothing to propose`, 'nothing-to-propose');
    }
    const now = this.iso();
    const row: OrchestrationPullRequestRow = {
      id: randomUUID(),
      orchestration_id: orch.id,
      cwd: orch.cwd,
      host: ready.host ?? 'github',
      hostname: ready.hostname,
      phase: 'preparing',
      number: null,
      url: null,
      branch,
      base,
      ci: null,
      error_code: null,
      error_detail: null,
      opened_at: null,
      closed_at: null,
      checked_at: null,
      claimed_until: null,
      created_at: now,
      updated_at: now,
    };
    if (!this.insert(row)) {
      const winner = this.newestRow(orch.id);
      if (winner) return this.answer(winner, branch);
    }
    this.announce(row, 'Opening a pull request');
    let hold: PushHold | null = null;
    try {
      hold = await this.holdExisting(row, project);
      await pushBranch(orch.cwd, branch, this.env());
    } catch (err) {
      this.fail(row, 'push', messageOf(err));
      throw new OrchestrationPullRequestError(`could not push ${branch}: ${messageOf(err)}`, 'push');
    } finally {
      hold?.release();
    }
    try {
      const found = await this.create(row, project, { title: orch.name, body: orchestrationPullRequestBody(orch) });
      this.update(row.id, { phase: 'open', number: found.number, url: found.url, opened_at: this.iso(), error_code: null, error_detail: null }, ['preparing']);
      this.announce(row, 'Pull request opened');
      return { branch, url: found.url, detail: 'pull request opened', pullRequest: this.newest(orch.id) };
    } catch (err) {
      const detail = messageOf(err);
      this.fail(row, 'create', detail);
      return { branch, url: null, detail: `pushed ${branch}, but no pull request was opened: ${detail}`, pullRequest: this.newest(orch.id) };
    }
  }

  /**
   * The push that opens a request can land on a branch that already has one (opened by hand, or by an
   * earlier try) with auto-merge armed. The open request is found by head and base, and the push is held
   * the way a fix's is: auto-merge off first, the request guarded until the push ends. Nothing found, or a
   * host that cannot be asked, holds nothing: the create that follows meets the same host.
   */
  private async holdExisting(row: OrchestrationPullRequestRow, project: ProjectCodeHost): Promise<PushHold | null> {
    if (!this.deps.merge) return null;
    let number: number | null = null;
    try {
      const target = await this.target(project, row.host);
      const found = await this.call(target.binaryPath, target.adapter.find(target.repo, { head: row.branch, base: row.base }), row.cwd);
      if (found.exitCode === 0) {
        const open = target.adapter.parseFind(found.stdout).filter((c) => c.state === 'open');
        if (open.length === 1) number = open[0]?.number ?? null;
      }
    } catch {
      return null;
    }
    if (number === null) return null;
    // The row now names the request, which is how the merge service resolves it
    this.update(row.id, { number }, ['preparing']);
    return this.deps.merge.holdForPush(row.id);
  }

  private answer(row: OrchestrationPullRequestRow, branch: string): OpenedPullRequest {
    return { branch, url: row.url, detail: row.phase === 'open' ? 'already open' : 'already being opened', pullRequest: orchestrationPullRequestOf(row) };
  }

  private fail(row: OrchestrationPullRequestRow, code: string, detail: string): void {
    if (this.update(row.id, { phase: 'failed', error_code: code, error_detail: detail }, ['preparing'])) this.announce(row, 'Pull request failed');
  }

  /**
   * Opens it and finds it by head and base: the lookup gives the number, and after a failed create it
   * is how one already open (opened by hand, say) is adopted. Nothing is decided from stderr.
   */
  private async create(row: OrchestrationPullRequestRow, project: ProjectCodeHost, req: { title: string; body: string }): Promise<{ number: number; url: string }> {
    const target = await this.target(project, row.host);
    const created = await this.call(target.binaryPath, target.adapter.create(target.repo, { head: row.branch, base: row.base, title: req.title, body: req.body }), row.cwd);
    const found = await this.call(target.binaryPath, target.adapter.find(target.repo, { head: row.branch, base: row.base }), row.cwd);
    let open: Array<{ number: number; url: string }> = [];
    if (found.exitCode === 0) {
      try {
        open = target.adapter.parseFind(found.stdout).filter((c) => c.state === 'open');
      } catch {
        // an answer in a shape this version does not know finds nothing
      }
    }
    const only = open.length === 1 ? open[0] : undefined;
    if (!only) throw new Error(created.exitCode !== 0 ? failureOf(created) : found.exitCode !== 0 ? failureOf(found) : open.length ? 'more than one pull request is open for the branch' : 'the host lists no open pull request for the branch');
    return only;
  }

  // ---------- fixing failing checks ----------

  /** Waits for the fixes started so far; for tests and for shutting down cleanly. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /**
   * `POST /change-requests/:id/checks/fix` for an orchestration: a chat in the integration worktree
   * with the failures in its prompt, which commits on the integration branch. An orchestration has
   * no QA stage to verify the fix, so the request then waits for **Push the fix**, always a person's
   * click.
   */
  async fixChecks(orch: Orchestration): Promise<FixStarted> {
    const row = this.newestRow(orch.id);
    if (!row || row.phase !== 'open' || row.number === null) throw new OrchestrationPullRequestError('the orchestration has no open change request to fix', 'not-open');
    if (row.fix_state) throw new OrchestrationPullRequestError('a fix of the checks is already under way', 'fix-under-way');
    const runFix = this.deps.runFix;
    if (!runFix) throw new OrchestrationPullRequestError('Agentry cannot start the fixer here', 'fix-unavailable');
    // The fixer commits on the integration branch, so it needs the worktree that has it checked out: never the project's own checkout
    const cwd = orch.integration?.worktree;
    if (!cwd || !existsSync(cwd)) throw new OrchestrationPullRequestError('the integration worktree is gone, so there is nowhere to fix the branch', 'no-worktree');
    const checks = this.deps.checks;
    if (!checks) throw new OrchestrationPullRequestError('Agentry cannot read checks here', 'checks-unavailable');
    let failing: Check[];
    let headSha: string | null;
    try {
      const list = await checks.list(row.id);
      failing = failingChecks(list.checks);
      headSha = list.headSha;
    } catch (err) {
      if (err instanceof ChecksError) throw new OrchestrationPullRequestError(`the checks could not be read${err.detail ? `: ${err.detail}` : ''}`, err.reason);
      throw err;
    }
    if (!failing.length) throw new OrchestrationPullRequestError('no check failed on the head commit', 'no-failing-checks');
    const prompt = await fixPromptFor(checks, row.id, failing);
    const attempts = headSha && row.fix_head === headSha ? (row.fix_attempts ?? 0) + 1 : 1;
    const started = this.sql
      .prepare("UPDATE orchestration_pull_requests SET fix_state = 'fixing', fix_origin = 'person', fix_kind = 'checks', fix_attempts = ?, fix_head = ?, error_code = NULL, error_detail = NULL, updated_at = ? WHERE id = ? AND phase = 'open' AND fix_state IS NULL")
      .run(attempts, headSha, this.iso(), row.id).changes;
    if (started !== 1) throw new OrchestrationPullRequestError('a fix of the checks is already under way', 'fix-under-way');
    this.announce(row, 'Fixing the failing checks');
    const work = runFix({ orchestrationId: orch.id, cwd, branch: row.branch, prompt }).then(
      (result) => this.settleFix(orch.id, result.ok),
      () => this.settleFix(orch.id, false),
    );
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return { prompt, pullRequest: this.newest(orch.id) };
  }

  /**
   * `POST /change-requests/:id/address` for an orchestration: the chosen threads (every unresolved
   * one when none is named) go to the fixer's chat, as {@link fixChecks} hands it failures. The
   * fixer commits and never pushes, never replies and never resolves; the request then waits for
   * **Push the fix**.
   */
  async addressReview(orch: Orchestration, threadIds: readonly string[]): Promise<FixStarted> {
    const row = this.newestRow(orch.id);
    if (!row || row.phase !== 'open' || row.number === null) throw new OrchestrationPullRequestError('the orchestration has no open change request to address', 'not-open');
    if (row.fix_state) throw new OrchestrationPullRequestError('a fix of the change request is already under way', 'fix-under-way');
    const runFix = this.deps.runFix;
    if (!runFix) throw new OrchestrationPullRequestError('Agentry cannot start the fixer here', 'fix-unavailable');
    const cwd = orch.integration?.worktree;
    if (!cwd || !existsSync(cwd)) throw new OrchestrationPullRequestError('the integration worktree is gone, so there is nowhere to fix the branch', 'no-worktree');
    const reviews = this.deps.reviews;
    if (!reviews) throw new OrchestrationPullRequestError('Agentry cannot read review threads here', 'reviews-unavailable');
    let threads: ReviewThread[];
    let headSha: string | null;
    try {
      const list = await reviews.threads(row.id, { refresh: true });
      const chosen = threadsToAddress(list, threadIds);
      if ('code' in chosen) throw new OrchestrationPullRequestError(ADDRESS_REFUSALS[chosen.code], chosen.code);
      threads = chosen.threads;
      headSha = list.headSha;
    } catch (err) {
      if (err instanceof ReviewsError) throw new OrchestrationPullRequestError(`the review threads could not be read${err.detail ? `: ${err.detail}` : ''}`, err.reason);
      throw err;
    }
    const prompt = addressPromptFor(threads);
    const attempts = headSha && row.fix_head === headSha ? (row.fix_attempts ?? 0) + 1 : 1;
    const started = this.sql
      .prepare("UPDATE orchestration_pull_requests SET fix_state = 'fixing', fix_origin = 'person', fix_kind = 'review', fix_attempts = ?, fix_head = ?, error_code = NULL, error_detail = NULL, updated_at = ? WHERE id = ? AND phase = 'open' AND fix_state IS NULL")
      .run(attempts, headSha, this.iso(), row.id).changes;
    if (started !== 1) throw new OrchestrationPullRequestError('a fix of the change request is already under way', 'fix-under-way');
    this.announce(row, 'Addressing the review comments');
    const work = runFix({ orchestrationId: orch.id, cwd, branch: row.branch, prompt }).then(
      (result) => this.settleFix(orch.id, result.ok),
      () => this.settleFix(orch.id, false),
    );
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return { prompt, pullRequest: this.newest(orch.id) };
  }

  /** The fixer's chat ended: well, and the fix waits for the person's **Push the fix**; badly, and nothing is left under way. */
  settleFix(orchestrationId: string, ok: boolean): void {
    const row = this.newestRow(orchestrationId);
    if (!row || row.phase !== 'open' || row.fix_state !== 'fixing') return;
    if (this.update(row.id, ok ? { fix_state: 'awaiting-push' } : { fix_state: null, fix_origin: null }, ['open'])) this.announce(row, ok ? 'Fix ready to push' : 'The fix did not finish');
  }

  /**
   * `POST /change-requests/:id/push-fix` for an orchestration. Pushed as it is, never forced; a
   * failure is recorded and the fix keeps waiting, so the button retries it.
   */
  async pushFix(orch: Orchestration): Promise<OrchestrationPullRequest | null> {
    const row = this.newestRow(orch.id);
    if (!row || row.phase !== 'open' || row.fix_state !== 'awaiting-push') throw new OrchestrationPullRequestError('no fix is waiting to be pushed', 'no-fix-to-push');
    if (this.pushing.has(row.id)) return this.newest(orch.id);
    this.pushing.add(row.id);
    let hold: PushHold | undefined;
    try {
      const worktree = orch.integration?.worktree;
      try {
        // Concludes what the fixer left uncommitted on the integration branch; only in its own worktree, never in the project's checkout
        if (worktree && existsSync(worktree)) commitAll(worktree, row.fix_kind === 'review' ? 'chore: address the review comments' : 'chore: fix the failing checks');
        hold = await this.deps.merge?.holdForPush(row.id);
        await pushBranch(worktree && existsSync(worktree) ? worktree : row.cwd, row.branch, this.env());
      } catch (err) {
        const detail = messageOf(err);
        if (this.update(row.id, { error_code: 'push', error_detail: detail }, ['open'])) this.announce(row, 'Pushing the fix failed');
        throw new OrchestrationPullRequestError(`could not push ${row.branch}: ${detail}`, 'push');
      } finally {
        // The push is over, well or not: the person may arm again
        hold?.release();
      }
      if (this.update(row.id, { fix_state: null, fix_origin: null, error_code: null, error_detail: null }, ['open'])) {
        // The head moved: what was read for the old one is stale
        try {
          this.sql.prepare('DELETE FROM change_request_snapshots WHERE cr_id = ?').run(row.id);
        } catch {
          // the snapshot expires by itself
        }
        this.announced.delete(row.id);
        this.announce(row, 'Fix pushed');
      }
      return this.newest(orch.id);
    } finally {
      this.pushing.delete(row.id);
    }
  }

  // ---------- watching ----------

  /** The open requests to ask the host about, oldest checked first. */
  openRows(): OrchestrationPullRequestRow[] {
    return this.sql.prepare("SELECT * FROM orchestration_pull_requests WHERE phase = 'open' ORDER BY COALESCE(checked_at, ''), created_at").all() as unknown as OrchestrationPullRequestRow[];
  }

  /** The change request as `view` reads it, for a service without a checks service. */
  private async viewOf(row: OrchestrationPullRequestRow): Promise<ChangeRequestView> {
    if (row.number === null) throw new Error('the request has no number');
    const home = mainCheckout(row.cwd);
    const parsed = parseRemote(git(home, ['remote', 'get-url', 'origin'], 10_000));
    if (!parsed) throw new Error('origin does not name a repository on a host');
    const project: ProjectCodeHost = { readiness: { status: 'ready', detail: null, defaultBranch: row.base, host: hostOf(row.host), hostname: row.hostname, remedy: null }, remote: { hostname: row.hostname ?? parsed.hostname, path: parsed.path, protocol: parsed.protocol } };
    const target = await this.target(project, row.host);
    const out = await this.call(target.binaryPath, target.adapter.view(target.repo, row.number), home);
    if (out.exitCode !== 0) throw new Error(failureOf(out));
    return target.adapter.parseView(out.stdout);
  }

  /** The host's floor: under it, background polling stays away and only a person's own action goes through. */
  private belowFloor(row: OrchestrationPullRequestRow): boolean {
    if (!row.hostname) return false;
    const gitlab = row.host === 'gitlab';
    return (gitlab ? (['core'] as const) : (['core', 'graphql'] as const)).some((bucket) => this.breaker.backgroundPaused(row.hostname ?? '', bucket, gitlab ? 'glab' : 'gh'));
  }

  /**
   * Asks the host about one open request and writes what changed; a merge or a close reaches the feed,
   * and so does a new CI state. As the work items' check, it says how the read went (read, failed, held
   * back by the floor, or not sent) and the pacer sets the back-off; `force` is a person's refresh.
   */
  async check(rowId: string, force = false): Promise<PaceOutcome> {
    const row = this.rowById(rowId);
    if (!row || row.phase !== 'open' || row.number === null) return 'skipped';
    if (!force && this.belowFloor(row)) return 'paused';
    if (!existsSync(row.cwd)) return 'skipped';
    const now = this.now();
    this.sql.exec('BEGIN IMMEDIATE');
    let claimed = false;
    try {
      claimed =
        this.sql
          .prepare("UPDATE orchestration_pull_requests SET claimed_until = ? WHERE id = ? AND phase = 'open' AND (claimed_until IS NULL OR claimed_until < ?)")
          .run(new Date(now + CLAIM_TTL).toISOString(), row.id, new Date(now).toISOString()).changes === 1;
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
    if (!claimed) return 'skipped';
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
        view = await this.viewOf(row);
      }
    } catch {
      this.update(row.id, { claimed_until: null });
      return 'failed';
    }
    const at = this.iso();
    const url = view.url ?? row.url;
    if (view.state === 'merged') {
      if (this.update(row.id, { phase: 'merged', ci: view.ci, url, closed_at: view.mergedAt || at, checked_at: at, claimed_until: null }, ['open'])) this.announce(row, 'Pull request merged');
      return 'read';
    }
    if (view.state === 'closed') {
      if (this.update(row.id, { phase: 'closed', ci: view.ci, url, closed_at: at, checked_at: at, claimed_until: null }, ['open'])) this.announce(row, 'Pull request closed');
      return 'read';
    }
    this.update(row.id, { ci: view.ci, url, checked_at: at, claimed_until: null }, ['open']);
    if (view.ci !== row.ci || url !== row.url) this.announce(row, 'Pull request updated');
    this.announceFailing(row, view.ci, read?.headSha ?? null);
    return 'read';
  }

  /** As the work items' watcher: `checks.fix` is told once per failing head, and nothing while a fix is under way. */
  private announceFailing(row: OrchestrationPullRequestRow, ci: WorkItemPullRequestCi, headSha: string | null): void {
    if (ci !== 'failing') {
      this.announced.delete(row.id);
      return;
    }
    if (!this.deps.onChecksFailing || row.fix_state) return;
    if (this.announced.has(row.id) && this.announced.get(row.id) === headSha) return;
    this.announced.set(row.id, headSha);
    try {
      this.deps.onChecksFailing({ kind: 'orchestration', id: row.id, ownerId: row.orchestration_id, headSha, attempts: headSha && row.fix_head === headSha ? (row.fix_attempts ?? 0) : 0 });
    } catch {
      // the decision's failure is not the watcher's
    }
  }
}
