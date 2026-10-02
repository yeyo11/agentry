import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AutoMergeRequestBody,
  AutoMergeOff,
  AutoMergeOffWhy,
  AutoMergeState,
  Check,
  ChangeRequestKind,
  ChangeRequestMerge,
  ChangeRequestMergeAction,
  CodeHostId,
  HostReason,
  MergeBlocker,
  MergeMethod,
  MergeRequestBody,
  MergeState,
} from '@agentry/shared';
import type { AgentryEventInput } from '../events.ts';
import { changeRequestMergeOf, type ChangeRequestMergeRow } from '../work-item-rows.ts';
import { reasonOf } from './classify.ts';
import {
  HostActionNotOffered,
  HostParseError,
  type HostCall,
  type HostRepo,
  type MergeCodeHostAdapter,
  type MergeRead,
  type MergeRules,
  type MergeSettings,
} from './code-host.ts';
import type { HostResult } from './exec.ts';
import { allowedMethods, githubBlockers, gitlabBlockers, requiredCheckProblems, type MergeBlockers, type MergeabilityCheck, type RequiredCheckProblem } from './merge-blockers.ts';
import { firstLine } from './redact.ts';

// What merging needs beyond the adapters: the state the person sees (the table of what blocks a
// merge, the GitLab pipeline guard, the wait while a host works it out), Merge, Auto-merge on and
// off, Update from base, and the audit row of every click. The adapters only build calls and parse
// what came back; this runs them (docs/plans/code-hosts.md, phase 4). Merging is the person's click:
// the routes that reach this refuse a chat token, and nothing here is started by a run.

/** GitHub: a re-read while the host is still working out whether the request can merge, and how many (GitLab's is not that wait) */
export const COMPUTING_WAIT = 5_000;
export const COMPUTING_ROUNDS = 3;
/** GitLab: how long a head that was just seen may read as `computing`; past it Merge is on and the host's refusal is the check */
export const COMPUTING_SHOWN = 15_000;
/** GitLab: how long after a push with no pipeline a project with no CI file is believed to have none */
export const NO_PIPELINE_GRACE = 90_000;
/** The repository's settings and rules change rarely: one read serves every state for this long */
const SETTINGS_TTL = 60_000;
/** What a read that hit the rate limit waits when the host did not say */
const LIMIT_FALLBACK = 60_000;
/** A merge the host took (exit 0) shows as merged a moment later: how long and how often it is looked for */
const SETTLE_WAIT = 2_000;
const SETTLE_ROUNDS = 3;
/** A host-side rebase is waited on this often, this many times */
const REBASE_WAIT = 5_000;
const REBASE_ROUNDS = 12;
/** Who the disarm that precedes Agentry's own push is recorded as */
const AGENTRY = 'agentry';
/** What the audit row of a disarm Agentry did on its own account says, which is also how the state finds it again */
const OFF_DETAIL: Record<AutoMergeOffWhy, string> = {
  push: 'turned off before Agentry pushed: arm it again afterwards',
  update: 'turned off before Agentry updated the branch: arm it again afterwards',
};

/** A pipeline in one of these states will not change on its own: Merge no longer waits for it */
const FINISHED_PIPELINE: ReadonlySet<string> = new Set(['success', 'failed', 'canceled', 'skipped', 'manual']);
/** What auto-merge can wait for on GitHub: a blocker that time or a review clears */
const WAITABLE: ReadonlySet<string> = new Set(['checks-running', 'review-required']);
/** A reason that says something about the host or the account, never about this one merge */
const INFRA: ReadonlySet<HostReason> = new Set(['auth-failed', 'forbidden', 'not-found', 'rate-limited', 'slowed-down', 'server-error']);

/** Why the service did not do what was asked: the reason a client words, and the first line the host said */
export class MergeError extends Error {
  constructor(
    message: string,
    readonly reason: HostReason,
    readonly detail: string | null = null,
    /** The blocker that refused it, when one did */
    readonly blocker: MergeBlocker | null = null,
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

/**
 * Everything a call needs about one change request, resolved by the caller from the row. The three
 * hooks reach the item's own checkout, which only the owner of the row knows.
 */
export interface MergeTarget {
  id: string;
  kind: ChangeRequestKind;
  host: CodeHostId;
  adapter: MergeCodeHostAdapter;
  repo: HostRepo;
  number: number;
  /** The source branch */
  branch: string;
  base: string;
  run: (call: HostCall) => Promise<HostResult>;
  /** Whether `path` exists at commit `sha` in the local clone; null when git cannot say (the commit is not there) */
  fileAt?: (sha: string, path: string) => Promise<boolean | null>;
  /**
   * Agentry's own update (E9): fetch the base, merge it into the branch and push. The conflicting
   * paths come back when it conflicted (nothing is pushed then); a failure throws. Absent when the
   * row has no checkout to do it in.
   */
  updateFromBase?: () => Promise<{ conflicts: string[] }>;
  /** After a host-side rebase: fetch the branch and `reset --keep` onto it in the clean checkout */
  syncAfterRebase?: () => Promise<void>;
  /** A chat or a run is working in the branch's checkout: Agentry does not rewrite the branch under it */
  busy?: () => boolean;
  /**
   * What a host-side rebase would cost the checkout: `reset --keep` drops what is not committed, and
   * commits that were never pushed are lost with the rewritten branch. Absent when there is no checkout.
   */
  checkout?: () => Promise<{ uncommitted: boolean; unpushed: boolean }>;
}

export interface MergeServiceDeps {
  db: DatabaseSync;
  /** The target of a row id from either table; null when no change request has it or it has no number */
  resolve: (id: string) => Promise<MergeTarget | null>;
  /** The head's checks, for the required ones that are pending or failed; without it GitHub's `BLOCKED` is read as a policy */
  checks?: (id: string, refresh?: boolean) => Promise<Check[]>;
  /** Unresolved review threads, when a rule asks for them to be resolved */
  unresolvedThreads?: (id: string) => Promise<number>;
  /** The host merged it: lets the owner of the row see that now, instead of at its next poll */
  merged?: (id: string) => Promise<void>;
  /** The feed: Agentry turned auto-merge off, and the person is told */
  emit?: (event: AgentryEventInput) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
}

/** What `merge` answers: the state after, and what became of the branch the box was about */
export interface MergeOutcome {
  state: MergeState;
  merged: true;
  /** After the merge, whether the source branch is gone from the host; null when the host did not say or nobody asked */
  branchDeleted: boolean | null;
}

/** What `holdForPush` answers: whether auto-merge was on and is now off, and how the push says it is over */
export interface PushHold {
  disarmed: boolean;
  release: () => void;
}

/** What `updateBranch` answers: the paths that conflicted (nothing was pushed then) and the state after */
export interface UpdateOutcome {
  state: MergeState;
  conflicts: string[];
  /** The way it was done: Agentry's own merge, or a host-side rebase */
  via: 'merge' | 'rebase';
}

interface Cached {
  settings: MergeSettings;
  rules: MergeRules | null;
  required: string[] | null;
  at: number;
}

const isLimited = (reason: HostReason): boolean => reason === 'rate-limited' || reason === 'slowed-down';
const failed = (result: HostResult): boolean => result.exitCode !== 0 || Boolean(result.reason);

/** When Agentry may read again, from the headers the host sent; null without one */
function resetOf(result: HostResult, now: number): string | null {
  const headers = result.http?.headers ?? {};
  const after = Number(headers['retry-after']);
  if (Number.isFinite(after) && after > 0) return new Date(now + after * 1000).toISOString();
  const reset = Number(headers['x-ratelimit-reset'] ?? headers['ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return new Date(reset < 1e11 ? reset * 1000 : reset).toISOString();
  return null;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A CI configuration that lives elsewhere (`file@group/project`, a URL) is not a file of this repository */
const remoteConfig = (path: string): boolean => path.includes('@') || /^https?:\/\//i.test(path);

interface Computed {
  state: MergeState;
  read: MergeRead;
  settings: MergeSettings;
}

export class MergeService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly uuid: () => string;
  private readonly cache = new Map<string, Cached>();
  private readonly lastState = new Map<string, MergeState>();
  private readonly lastRead = new Map<string, MergeRead>();
  private readonly lastSettings = new Map<string, MergeSettings>();
  /** The last time Agentry saw the branch move: a push of its own, or the first read of a head */
  private readonly pushes = new Map<string, { sha: string | null; at: number }>();
  /** Writes to one change request, one at a time */
  private readonly writing = new Set<string>();
  /** Change requests whose branch Agentry is pushing to right now, with auto-merge already off */
  private readonly pushing = new Set<string>();

  constructor(private readonly deps: MergeServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? wait;
    this.uuid = deps.uuid ?? randomUUID;
  }

  private async target(id: string): Promise<MergeTarget> {
    const target = await this.deps.resolve(id);
    if (!target) throw new MergeError('change request not found', 'not-found');
    return target;
  }

  /** The newest merge clicks and armings of a change request, newest first */
  history(id: string, limit = 50): ChangeRequestMerge[] {
    const rows = this.deps.db.prepare('SELECT * FROM change_request_merges WHERE cr_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?').all(id, limit) as unknown as ChangeRequestMergeRow[];
    return rows.map(changeRequestMergeOf);
  }

  // ---------- reads ----------

  private async run(target: MergeTarget, call: HostCall, what: string): Promise<HostResult> {
    const result = await target.run(call);
    if (failed(result)) {
      throw new MergeError(`${what} failed`, reasonOf(result, call.cli) ?? 'unreachable', result.stderrFirstLine || null);
    }
    return result;
  }

  /** The repository's settings, rules and required checks, for a minute: they change rarely and cost three calls */
  private async repository(target: MergeTarget): Promise<Cached> {
    const key = `${target.repo.host}/${target.repo.path}#${target.base}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < SETTINGS_TTL) return cached;
    const { adapter, repo } = target;
    const settingsResult = await this.run(target, adapter.defaultBranch(repo), 'reading the repository');
    let settings: MergeSettings;
    try {
      settings = adapter.parseMergeSettings(settingsResult.stdout);
    } catch (err) {
      if (err instanceof HostParseError) throw new MergeError('the repository answered in a shape Agentry does not know', 'unexpected-output', firstLine(err.message));
      throw err;
    }
    // A rule that could not be read is not a rule that does not exist: the merge is then up to the host's refusal
    let rules: MergeRules | null = null;
    const ruleCalls = adapter.rules(repo, target.base);
    if (ruleCalls.length > 0) {
      const results = await Promise.all(ruleCalls.map((call) => target.run(call)));
      rules = results.some(failed) ? null : adapter.parseRules(results);
    } else {
      rules = adapter.parseRules([]);
    }
    let required: string[] | null = null;
    const requiredCalls = adapter.required(repo, target.base);
    if (requiredCalls.length > 0) {
      const results = await Promise.all(requiredCalls.map((call) => target.run(call)));
      required = results.some(failed) ? null : adapter.parseRequired(results);
    }
    const entry: Cached = { settings, rules, required, at: this.now() };
    this.cache.set(key, entry);
    return entry;
  }

  private async readMerge(target: MergeTarget): Promise<MergeRead> {
    const call = target.adapter.readForMerge(target.repo, target.number);
    const result = await this.run(target, call, 'reading the change request');
    try {
      return target.adapter.parseMergeRead(result);
    } catch (err) {
      if (err instanceof HostParseError) throw new MergeError('the change request came back in a shape Agentry does not know', 'unexpected-output', firstLine(err.message));
      throw err;
    }
  }

  /** GitHub's `BLOCKED` and what is behind it: the required checks of the head, and the threads a rule wants resolved */
  private async githubFacts(target: MergeTarget, read: MergeRead, cached: Cached): Promise<{ required: RequiredCheckProblem[]; unresolved: number }> {
    if ((read.mergeStateStatus ?? '').toUpperCase() !== 'BLOCKED') return { required: [], unresolved: 0 };
    let required: RequiredCheckProblem[] = [];
    if (cached.required !== null && this.deps.checks) {
      try {
        required = requiredCheckProblems(await this.deps.checks(target.id), cached.required);
      } catch {
        // the checks could not be read: BLOCKED is then a policy the host's page explains
      }
    }
    let unresolved = 0;
    if (cached.rules?.threadResolution && this.deps.unresolvedThreads) {
      try {
        unresolved = await this.deps.unresolvedThreads(target.id);
      } catch {
        // the same: the person is sent to the host
      }
    }
    return { required, unresolved };
  }

  private async gitlabChecks(target: MergeTarget, read: MergeRead): Promise<MergeabilityCheck[] | null> {
    const status = (read.detailedMergeStatus ?? '').toLowerCase();
    if (read.state !== 'open' || (status !== '' && status !== 'unchecked' && status !== 'checking')) return null;
    const call = target.adapter.mergeabilityChecks(target.repo, target.number);
    if (!call) return null;
    const result = await target.run(call);
    if (failed(result)) return null;
    try {
      return target.adapter.parseMergeabilityChecks(result);
    } catch {
      return null;
    }
  }

  /** One read of everything the state is made of, with no waiting */
  private async compute(target: MergeTarget): Promise<Computed> {
    const cached = await this.repository(target);
    const { settings } = cached;
    const read = await this.readMerge(target);
    const head = read.headSha;
    const pushed = this.pushes.get(target.id);
    // The first time this head is seen stands in for the push, when Agentry did not do the push itself
    if (head && pushed?.sha === null) this.pushes.set(target.id, { sha: head, at: pushed.at });
    else if (head && pushed?.sha !== head) this.pushes.set(target.id, { sha: head, at: this.now() });

    const pipeline = read.headPipeline && head && read.headPipeline.sha === head ? read.headPipeline : null;
    let found: MergeBlockers;
    if (target.host === 'github') {
      const facts = await this.githubFacts(target, read, cached);
      found = githubBlockers({
        state: read.state,
        isDraft: read.isDraft,
        mergeable: read.mergeable,
        mergeStateStatus: read.mergeStateStatus,
        reviewDecision: read.reviewDecision,
        required: facts.required,
        unresolvedThreads: facts.unresolved,
        threadResolutionRequired: cached.rules?.threadResolution === true,
        mergeQueue: cached.rules?.mergeQueue === true,
      });
    } else {
      found = gitlabBlockers({
        state: read.state,
        detailedMergeStatus: read.detailedMergeStatus,
        checks: await this.gitlabChecks(target, read),
        settling: this.now() - (this.pushes.get(target.id)?.at ?? this.now()) < COMPUTING_SHOWN,
        hasHeadPipeline: pipeline !== null,
        fastForward: settings.fastForward,
        mergeTrains: settings.mergeTrains,
      });
    }
    const gitlab = target.host === 'gitlab';
    const guard = gitlab && read.state === 'open' ? await this.pipelineGuard(target, read, settings, pipeline, found.blockers) : { waiting: false, running: false, blockers: found.blockers };
    const blockers = guard.blockers;

    const offered = gitlab && settings.fastForward && blockers.some((b) => b.code === 'behind') && target.adapter.rebase(target.repo, target.number) !== null;
    const cost = offered ? await this.rebaseCost(target) : null;
    const methods = allowedMethods(settings, cached.rules);
    // A rebase on the host that would drop what is only in the checkout is not offered: the way out of `behind` is then
    // Agentry's own update, which keeps it, and the notice says why
    const shown = cost === null ? blockers : blockers.map((b) => (b.code === 'behind' && b.action === 'rebase-on-host' ? { ...b, action: 'update-from-base' as const } : b));
    const [first, ...others] = shown;
    const canMerge = read.state === 'open' && blockers.length === 0 && !guard.waiting && !guard.running && methods.length > 0;
    const state: MergeState = {
      changeRequestId: target.id,
      host: target.host,
      headSha: head,
      methods,
      defaultMethod: methods[0] ?? null,
      deleteBranchDefault: settings.deleteBranchDefault,
      canMerge,
      blocker: first ?? null,
      others,
      warning: found.warning,
      autoMerge: this.autoMerge(read, settings, blockers, gitlab, pipeline !== null && !FINISHED_PIPELINE.has(pipeline.status), guard.waiting),
      waitingForPipeline: guard.waiting,
      autoMergeOff: read.autoMerge.armed ? null : this.autoMergeOff(target.id),
      canRebaseOnHost: offered && cost === null,
      rebaseOnHostWhy: cost,
      readAt: new Date(this.now()).toISOString(),
    };
    this.lastRead.set(target.id, read);
    this.lastSettings.set(target.id, settings);
    return { state, read, settings };
  }

  /**
   * The race recorded on GitLab: a merge a few seconds after a push merged before the pipeline
   * attached. Merge now waits for the head's own pipeline to finish, or for the proof that the
   * project has none: no CI file at the head, no pipeline for it 90 s after the last push seen,
   * and no rule that asks for a pipeline (with one required, no pipeline is `ci_must_pass`, recorded).
   */
  private async pipelineGuard(
    target: MergeTarget,
    read: MergeRead,
    settings: MergeSettings,
    pipeline: MergeRead['headPipeline'],
    blockers: MergeBlocker[],
  ): Promise<{ waiting: boolean; running: boolean; blockers: MergeBlocker[] }> {
    if (pipeline) {
      if (FINISHED_PIPELINE.has(pipeline.status)) return { waiting: false, running: false, blockers };
      // Running: nothing has refused it yet, but merging now is what the guard is there to stop
      const running = blockers.some((b) => b.code === 'checks-running') ? blockers : [...blockers, { code: 'checks-running' as const, detail: null, action: 'auto-merge' as const }];
      return { waiting: false, running: true, blockers: running };
    }
    // The host says what it needs: not a guard's to second-guess
    if (blockers.some((b) => b.code === 'not-open' || b.code === 'checks-missing')) return { waiting: false, running: false, blockers };
    const head = read.headSha;
    const path = settings.ciConfigPath ?? '.gitlab-ci.yml';
    const hasConfig = head && target.fileAt && !remoteConfig(path) ? await target.fileAt(head, path) : true;
    if (hasConfig === false) {
      if (settings.requiresPipeline) return { waiting: false, running: false, blockers: [...blockers, { code: 'checks-missing', detail: null, action: 'rerun-checks' }] };
      const since = this.pushes.get(target.id)?.at ?? this.now();
      if (this.now() - since >= NO_PIPELINE_GRACE) return { waiting: false, running: false, blockers };
    }
    // A pipeline is coming (or Agentry cannot tell): wait for it, never merge ahead of it
    return { waiting: true, running: false, blockers };
  }

  /** Why Rebase on GitLab is not offered although it would apply: it would cost the checkout work that is not on the host */
  private async rebaseCost(target: MergeTarget): Promise<MergeState['rebaseOnHostWhy']> {
    if (!target.checkout) return null;
    try {
      const { uncommitted, unpushed } = await target.checkout();
      return uncommitted ? 'uncommitted-changes' : unpushed ? 'unpushed-commits' : null;
    } catch {
      // The checkout cannot be read: the rebase would reset it blind
      return 'unpushed-commits';
    }
  }

  /** The newest arming or disarm on record is a disarm Agentry did for a push or an update: that is still what happened to it */
  private autoMergeOff(id: string): AutoMergeOff | null {
    const row = this.deps.db
      .prepare("SELECT action, requested_at, requested_by, detail FROM change_request_merges WHERE cr_id = ? AND action IN ('arm', 'disarm') AND outcome IN ('armed', 'disarmed') ORDER BY requested_at DESC, rowid DESC LIMIT 1")
      .get(id) as { action: string; requested_at: string; requested_by: string; detail: string | null } | undefined;
    if (row?.action !== 'disarm') return null;
    const why = (Object.keys(OFF_DETAIL) as AutoMergeOffWhy[]).find((key) => OFF_DETAIL[key] === row.detail);
    return why ? { by: row.requested_by, at: row.requested_at, why, pushing: this.pushing.has(id) } : null;
  }

  private autoMerge(read: MergeRead, settings: MergeSettings, blockers: MergeBlocker[], gitlab: boolean, pipelineRunning: boolean, waiting: boolean): AutoMergeState {
    const armed = read.autoMerge.armed && read.state === 'open';
    const base = { armed, method: armed ? read.autoMerge.method : null, armedBy: armed ? read.autoMerge.by : null, armedAt: armed ? read.autoMerge.at : null };
    if (armed) return { available: false, reason: null, ...base };
    if (!settings.autoMergeAllowed) return { available: false, reason: 'auto-merge-not-allowed', ...base };
    if (read.state !== 'open') return { available: false, reason: 'auto-merge-not-needed', ...base };
    if (gitlab) {
      if (pipelineRunning) return { available: true, reason: null, ...base };
      return { available: false, reason: waiting ? 'waiting-for-pipeline' : 'auto-merge-not-needed', ...base };
    }
    if (blockers.length === 0) return { available: false, reason: 'auto-merge-not-needed', ...base };
    // Another blocker (a conflict, a failed check, a draft) is not one that waiting clears: it explains itself
    return { available: blockers.every((b) => WAITABLE.has(b.code)), reason: null, ...base };
  }

  /**
   * What the person may do about merging. While GitHub is still working it out (`computing`) it is
   * read again after 5 s, up to three times; GitLab's `unchecked` is not that wait (it lasts minutes,
   * recorded), so it is read from the checks GraphQL names and not waited on.
   */
  async state(id: string, options: { refresh?: boolean; rules?: boolean } = {}): Promise<MergeState> {
    return (await this.settledCompute(await this.target(id), options)).state;
  }

  private async settledCompute(target: MergeTarget, options: { refresh?: boolean; rules?: boolean } = {}): Promise<Computed> {
    const id = target.id;
    // A refresh the person asked for reads the repository's settings and rules again too, not only the request
    if (options.rules) {
      this.cache.delete(`${target.repo.host}/${target.repo.path}#${target.base}`);
      // and the checks it is about: the snapshot the state is computed from is read again, not the last one kept
      await this.deps.checks?.(id, true).catch(() => undefined);
    }
    try {
      let computed = await this.compute(target);
      // GitHub's `UNKNOWN` settles in seconds; GitLab's wait is minutes and is never slept through
      for (let round = 0; target.host === 'github' && round < COMPUTING_ROUNDS && computed.state.blocker?.code === 'computing'; round += 1) {
        await this.sleep(COMPUTING_WAIT);
        computed = await this.compute(target);
      }
      this.lastState.set(id, computed.state);
      return computed;
    } catch (err) {
      const last = this.lastState.get(id);
      if (err instanceof MergeError && isLimited(err.reason) && last && this.lastRead.has(id) && options.refresh !== true) {
        return { state: { ...last, limitedUntil: new Date(this.now() + LIMIT_FALLBACK).toISOString() }, read: this.lastRead.get(id) as MergeRead, settings: this.lastSettings.get(id) as MergeSettings };
      }
      throw err;
    }
  }

  // ---------- the audit ----------

  private record(id: string, action: ChangeRequestMergeAction, method: MergeMethod | null, head: string | null, deleteBranch: boolean, by: string): string {
    const rowId = this.uuid();
    this.deps.db
      .prepare(
        `INSERT INTO change_request_merges (id, cr_id, action, method, expected_head, delete_branch, requested_at, requested_by, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested')`,
      )
      .run(rowId, id, action, method, head, deleteBranch ? 1 : 0, new Date(this.now()).toISOString(), by);
    return rowId;
  }

  private settle(rowId: string, outcome: 'merged' | 'armed' | 'disarmed' | 'failed', reason: HostReason | null = null, detail: string | null = null): void {
    this.deps.db.prepare('UPDATE change_request_merges SET outcome = ?, reason = ?, detail = ? WHERE id = ?').run(outcome, reason, detail ? firstLine(detail) : null, rowId);
  }

  /** One write to a change request at a time: the second is `busy`, never queued behind a click that may merge */
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.writing.has(id)) throw new MergeError('another merge action on this change request is running', 'busy');
    this.writing.add(id);
    try {
      return await work();
    } finally {
      this.writing.delete(id);
    }
  }

  private async tryRead(target: MergeTarget): Promise<MergeRead | null> {
    try {
      return await this.readMerge(target);
    } catch {
      return null;
    }
  }

  // ---------- merge ----------

  /** Why a refused merge was refused, from the state the host has now */
  private blockedReason(state: MergeState): MergeError {
    if (state.waitingForPipeline) return new MergeError('the host has not started the pipeline for the latest commit yet', 'waiting-for-pipeline');
    if (state.blocker) return new MergeError('the change request cannot be merged yet', 'merge-failed', state.blocker.code, state.blocker);
    return new MergeError('the change request cannot be merged yet', 'merge-failed', state.methods.length === 0 ? 'no merge method is allowed' : null);
  }

  /**
   * Merges with the method the person chose, guarded by the head they looked at. The merge is the
   * person's click: `by` is who, and the row is written before the host is called. Every refusal is a
   * `MergeError` with the reason, and the row says the same.
   */
  async merge(id: string, body: MergeRequestBody, by: string): Promise<MergeOutcome> {
    const target = await this.target(id);
    return this.exclusive(id, async () => {
      const row = this.record(id, 'merge', body.method, body.expectedHead, body.deleteBranch, by);
      try {
        const outcome = await this.mergeNow(target, body, row);
        this.settle(row, 'merged');
        return outcome;
      } catch (err) {
        if (err instanceof MergeError) {
          this.settle(row, 'failed', err.reason, err.detail);
          throw err;
        }
        if (err instanceof HostParseError) {
          const wrong = new MergeError('the request is not one Agentry can send', 'merge-failed', firstLine(err.message));
          this.settle(row, 'failed', wrong.reason, wrong.detail);
          throw wrong;
        }
        this.settle(row, 'failed', 'merge-failed', err instanceof Error ? err.message : String(err));
        throw err;
      }
    });
  }

  private async mergeNow(target: MergeTarget, body: MergeRequestBody, row: string): Promise<MergeOutcome> {
    const computed = await this.settledCompute(target, { refresh: true });
    const state = computed.state;
    if (state.headSha !== body.expectedHead) throw new MergeError('new commits reached the branch after you looked', 'head-moved', state.headSha);
    if (!state.methods.includes(body.method)) throw new MergeError(`this repository does not allow ${body.method} merges`, 'method-not-allowed', body.method);
    // GitLab only runs its conflict check when a merge is attempted (recorded, m0 §8): a head it is still
    // "working out" is tried, and its refusal is explained by the re-read
    const trying = target.host === 'gitlab' && state.blocker?.code === 'computing' && state.others.length === 0 && !state.waitingForPipeline;
    if (!state.canMerge && !trying) throw this.blockedReason(state);

    const call = target.adapter.merge(target.repo, {
      number: target.number,
      method: body.method,
      expectedHead: body.expectedHead,
      deleteBranch: body.deleteBranch,
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
    });
    const result = await target.run(call);
    let after = await this.tryRead(target);
    // The host took it (exit 0) and shows it merged a moment later
    for (let round = 0; !failed(result) && after?.state === 'open' && round < SETTLE_ROUNDS; round += 1) {
      await this.sleep(SETTLE_WAIT);
      after = await this.tryRead(target);
    }
    if (after?.state !== 'merged') throw await this.refusal(target, call, body, result, after);

    await this.afterMerge(target.id);
    let branchDeleted: boolean | null = null;
    if (body.deleteBranch) branchDeleted = await this.branchGone(target);
    this.cache.delete(`${target.repo.host}/${target.repo.path}#${target.base}`);
    const final = await this.state(target.id, { refresh: true }).catch(() => ({ ...state, canMerge: false, blocker: { code: 'not-open' as const, detail: 'merged', action: null } }));
    return { state: final, merged: true, branchDeleted };
  }

  /** The reason a merge that did not land failed, in the order the evidence is trusted */
  private async refusal(target: MergeTarget, call: HostCall, body: MergeRequestBody, result: HostResult, after: MergeRead | null): Promise<MergeError> {
    // glab's refusal is a box whose first line is `ERROR`: the adapter says what it was
    const detail = target.adapter.mergeDetail?.('merge', result) ?? (result.stderrFirstLine || null);
    const own = target.adapter.mergeReason('merge', result);
    if (own === 'head-moved') return new MergeError('new commits reached the branch after you looked', 'head-moved', detail);
    // A refusal the adapter could not read: a head that is not the one seen is the proof
    if (after?.headSha && after.headSha !== body.expectedHead) return new MergeError('new commits reached the branch after you looked', 'head-moved', after.headSha);
    if (!failed(result)) return new MergeError('the host did not confirm the merge', 'write-unconfirmed', detail);
    const reason = reasonOf(result, call.cli);
    if (reason === 'timeout') return new MergeError('the host did not answer in time and the merge was not found', 'write-unconfirmed', detail);
    if (reason && INFRA.has(reason)) return new MergeError('the host refused the call', reason, detail);
    if (after) {
      try {
        const recomputed = await this.compute(target);
        if (!recomputed.state.canMerge && recomputed.state.blocker?.code !== 'computing') return this.blockedReason(recomputed.state);
      } catch {
        // the re-read is the best explanation there is; without it the host's line stands
      }
    }
    return new MergeError('the host did not merge the change request', after === null && reason ? reason : 'merge-failed', detail);
  }

  private async afterMerge(id: string): Promise<void> {
    try {
      await this.deps.merged?.(id);
    } catch {
      // the owner's watcher sees it at its next poll
    }
  }

  private async branchGone(target: MergeTarget): Promise<boolean | null> {
    try {
      const result = await target.run(target.adapter.branchExists(target.repo, target.branch));
      const exists = target.adapter.parseBranchExists(result);
      return exists === null ? null : !exists;
    } catch {
      return null;
    }
  }

  // ---------- auto-merge ----------

  /** Arms auto-merge: the host merges when what is left to wait for is done. Never `gh pr merge --auto`. */
  async arm(id: string, body: AutoMergeRequestBody, by: string): Promise<MergeState> {
    const target = await this.target(id);
    return this.exclusive(id, async () => {
      // The row is written once there is something to record: arming what is already armed changes nothing
      let row: string | null = null;
      try {
        const computed = await this.settledCompute(target, { refresh: true });
        const state = computed.state;
        if (state.headSha !== body.expectedHead) throw new MergeError('new commits reached the branch after you looked', 'head-moved', state.headSha);
        if (!state.methods.includes(body.method)) throw new MergeError(`this repository does not allow ${body.method} merges`, 'method-not-allowed', body.method);
        if (state.autoMerge.armed) return state;
        if (!state.autoMerge.available) {
          throw new MergeError('auto-merge cannot be turned on now', state.autoMerge.reason ?? 'auto-merge-not-needed', state.blocker?.code ?? null, state.blocker);
        }
        row = this.record(id, 'arm', body.method, body.expectedHead, false, by);
        const call = target.adapter.arm(target.repo, { number: target.number, method: body.method, expectedHead: body.expectedHead, nodeId: computed.read.nodeId });
        const result = await target.run(call);
        const after = await this.tryRead(target);
        if (!after?.autoMerge.armed) {
          const own = target.adapter.mergeReason('arm', result);
          const moved = after?.headSha && after.headSha !== body.expectedHead;
          const reason = own ?? (moved ? 'head-moved' : (reasonOf(result, call.cli) ?? 'write-unconfirmed'));
          throw new MergeError('the host did not turn auto-merge on', reason === 'unreachable' ? 'write-unconfirmed' : reason, result.stderrFirstLine || null);
        }
        this.settle(row, 'armed');
        return await this.state(id, { refresh: true });
      } catch (err) {
        const error = err instanceof HostParseError ? new MergeError('the request is not one Agentry can send', 'merge-failed', firstLine(err.message)) : err;
        if (error instanceof MergeError) this.settle(row ?? this.record(id, 'arm', body.method, body.expectedHead, false, by), 'failed', error.reason, error.detail);
        throw error;
      }
    });
  }

  /** Turns auto-merge off. Exit 0 also when none was armed, so the answer is the re-read's. */
  async disarm(id: string, by: string): Promise<MergeState> {
    const target = await this.target(id);
    return this.exclusive(id, async () => {
      await this.disarmNow(target, by, null);
      return this.state(id, { refresh: true });
    });
  }

  /** Disarms when armed; the row is written either way a call is made. Throws when the host still shows it armed. */
  private async disarmNow(target: MergeTarget, by: string, why: AutoMergeOffWhy | null): Promise<boolean> {
    const read = await this.readMerge(target);
    if (!read.autoMerge.armed) return false;
    const row = this.record(target.id, 'disarm', null, read.headSha, false, by);
    const call = target.adapter.disarm(target.repo, target.number);
    const result = await target.run(call);
    const clean = !failed(result) && target.adapter.parseDisarm(result);
    // The host's own words about it are not trusted: a failure can come back as a success (recorded on GitLab)
    const after = await this.tryRead(target);
    if (after && !after.autoMerge.armed) {
      this.settle(row, 'disarmed', null, why ? OFF_DETAIL[why] : null);
      if (why) this.deps.emit?.({ type: 'change-request.auto-merge-off', title: 'Auto-merge turned off', changeRequestId: target.id, why });
      return true;
    }
    const error = new MergeError('the host did not turn auto-merge off', clean ? 'write-unconfirmed' : (reasonOf(result, call.cli) ?? 'write-unconfirmed'), result.stderrFirstLine || null);
    this.settle(row, 'failed', error.reason, error.detail);
    throw error;
  }

  /**
   * Called before Agentry pushes to a change request's branch (a fix, an address, the push that opens
   * one): an armed auto-merge would merge what the push brings before anyone looked at it. It is turned
   * off and confirmed, the person is told (an event, and `autoMergeOff` in the state), and the push goes
   * on; the person arms it again. The change request stays held until `release()` (call it when the push
   * ends, whatever came of it): arming in between would be merged by the host the moment the push landed.
   * Fails closed: when it cannot be confirmed that nothing is armed, the push does not happen. A change
   * request the service cannot resolve (no number yet, the project gone) has nothing armed.
   */
  async holdForPush(id: string): Promise<PushHold> {
    const target = await this.deps.resolve(id);
    if (!target) return { disarmed: false, release: () => undefined };
    if (this.writing.has(id)) throw new MergeError('another merge action on this change request is running', 'busy');
    this.writing.add(id);
    this.pushing.add(id);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.pushing.delete(id);
      this.writing.delete(id);
    };
    try {
      const disarmed = await this.disarmNow(target, AGENTRY, 'push');
      // The head is about to move: a pipeline that appears after it is the one the guard waits for
      this.pushes.set(id, { sha: null, at: this.now() });
      this.lastState.delete(id);
      return { disarmed, release };
    } catch (err) {
      release();
      throw err;
    }
  }

  // ---------- update from the base ----------

  /**
   * Brings the base into the branch (E9). On GitLab `ff` projects that is the host's rebase, then the
   * checkout follows; everywhere else (and when the host's rebase conflicts) it is Agentry's own merge
   * in the item's checkout, pushed after auto-merge is off. Nothing is done while a chat or a run works
   * in that checkout. A merge that conflicts pushes nothing and names the paths. `by` is the person who
   * clicked: the disarm that comes first is theirs, done for the update.
   */
  async updateBranch(id: string, by: string): Promise<UpdateOutcome> {
    const target = await this.target(id);
    return this.exclusive(id, async () => {
      if (target.busy?.()) throw new MergeError('a chat or a run is working in this branch: wait for it to end', 'busy');
      const state = await this.state(id, { refresh: true });
      if (state.blocker?.code === 'not-open') throw new MergeError('the change request is not open', 'merge-failed', state.blocker.code, state.blocker);
      const rebase = state.canRebaseOnHost ? target.adapter.rebase(target.repo, target.number) : null;
      if (rebase) {
        await this.disarmNow(target, by, 'update');
        try {
          await this.rebaseOnHost(target, rebase);
          await target.syncAfterRebase?.();
          this.pushes.set(id, { sha: null, at: this.now() });
          return { state: await this.state(id, { refresh: true }), conflicts: [], via: 'rebase' };
        } catch (err) {
          // A conflict is the host's refusal about the content: Agentry's own update names the paths
          if (!(err instanceof MergeError && err.reason === 'merge-failed' && target.updateFromBase)) throw err;
        }
      }
      if (!target.updateFromBase) throw new HostActionNotOffered('this change request has no checkout to update the branch in');
      await this.disarmNow(target, by, 'update');
      let conflicts: string[];
      try {
        ({ conflicts } = await target.updateFromBase());
      } catch (err) {
        throw new MergeError('the branch could not be updated', 'merge-failed', firstLine(err instanceof Error ? err.message : String(err)));
      }
      if (conflicts.length === 0) this.pushes.set(id, { sha: null, at: this.now() });
      return { state: await this.state(id, { refresh: true }), conflicts, via: 'merge' };
    });
  }

  private async rebaseOnHost(target: MergeTarget, call: HostCall): Promise<void> {
    const result = await target.run(call);
    if (failed(result)) {
      const status = await this.rebaseStatus(target);
      throw new MergeError('the host did not rebase the branch', status?.error ? 'merge-failed' : (reasonOf(result, call.cli) ?? 'merge-failed'), status?.error ?? (result.stderrFirstLine || null));
    }
    // glab waits for it, so this is one look; a host that answered early is waited for
    for (let round = 0; round < REBASE_ROUNDS; round += 1) {
      const status = await this.rebaseStatus(target);
      if (!status) return;
      if (status.error) throw new MergeError('the host did not rebase the branch', 'merge-failed', status.error);
      if (!status.inProgress) return;
      await this.sleep(REBASE_WAIT);
    }
    throw new MergeError('the host is still rebasing the branch', 'write-unconfirmed');
  }

  private async rebaseStatus(target: MergeTarget): Promise<{ inProgress: boolean; error: string | null } | null> {
    const call = target.adapter.rebaseStatus(target.repo, target.number);
    if (!call) return null;
    try {
      const result = await target.run(call);
      return failed(result) ? null : target.adapter.parseRebaseStatus(result);
    } catch {
      return null;
    }
  }

  // ---------- ready ----------

  /** Marks the change request ready for review, or back to a draft (B9), and answers the state after */
  async markReady(id: string, ready: boolean): Promise<MergeState> {
    const target = await this.target(id);
    return this.exclusive(id, async () => {
      const call = target.adapter.ready(target.repo, target.number, ready);
      const result = await target.run(call);
      const after = await this.tryRead(target);
      if (after?.isDraft !== !ready) {
        throw new MergeError(`the host did not mark the change request ${ready ? 'ready' : 'as a draft'}`, reasonOf(result, call.cli) ?? 'write-unconfirmed', result.stderrFirstLine || null);
      }
      return this.state(id, { refresh: true });
    });
  }
}
