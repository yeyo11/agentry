import type { DatabaseSync } from 'node:sqlite';
import type { Check, ChangeRequestChecks, ChangeRequestKind, CheckLog, CheckAnnotation, ChecksRerunRequest, HostReason, WorkItemPullRequestCi } from '@agentry/shared';
import type { AgentryEventInput } from '../events.ts';
import type { ChangeRequestSnapshotRow } from '../work-item-rows.ts';
import { reasonOf } from './classify.ts';
import { HostParseError, HostRequestError, MAX_CHECKS, type ChangeRequestRead, type ChecksCodeHostAdapter, type ChecksFollowUp, type HeadPipeline, type HostCall, type HostRepo } from './code-host.ts';
import type { HostResult } from './exec.ts';
import { tailLog } from './log-tail.ts';
import { firstLine } from './redact.ts';

// What a change request's checks need beyond the adapters: the 30 s snapshot shared by the board and
// every tab, the rounds of a list, the log through the tail, and the writes (re-run, cancel, play)
// that are never retried and always followed by a re-read. The adapters only build calls and parse
// what came back; this runs them (docs/plans/code-hosts.md, phase 2). The watcher's read lives here
// as `readChangeRequest`, and the pull request services wire it.

/** How long a check list is served from its snapshot */
export const SNAPSHOT_TTL = 30_000;
/** What a read that hit the host's rate limit waits when the host did not say */
const LIMIT_FALLBACK = 60_000;

/** Why the service did not do what was asked: the reason a client words, and the first line the host said */
export class ChecksError extends Error {
  constructor(
    message: string,
    readonly reason: HostReason,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'ChecksError';
  }
}

/**
 * Everything a call needs about one change request, resolved by the caller from the row: which
 * adapter and repository, the CLI to run them through (bound to its binary and working directory)
 * and the facts the adapters ask for. `repo.projectId` must be set for GitLab.
 */
export interface ChecksTarget {
  id: string;
  kind: ChangeRequestKind;
  adapter: ChecksCodeHostAdapter;
  repo: HostRepo;
  number: number;
  /** The source branch */
  branch: string;
  base: string;
  /** The CLI's version from readiness, for the log call's flags */
  cliVersion: string | null;
  run: (call: HostCall) => Promise<HostResult>;
}

export interface ChecksServiceDeps {
  db: DatabaseSync;
  /** The target of a row id from either table; null when no change request has it or it has no number */
  resolve: (id: string) => Promise<ChecksTarget | null>;
  emit?: (event: AgentryEventInput) => void;
  now?: () => number;
}

interface Snapshot {
  kind: string;
  headSha: string | null;
  checks: Check[];
  truncated: boolean;
  rollup: WorkItemPullRequestCi;
  headPipeline: HeadPipeline | null;
  fetchedAt: string;
}

const ROLLUPS: readonly string[] = ['none', 'pending', 'passing', 'failing'];

function readSnapshot(row: ChangeRequestSnapshotRow | undefined): Snapshot | null {
  if (!row) return null;
  try {
    const stored: unknown = row.checks ? JSON.parse(row.checks) : { checks: [] };
    // The list is stored with what the next read needs beside it
    const body = (Array.isArray(stored) ? { checks: stored } : stored) as { checks?: Check[]; truncated?: boolean; headPipeline?: HeadPipeline | null };
    return {
      kind: row.kind,
      headSha: row.head_sha,
      checks: body.checks ?? [],
      truncated: body.truncated === true,
      rollup: ROLLUPS.includes(row.rollup ?? '') ? (row.rollup as WorkItemPullRequestCi) : 'none',
      headPipeline: body.headPipeline ?? null,
      fetchedAt: row.fetched_at,
    };
  } catch {
    return null;
  }
}

const answer = (s: Snapshot, limitedUntil?: string): ChangeRequestChecks => ({
  headSha: s.headSha,
  rollup: s.rollup,
  checks: s.checks,
  truncated: s.truncated,
  checkedAt: s.fetchedAt,
  ...(limitedUntil ? { limitedUntil } : {}),
});

/** What a failed call says, as the error a caller throws: its reason, and the host's first line beside it */
function failure(what: string, result: HostResult, call: HostCall): ChecksError {
  const reason = reasonOf(result, call.cli) ?? 'unreachable';
  return new ChecksError(`${what} failed`, reason, result.stderrFirstLine || null);
}

/** When Agentry may read again, from the headers the host sent; null without one */
function resetOf(result: HostResult, now: number): string | null {
  const headers = result.http?.headers ?? {};
  const after = Number(headers['retry-after']);
  if (Number.isFinite(after) && after > 0) return new Date(now + after * 1000).toISOString();
  const reset = Number(headers['x-ratelimit-reset'] ?? headers['ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return new Date((reset < 1e11 ? reset * 1000 : reset)).toISOString();
  return null;
}

const isLimited = (reason: HostReason): boolean => reason === 'rate-limited' || reason === 'slowed-down';

/** A finished check cannot be cancelled: nothing is live in the list */
const live = (checks: readonly Check[]): boolean => checks.some((c) => c.state === 'queued' || c.state === 'running');

export class ChecksService {
  private readonly now: () => number;
  /** Reads in flight, so that the board and two tabs share one */
  private readonly reading = new Map<string, Promise<ChangeRequestChecks>>();
  /** Writes to one change request, one at a time */
  private readonly writing = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ChecksServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ---------- the watcher's read ----------

  /**
   * One read of the change request: GitHub's single GraphQL query through `api -i`, GitLab's `mr view`.
   * The watcher takes the state and the rollup from it; a failed read has a reason, never a guess.
   */
  async readChangeRequest(target: ChecksTarget): Promise<ChangeRequestRead> {
    const call = target.adapter.readChangeRequest(target.repo, target.number);
    const result = await target.run(call);
    if (result.exitCode !== 0 || result.reason) throw failure('reading the change request', result, call);
    try {
      return target.adapter.parseChangeRequest(result);
    } catch (error) {
      if (error instanceof HostParseError) {
        // A GraphQL not-found answers 200 with errors[] and exits 1; the parser names it
        throw new ChecksError('the host did not return the change request', error.message.includes('NOT_FOUND') ? 'not-found' : 'unexpected-output', firstLine(error.message));
      }
      throw error;
    }
  }

  // ---------- the list ----------

  /**
   * The checks of the head commit, from the snapshot while it is under 30 s old. `refresh` reads
   * again; a read that hit the rate limit serves the last list with the time it may be read again.
   */
  async list(id: string, options: { refresh?: boolean } = {}): Promise<ChangeRequestChecks> {
    if (!options.refresh) {
      const cached = readSnapshot(this.snapshotRow(id));
      if (cached && this.now() - Date.parse(cached.fetchedAt) < SNAPSHOT_TTL) return answer(cached);
    }
    const running = this.reading.get(id);
    if (running) return running;
    const read = this.fetch(id).finally(() => this.reading.delete(id));
    this.reading.set(id, read);
    return read;
  }

  private snapshotRow(id: string): ChangeRequestSnapshotRow | undefined {
    return this.deps.db.prepare('SELECT * FROM change_request_snapshots WHERE cr_id = ?').get(id) as ChangeRequestSnapshotRow | undefined;
  }

  private async target(id: string): Promise<ChecksTarget> {
    const target = await this.deps.resolve(id);
    if (!target) throw new ChecksError('no change request with that id, or it has no number yet', 'not-found');
    return target;
  }

  private async fetch(id: string): Promise<ChangeRequestChecks> {
    const target = await this.target(id);
    const previous = readSnapshot(this.snapshotRow(id));
    try {
      const read = await this.readChangeRequest(target);
      const { checks, truncated } = await this.readChecks(target, read);
      const required = await this.readRequired(target, read.baseRef ?? target.base);
      const marked = required ? checks.map((c) => (required.has(c.name) ? { ...c, required: true } : c)) : checks;
      const next: Snapshot = {
        kind: target.kind,
        headSha: read.headSha,
        checks: marked,
        truncated: truncated || read.truncated,
        rollup: read.view.ci,
        headPipeline: read.headPipeline,
        fetchedAt: new Date(this.now()).toISOString(),
      };
      this.store(id, next);
      if (!previous || previous.rollup !== next.rollup || previous.headSha !== next.headSha) this.announce(id, next);
      return answer(next);
    } catch (error) {
      if (error instanceof ChecksError && isLimited(error.reason) && previous) {
        const until = new Date(this.now() + LIMIT_FALLBACK).toISOString();
        return answer(previous, until);
      }
      throw error;
    }
  }

  /** Round one, then each round of follow-ups until none is left, up to the list's ceiling */
  private async readChecks(target: ChecksTarget, read: ChangeRequestRead): Promise<{ checks: Check[]; truncated: boolean }> {
    const ref = { headSha: read.headSha, pipelineId: read.headPipeline?.id ?? null };
    const calls = target.adapter.checks(target.repo, ref);
    if (calls.length === 0) return { checks: [], truncated: false };
    const results = await this.runAll(target, calls, 'reading the checks');
    let round = target.adapter.parseChecks(target.repo, ref, results);
    const checks = [...round.checks];
    let truncated = round.truncated;
    // A pipeline's children are a bounded fan-out (the adapter caps it); this bound only stops a parser that never ends
    for (let depth = 0; round.next.length > 0 && depth < 4; depth += 1) {
      const follow: ChecksFollowUp[] = round.next;
      const more = await this.runAll(target, follow.map((f) => f.call), 'reading the checks');
      round = target.adapter.parseChecksMore(target.repo, follow, more);
      checks.push(...round.checks);
      truncated ||= round.truncated;
    }
    if (checks.length > MAX_CHECKS) return { checks: checks.slice(0, MAX_CHECKS), truncated: true };
    return { checks, truncated };
  }

  private async runAll(target: ChecksTarget, calls: HostCall[], what: string): Promise<HostResult[]> {
    const results: HostResult[] = [];
    for (const call of calls) {
      const result = await target.run(call);
      if (result.exitCode !== 0 || result.reason) throw failure(what, result, call);
      results.push(result);
    }
    return results;
  }

  /** The names the base branch requires; null when the host cannot say, so no check is marked */
  private async readRequired(target: ChecksTarget, base: string): Promise<Set<string> | null> {
    const calls = target.adapter.required(target.repo, base);
    if (calls.length === 0) return null;
    const results: HostResult[] = [];
    for (const call of calls) {
      const result = await target.run(call);
      // A repository the viewer cannot read the rules of is not a failure of the list
      results.push(result);
    }
    try {
      const names = target.adapter.parseRequired(results);
      return names ? new Set(names) : null;
    } catch {
      return null;
    }
  }

  private store(id: string, s: Snapshot): void {
    const body = JSON.stringify({ checks: s.checks, truncated: s.truncated, headPipeline: s.headPipeline });
    this.deps.db
      .prepare(
        `INSERT INTO change_request_snapshots (cr_id, kind, head_sha, checks, rollup, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cr_id) DO UPDATE SET kind = excluded.kind, head_sha = excluded.head_sha, checks = excluded.checks, rollup = excluded.rollup, fetched_at = excluded.fetched_at`,
      )
      .run(id, s.kind, s.headSha, body, s.rollup, s.fetchedAt);
  }

  private announce(id: string, s: Snapshot): void {
    this.deps.emit?.({ type: 'change-request.checks', title: `Checks ${s.rollup}`, changeRequestId: id, rollup: s.rollup, headSha: s.headSha });
  }

  // ---------- logs ----------

  /**
   * The cleaned tail of one check's log, with its annotations. A check without a log, or a host that
   * answers 404, is `log-unavailable`; a job that printed nothing yet is `noOutputYet`, not an error.
   */
  async log(id: string, checkId: string): Promise<CheckLog> {
    const target = await this.target(id);
    const listed = await this.list(id);
    const check = listed.checks.find((c) => c.id === checkId);
    if (!check) throw new ChecksError('that check is not in the list', 'not-found');
    const call = check.hasLog ? target.adapter.jobLog(target.repo, check, target.cliVersion) : null;
    if (!call) throw new ChecksError('that check has no log', 'log-unavailable');
    const result = await target.run(call);
    if (result.exitCode !== 0 || result.reason) {
      const error = failure('reading the log', result, call);
      if (error.reason === 'not-found') throw new ChecksError('the log is no longer available', 'log-unavailable', error.detail);
      throw error;
    }
    const read = target.adapter.parseJobLog(result);
    const tail = tailLog(read.text, { state: check.state });
    return {
      lines: tail.lines,
      truncated: tail.truncated || result.truncated,
      noOutputYet: read.noOutputYet || tail.status === 'no-output-yet',
      annotations: await this.annotations(target, check),
    };
  }

  /** A host without annotations, or one that does not answer for them, shows the log alone */
  private async annotations(target: ChecksTarget, check: Check): Promise<CheckAnnotation[]> {
    const call = target.adapter.annotations(target.repo, check);
    if (!call) return [];
    const result = await target.run(call);
    if (result.exitCode !== 0 || result.reason) return [];
    try {
      return target.adapter.parseAnnotations(result.stdout);
    } catch {
      return [];
    }
  }

  // ---------- writes ----------

  /** Writes to one change request go one after the other, so a double click never starts two */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.writing.get(id) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    // The chain only orders writes: the caller of `run` gets the failure, so the chain itself never rejects
    const tracked: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.writing.get(id) === tracked) this.writing.delete(id);
    });
    this.writing.set(id, tracked);
    return run;
  }

  /** Runs write calls in order, once each. Stops at the first that fails and returns it. */
  private async runWrites(target: ChecksTarget, calls: HostCall[]): Promise<{ result: HostResult; call: HostCall } | null> {
    for (const call of calls) {
      const result = await target.run(call);
      if (result.exitCode !== 0 || result.reason) return { result, call };
    }
    return null;
  }

  /** The list after a write: always read again, never taken from what the write printed */
  private async reread(id: string): Promise<ChangeRequestChecks> {
    const fresh = await this.list(id, { refresh: true });
    // A write changes the list even when the rollup did not move
    const row = readSnapshot(this.snapshotRow(id));
    if (row) this.announce(id, row);
    return fresh;
  }

  /** `POST …/checks/rerun`: the failed jobs, one check, or the whole run, as the person saw them */
  rerun(id: string, req: ChecksRerunRequest): Promise<ChangeRequestChecks> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      if (req.scope === 'check' && !req.checkId) throw new ChecksError('scope "check" names the check to run again', 'check-not-rerunnable');
      const snapshot = readSnapshot(this.snapshotRow(id)) ?? (await this.list(id).then(() => readSnapshot(this.snapshotRow(id))));
      if (!snapshot) throw new ChecksError('the checks could not be read', 'unexpected-output');
      let calls: HostCall[];
      try {
        calls = target.adapter.rerun(target.repo, {
          scope: req.scope,
          checks: snapshot.checks,
          ...(req.checkId ? { checkId: req.checkId } : {}),
          number: target.number,
          branch: target.branch,
          headPipeline: snapshot.headPipeline,
        });
      } catch (error) {
        if (error instanceof HostRequestError) throw new ChecksError(error.message, error.reason);
        throw error;
      }
      const failed = await this.runWrites(target, calls);
      const fresh = await this.reread(id).catch((error: unknown) => {
        if (!failed) throw error;
        return null;
      });
      if (!failed) return fresh as ChangeRequestChecks;
      // Exit 1 on a run that is still going, or on an older attempt, is the host refusing; anything else keeps its own reason
      const reason = reasonOf(failed.result, failed.call.cli) ?? 'unreachable';
      if (reason === 'unreachable' && failed.result.exitCode === 1) throw new ChecksError('the host refused to run it again', 'rerun-refused', failed.result.stderrFirstLine || null);
      throw new ChecksError('running it again failed', reason === 'timeout' ? 'write-unconfirmed' : reason, failed.result.stderrFirstLine || null);
    });
  }

  /** `POST …/checks/cancel`. A run that finished meanwhile is a success: what the re-read says decides. */
  cancel(id: string): Promise<ChangeRequestChecks> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      const snapshot = readSnapshot(this.snapshotRow(id)) ?? (await this.list(id).then(() => readSnapshot(this.snapshotRow(id))));
      if (!snapshot) throw new ChecksError('the checks could not be read', 'unexpected-output');
      const calls = target.adapter.cancel(target.repo, { checks: snapshot.checks, pipelineId: snapshot.headPipeline?.id ?? null });
      const failed = calls.length > 0 ? await this.runWrites(target, calls) : null;
      // Not waiting for `canceled`: a cancel answers running, then canceling (recorded)
      const fresh = await this.reread(id).catch((error: unknown) => {
        if (!failed) throw error;
        return null;
      });
      if (!failed) return fresh as ChangeRequestChecks;
      if (fresh && !live(fresh.checks)) return fresh;
      throw failure('cancelling', failed.result, failed.call);
    });
  }

  /** `POST …/checks/:checkId/run`: plays a GitLab manual job. It keeps its id; the re-read shows it moved on. */
  run(id: string, checkId: string): Promise<ChangeRequestChecks> {
    return this.serial(id, async () => {
      const target = await this.target(id);
      const snapshot = readSnapshot(this.snapshotRow(id)) ?? (await this.list(id).then(() => readSnapshot(this.snapshotRow(id))));
      const check = snapshot?.checks.find((c) => c.id === checkId);
      if (!check) throw new ChecksError('that check is not in the list', 'not-found');
      const call = check.state === 'manual' ? target.adapter.playManual(target.repo, check) : null;
      if (!call) throw new ChecksError('that check cannot be played', 'check-not-rerunnable');
      const failed = await this.runWrites(target, [call]);
      const fresh = await this.reread(id).catch((error: unknown) => {
        if (!failed) throw error;
        return null;
      });
      if (!failed) return fresh as ChangeRequestChecks;
      // Exit 1 on an unplayable job: the re-read decides whether someone else played it first
      if (fresh && fresh.checks.find((c) => c.id === checkId)?.state !== 'manual') return fresh;
      throw failure('playing the job', failed.result, failed.call);
    });
  }
}
