import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { CodeHostsSettings, Orchestration, OrchestrationPullRequest, OrchestrationPullRequestPhase, ProjectCodeHost } from '@agentry/shared';
import type { Db } from './db.ts';
import type { AgentryEventInput } from './events.ts';
import { aheadCount, git, mainCheckout, refExists } from './git.ts';
import type { ChangeRequestView, CodeHostAdapter, HostRepo } from './hosts/code-host.ts';
import { hostSearchPath, resolveHostBinary, type HostRun } from './hosts/detector.ts';
import { runHostCall, type HostResult } from './hosts/exec.ts';
import { HostRateLimiter } from './hosts/rate-limit.ts';
import { firstLine } from './hosts/redact.ts';
import { CodeHostRegistry } from './hosts/registry.ts';
import { parseRemote } from './hosts/remote.ts';
import { orchestrationPullRequestOf, type OrchestrationPullRequestRow } from './orchestration-pr-rows.ts';
import { codeHostAdapter, WATCH_BACKOFF } from './pull-requests.ts';
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
  /** Directories whose host CLI failed, and until when the watcher leaves them alone */
  private readonly backoff = new Map<string, number>();

  constructor(private readonly deps: OrchestrationPullRequestDeps) {
    this.sql = deps.db.connection;
    const breaker = new HostRateLimiter(this.sql);
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

  private async target(host: ProjectCodeHost, id: string): Promise<{ adapter: CodeHostAdapter; binaryPath: string; repo: HostRepo }> {
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

  private call(binaryPath: string, call: ReturnType<CodeHostAdapter['version']>, cwd: string): Promise<HostResult> {
    return this.runHost(call, { binaryPath, cwd, env: this.env() });
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
    try {
      await pushBranch(orch.cwd, branch, this.env());
    } catch (err) {
      this.fail(row, 'push', messageOf(err));
      throw new OrchestrationPullRequestError(`could not push ${branch}: ${messageOf(err)}`, 'push');
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

  // ---------- watching ----------

  /** The open requests to ask the host about, oldest checked first. */
  openRows(): OrchestrationPullRequestRow[] {
    return this.sql.prepare("SELECT * FROM orchestration_pull_requests WHERE phase = 'open' ORDER BY COALESCE(checked_at, ''), created_at").all() as unknown as OrchestrationPullRequestRow[];
  }

  /** Asks the host about one open request and writes what changed; a merge or a close reaches the feed, and so does a new CI state. */
  async check(rowId: string, force = false): Promise<void> {
    const row = this.rowById(rowId);
    if (!row || row.phase !== 'open' || row.number === null) return;
    if (!force && (this.backoff.get(row.cwd) ?? 0) > this.now()) return;
    if (!existsSync(row.cwd)) return;
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
    if (!claimed) return;
    let view: ChangeRequestView;
    try {
      const home = mainCheckout(row.cwd);
      const parsed = parseRemote(git(home, ['remote', 'get-url', 'origin'], 10_000));
      if (!parsed) throw new Error('origin does not name a repository on a host');
      const project: ProjectCodeHost = { readiness: { status: 'ready', detail: null, defaultBranch: row.base, host: hostOf(row.host), hostname: row.hostname, remedy: null }, remote: { hostname: row.hostname ?? parsed.hostname, path: parsed.path, protocol: parsed.protocol } };
      const target = await this.target(project, row.host);
      const out = await this.call(target.binaryPath, target.adapter.view(target.repo, row.number), home);
      if (out.exitCode !== 0) throw new Error(failureOf(out));
      view = target.adapter.parseView(out.stdout);
      this.backoff.delete(row.cwd);
    } catch {
      this.backoff.set(row.cwd, this.now() + WATCH_BACKOFF);
      this.update(row.id, { claimed_until: null });
      return;
    }
    const at = this.iso();
    const url = view.url ?? row.url;
    if (view.state === 'merged') {
      if (this.update(row.id, { phase: 'merged', ci: view.ci, url, closed_at: view.mergedAt || at, checked_at: at, claimed_until: null }, ['open'])) this.announce(row, 'Pull request merged');
      return;
    }
    if (view.state === 'closed') {
      if (this.update(row.id, { phase: 'closed', ci: view.ci, url, closed_at: at, checked_at: at, claimed_until: null }, ['open'])) this.announce(row, 'Pull request closed');
      return;
    }
    this.update(row.id, { ci: view.ci, url, checked_at: at, claimed_until: null }, ['open']);
    if (view.ci !== row.ci || url !== row.url) this.announce(row, 'Pull request updated');
  }
}
