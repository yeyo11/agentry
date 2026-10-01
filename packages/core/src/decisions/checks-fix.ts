import { execFile } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CHECKS_FIX_ATTEMPTS, DEFAULT_FLOW_MAX_PARALLEL, MAX_CHECKS_FIX_ATTEMPTS, type ChangeRequestChecks, type CheckLog, type WorkItem } from '@agentry/shared';
import type { FlowProject } from '../flow.ts';
import { failingChecks, type ChecksFailingNotice, type FixChecksResult } from '../pull-requests.ts';
import type { DecisionOutcome } from './engine.ts';
import { stanceOf, type DecisionAsker } from './stance.ts';

/*
 * `checks.fix` (docs/plans/code-hosts.md, phase 2): the watcher tells this when a change request's
 * rollup turns `failing` for a head it had not announced. The point asks whether the branch caused
 * the failures in a way the Developer can fix; only an active point above its threshold that answers
 * `branch-fixable` starts a fix, and then only within the limits below. A fix a decision starts always
 * waits for a person's "Push the fix" (the fix flow owns that).
 */

/** How many failing checks the question carries */
const MAX_CHECKS = 10;
/** Each log tail is cut to its last 2 KiB: the end of a log is where the failure is */
const TAIL_BYTES = 2 * 1024;
const STAT_BYTES = 2 * 1024;

export interface ChecksFixDeps {
  decisions: DecisionAsker;
  sql: DatabaseSync;
  checks: { list(id: string): Promise<ChangeRequestChecks>; log(id: string, checkId: string): Promise<CheckLog> };
  pullRequests: { fixChecks(itemId: string, origin: 'decision'): Promise<FixChecksResult>; fixAttemptsFor(itemId: string, headSha: string | null): number };
  item(itemId: string): WorkItem | null;
  project(projectId: string): FlowProject | null;
}

/** The end of a text that fits `bytes`, cut on a line when it can */
function endOf(text: string, bytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= bytes) return text;
  const cut = buf.subarray(buf.length - bytes).toString('utf8').replace(/^�+/, '');
  const newline = cut.indexOf('\n');
  return newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut;
}

export class ChecksFix {
  /** `<change request id>@<head>` already asked in this process: the point is asked once per head */
  private readonly asked = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: ChecksFixDeps) {}

  /** What `PullRequestService`'s `onChecksFailing` is given; never throws into the watcher */
  onChecksFailing = (notice: ChecksFailingNotice): void => {
    // An orchestration's fix is always a person's click: it has no QA stage to verify a decision's
    if (notice.kind !== 'work-item') return;
    const key = `${notice.id}@${notice.headSha ?? ''}`;
    if (this.asked.has(key)) return;
    const item = this.deps.item(notice.ownerId);
    if (!item) return;
    const stance = stanceOf(this.deps.decisions, 'checks.fix', item.projectId);
    if (stance === 'off') return;
    // Without the flow a fix has no Developer to run: the person takes the prompt to a chat of their own
    if (!this.deps.project(item.projectId)?.settings.flow?.enabled) return;
    this.asked.add(key);
    const run = this.decide(notice, item, stance).catch(() => undefined);
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  };

  /** Resolves when every decision under way has finished; for tests and a clean shutdown */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private async decide(notice: ChecksFailingNotice, item: WorkItem, stance: 'watch' | 'wait'): Promise<void> {
    if (!this.hasRoom(notice, item)) return;
    const data = await this.stateOf(notice, item);
    if (!data) return;
    let outcome: DecisionOutcome;
    try {
      outcome = await this.deps.decisions.ask('checks.fix', { kind: 'work_item', id: item.id, data }, { projectId: item.projectId });
    } catch {
      return;
    }
    if (stance !== 'wait' || !outcome.act) return;
    const answer = outcome.answers?.fix;
    if (answer?.kind !== 'choice' || answer.value !== 'branch-fixable') return;
    // The answer took time: the limits are read again, and a person may have started a fix meanwhile
    if (!this.hasRoom(notice, item)) return;
    try {
      await this.deps.pullRequests.fixChecks(item.id, 'decision');
    } catch {
      // refused (a fix under way, a busy card, nothing failing any more): today's behaviour stands
    }
  }

  /** Attempts for this head below the project's limit, a place in the flow's parallel runs, and a budget not yet reached */
  private hasRoom(notice: ChecksFailingNotice, item: WorkItem): boolean {
    const flow = this.deps.project(item.projectId)?.settings.flow;
    if (!flow) return false;
    const limit = Math.min(flow.checksFixAttempts ?? DEFAULT_CHECKS_FIX_ATTEMPTS, MAX_CHECKS_FIX_ATTEMPTS);
    if (this.deps.pullRequests.fixAttemptsFor(item.id, notice.headSha) >= limit) return false;
    const live = this.deps.sql.prepare("SELECT COUNT(*) AS n FROM flow_runs WHERE project_id = ? AND state IN ('running', 'queued')").get(item.projectId) as { n: number };
    if (live.n >= (flow.maxParallel ?? DEFAULT_FLOW_MAX_PARALLEL)) return false;
    // The flow holds each run to `flow.maxCostUsd`; a card whose last run ran into it would only spend it again
    const last = this.deps.sql.prepare("SELECT cause FROM flow_runs WHERE item_id = ? AND state = 'ended' ORDER BY seq DESC LIMIT 1").get(item.id) as { cause: string | null } | undefined;
    return last?.cause !== 'budget';
  }

  private async stateOf(notice: ChecksFailingNotice, item: WorkItem): Promise<Record<string, unknown> | null> {
    let list: ChangeRequestChecks;
    try {
      list = await this.deps.checks.list(notice.id);
    } catch {
      return null;
    }
    const failing = failingChecks(list.checks).slice(0, MAX_CHECKS);
    if (!failing.length) return null;
    const checks = await Promise.all(
      failing.map(async (c) => {
        let tail = '';
        if (c.hasLog) {
          try {
            tail = endOf((await this.deps.checks.log(notice.id, c.id)).lines.join('\n'), TAIL_BYTES);
          } catch {
            // the check goes in without its log
          }
        }
        return { id: c.id, name: c.name, conclusion: c.state, tail };
      }),
    );
    return { checks, attempt: `fix attempt ${String(notice.attempts + 1)} for this head`, diffStat: await this.diffStat(notice.id, item), headSha: notice.headSha };
  }

  /** The branch's changes against its base as `git diff --stat`; empty when the worktree is gone or git fails */
  private diffStat(crId: string, item: WorkItem): Promise<string> {
    const row = this.deps.sql.prepare('SELECT base FROM work_item_pull_requests WHERE id = ?').get(crId) as { base: string } | undefined;
    if (!item.worktree || !row) return Promise.resolve('');
    const args = ['-C', item.worktree, 'diff', '--stat=100', `origin/${row.base}...HEAD`, '--'];
    return new Promise((resolve) => {
      execFile('git', args, { timeout: 15_000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? '' : endOf(stdout, STAT_BYTES)));
    });
  }
}
