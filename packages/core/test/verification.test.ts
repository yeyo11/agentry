import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Orchestration, VerificationSpec } from '@agentry/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { fixerPrompt, normalizeVerification, runCommand, tail, workerChecks } from '../src/verification.ts';
import { tempConfig } from './helpers.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agentry-verify-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A process that is gone but not yet reaped is not running anything
  try {
    return !/^Z/.test(readFileSync(`/proc/${String(pid)}/stat`, 'utf8').split(') ')[1] ?? '');
  } catch {
    return false;
  }
};

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settle(orchestrator: Orchestrator, id: string): Promise<Orchestration> {
  for (let i = 0; i < 400; i++) {
    const orch = orchestrator.get(id);
    if (orch && orch.status !== 'running') return orch;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the orchestration never finished');
}

/** A graph of one worktree task whose branch is integrated, checked with `verification`. */
function launch(orchestrator: Orchestrator, repo: string, verification?: VerificationSpec, extra: { synthesize?: boolean } = {}): Orchestration {
  return orchestrator.create({
    name: 'checked',
    objective: 'ship it',
    cwd: repo,
    worktree: true,
    ...extra,
    ...(verification ? { verification } : {}),
    tasks: [{ id: 'api', name: 'API', prompt: 'FAKE-WRITE api.txt server' }],
  });
}

function fixture() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  return { config, db, repo, orchestrator };
}

// ---------- the spec ----------

test('a verification spec gets its defaults, and what could not run is refused instead of dropped', () => {
  assert.deepEqual(normalizeVerification({ commands: [' pnpm build ', 'pnpm e2e'], fixer: true, maxAttempts: 3 }), {
    commands: ['pnpm build', 'pnpm e2e'],
    fixer: true,
    maxAttempts: 3,
    timeoutMinutes: 20,
  });
  assert.equal(normalizeVerification(undefined), null);
  assert.equal(normalizeVerification(null), null);
  const spec = (over: Partial<VerificationSpec>): VerificationSpec => ({ commands: ['true'], fixer: false, maxAttempts: 2, ...over });
  assert.throws(() => normalizeVerification(spec({ commands: [] })), /at least one command/);
  assert.throws(() => normalizeVerification(spec({ commands: ['ok', '  '] })), /empty command/);
  assert.throws(() => normalizeVerification(spec({ maxAttempts: 0 })), /maxAttempts/);
  assert.throws(() => normalizeVerification(spec({ maxAttempts: 1.5 })), /maxAttempts/);
  assert.throws(() => normalizeVerification(spec({ timeoutMinutes: 0 })), /timeoutMinutes/);
  assert.throws(() => normalizeVerification(spec({ timeoutMinutes: Number.NaN })), /timeoutMinutes/);
  assert.equal(normalizeVerification(spec({ model: '  ' }))?.model, undefined);
});

test('the fixer is told Agentry’s rules, the failure and what its earlier attempts said', () => {
  const prompt = fixerPrompt({
    objective: 'add notifications',
    branch: 'agentry/x',
    worktree: '/tmp/wt',
    command: 'pnpm e2e',
    commands: ['pnpm build', 'pnpm e2e'],
    failure: 'It timed out after 20 min and was killed.',
    output: 'spec a failed',
    attempt: 2,
    maxAttempts: 3,
    earlier: ['I changed the port'],
    tasks: [{ id: 'ui', name: 'UI', result: 'moved the bell' }],
    timeoutMinutes: 20,
  });
  for (const rule of [/under `timeout`/, /one spec or test file at a time/, /by PID/, /Never loosen, delete or skip/, /changed on purpose/, /attempt 2 of 3/]) {
    assert.match(prompt, rule);
  }
  assert.match(prompt, /spec a failed/);
  assert.match(prompt, /Attempt 1: I changed the port/);
  assert.match(prompt, /<task id="ui" name="UI">/);
});

test('workers are told the split of checks, whether or not a verification phase exists', () => {
  const withPhase = workerChecks(true);
  assert.match(withPhase, /type check and the unit tests/);
  assert.match(withPhase, /Do not run the end-to-end or browser suite/);
  assert.match(withPhase, /verification phase/);
  assert.match(withPhase, /under `timeout`/);
  const without = workerChecks(false);
  assert.match(without, /Do not run the end-to-end or browser suite/);
  assert.doesNotMatch(without, /verification phase/);
});

test('output is cut to its end, at a line, without colour codes', () => {
  assert.equal(tail('\u001b[31mred\u001b[0m', 100), 'red');
  const long = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`).join('\n');
  const cut = tail(long, 60);
  assert.ok(cut.startsWith('…\n'));
  assert.ok(cut.endsWith('line 99'));
  assert.ok(!cut.includes('line 0\n'));
});

// ---------- running a command ----------

test('a command that passes or fails reports its exit code and the end of its output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-cmd-'));
  const passed = await runCommand('echo fine', dir, 10_000);
  assert.equal(passed.ok, true);
  assert.equal(passed.output, 'fine');
  const failed = await runCommand('echo before; echo why >&2; exit 3', dir, 10_000);
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.timedOut, false);
  assert.match(failed.output, /before/);
  assert.match(failed.output, /why/);
});

test('a command past its time limit is killed with everything it started, and counts as failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-cmd-'));
  const pids = join(dir, 'pids');
  // A shell, its child, and a grandchild that would keep running on its own if only the shell were killed
  const outcome = await runCommand(`sh -c 'sleep 60 & echo $! >> ${pids}; wait' & echo $! >> ${pids}; wait`, dir, 700);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.timedOut, true);
  const started = readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.equal(started.length, 2);
  await until(() => started.every((pid) => !alive(pid)), 'the command’s processes to be gone');
});

test('a running command can be cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-cmd-'));
  let cancel: () => void = () => undefined;
  const pending = runCommand('sleep 60', dir, 60_000, (handle) => {
    cancel = () => handle.cancel();
  });
  setTimeout(() => cancel(), 200);
  const outcome = await pending;
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.ok, false);
});

// ---------- the phase ----------

test('checks that pass are recorded as passed, on the branch head, before the graph is over', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = launch(orchestrator, repo, { commands: ['test -f api.txt', 'true'], fixer: true, maxAttempts: 2 }, { synthesize: true });
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.status, 'completed');
  const v = orch.verification;
  assert.equal(v?.status, 'passed', v?.report ?? '');
  assert.deepEqual(v?.commands.map((c) => c.status), ['passed', 'passed']);
  assert.equal(v?.attempts, 0);
  assert.deepEqual(v?.commits, []);
  assert.equal(v?.commit, orch.integration?.commit);
  assert.match(v?.report ?? '', /All 2 checks passed/);
  // `test -f api.txt` passing shows it ran in the integration worktree, where the task is merged
  assert.equal(orch.verificationSpec?.timeoutMinutes, 20);
  db.close();
});

test('a failing check with no fixer is a failed outcome with the report, and the checks after it do not run', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = launch(orchestrator, repo, { commands: ['echo the build broke; exit 2', 'echo never'], fixer: false, maxAttempts: 2 });
  const orch = await settle(orchestrator, started.id);

  const v = orch.verification;
  assert.equal(v?.status, 'failed');
  assert.deepEqual(v?.commands.map((c) => c.status), ['failed', 'pending']);
  assert.match(v?.commands[0]?.output ?? '', /the build broke/);
  assert.match(v?.report ?? '', /exited with code 2/);
  assert.match(v?.report ?? '', /fixer is off/);
  assert.match(v?.report ?? '', /Not run: `echo never`/);
  // The graph's own status is about its tasks; the outcome of the checks is its own field
  assert.equal(orch.status, 'completed');
  assert.equal(v?.attempts, 0);
  db.close();
});

test('a fixer mends a failing check, its commit lands on the branch and the outcome is fixed', async () => {
  const { db, repo, orchestrator } = fixture();
  // Prints the line the stand-in for the CLI reads as an instruction; the fixer prompt carries the output
  const command = "echo 'FAKE-WRITE marker.txt repaired'; test -f marker.txt";
  const started = launch(orchestrator, repo, { commands: ['true', command], fixer: true, maxAttempts: 2 });
  const orch = await settle(orchestrator, started.id);

  const v = orch.verification;
  assert.equal(v?.status, 'fixed', v?.report ?? '');
  assert.equal(v?.attempts, 1);
  assert.deepEqual(v?.commands.map((c) => c.status), ['passed', 'fixed']);
  assert.equal(v?.commits.length, 1);
  assert.match(v?.commits[0]?.subject ?? '', /verification fixer/);
  assert.match(v?.report ?? '', /fixed in 1 attempt/);
  const branch = orch.integration?.branch ?? '';
  assert.equal(execFileSync('git', ['-C', repo, 'show', `${branch}:marker.txt`], { encoding: 'utf8' }).trim(), 'repaired');
  assert.equal(orch.integration?.commit, v?.commit);
  assert.equal(v?.commit, execFileSync('git', ['-C', repo, 'rev-parse', branch], { encoding: 'utf8' }).trim());
  // The fixer is an agent of the graph: its cost is in the graph's
  assert.ok(orch.costUsd > 0.01);
  db.close();
});

test('a fixer that cannot mend a check stops after its attempts and reports what is left', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = launch(orchestrator, repo, { commands: ['echo still broken; exit 1'], fixer: true, maxAttempts: 2 });
  const orch = await settle(orchestrator, started.id);

  const v = orch.verification;
  assert.equal(v?.status, 'failed');
  assert.equal(v?.attempts, 2);
  assert.match(v?.report ?? '', /after 2 fixer attempts/);
  assert.match(v?.commands[0]?.output ?? '', /still broken/);
  assert.equal(v?.commands[0]?.status, 'failed');
  db.close();
});

test('a command that hangs is killed at its limit and fails with the reason', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = launch(orchestrator, repo, { commands: ['sleep 60'], fixer: false, maxAttempts: 1, timeoutMinutes: 0.01 });
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.verification?.status, 'failed');
  assert.match(orch.verification?.report ?? '', /timed out after 0\.01 min and was killed/);
  db.close();
});

test('a graph that did not merge is not checked, and says why', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = orchestrator.create({
    name: 'nothing',
    cwd: repo,
    worktree: true,
    verification: { commands: ['true'], fixer: false, maxAttempts: 1 },
    tasks: [{ id: 'bad', name: 'Bad', prompt: 'FAKE-FAIL nope' }],
    maxAttempts: 1,
  });
  // A failed task leaves the graph waiting for a person; giving it up lets the graph finish with nothing to merge
  await until(() => orchestrator.get(started.id)?.status === 'waiting', 'the graph to wait for a decision');
  orchestrator.skipTask(started.id, 'bad');
  const orch = await settle(orchestrator, started.id);
  assert.equal(orch.status, 'failed');
  assert.equal(orch.verification?.status, 'failed');
  assert.match(orch.verification?.report ?? '', /Not run: no task left work to merge/);
  assert.deepEqual(orch.verification?.commands.map((c) => c.status), ['pending']);
  db.close();
});

test('stopping the orchestration stops its checks and what they started', async () => {
  const { db, repo, orchestrator } = fixture();
  const pidFile = join(mkdtempSync(join(tmpdir(), 'agentry-pid-')), 'pid');
  const started = launch(orchestrator, repo, { commands: [`sleep 120 & echo $! > ${pidFile}; wait`], fixer: true, maxAttempts: 2 });
  await until(() => existsSync(pidFile) && (orchestrator.get(started.id)?.verification?.status === 'running'), 'the check to be running');
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(pid));

  orchestrator.stop(started.id);
  await until(() => orchestrator.get(started.id)?.verification?.status === 'failed', 'the checks to end');
  const v = orchestrator.get(started.id)?.verification;
  assert.match(v?.report ?? '', /Stopped/);
  assert.equal(v?.attempts, 0, 'a stopped check does not go to the fixer');
  await until(() => !alive(pid), 'the command’s process to be gone');
  assert.equal(orchestrator.get(started.id)?.status, 'stopped');
  db.close();
});

test('nothing that would move the branch is allowed while the checks run, and no pull request is offered', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = launch(orchestrator, repo, { commands: ['sleep 120'], fixer: false, maxAttempts: 1 });
  await until(() => orchestrator.get(started.id)?.verification?.status === 'running', 'the check to be running');

  assert.throws(() => orchestrator.pullRequest(started.id), /checks are still running/);
  assert.throws(() => orchestrator.retryIntegration(started.id), /still running|checks are running/);
  assert.throws(() => orchestrator.verify(started.id), /finishes|still running|already running/);
  orchestrator.stop(started.id);
  await until(() => orchestrator.get(started.id)?.verification?.status === 'failed', 'the checks to end');
  db.close();
});

test('a graph launched without checks can be checked afterwards, by hand, and again', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = launch(orchestrator, repo);
  const orch = await settle(orchestrator, started.id);
  assert.equal(orch.verification, null);
  assert.throws(() => orchestrator.verify(orch.id), /no checks to run/);
  assert.throws(() => orchestrator.verify(orch.id, { verification: { commands: [], fixer: false, maxAttempts: 1 } }), /at least one command/);

  const running = orchestrator.verify(orch.id, { verification: { commands: ['test -f api.txt'], fixer: false, maxAttempts: 1 } });
  assert.equal(running.verification?.status, 'running');
  await until(() => orchestrator.get(orch.id)?.verification?.status !== 'running', 'the checks to end');
  assert.equal(orchestrator.get(orch.id)?.verification?.status, 'passed');
  assert.equal(orchestrator.get(orch.id)?.status, 'completed');

  // Kept on the graph, so running them again needs no spec
  orchestrator.verify(orch.id);
  await until(() => orchestrator.get(orch.id)?.verification?.status !== 'running', 'the second run to end');
  assert.equal(orchestrator.get(orch.id)?.verification?.status, 'passed');
  db.close();
});

test('checks need a worktree graph, and a relaunch or a template keeps them', async () => {
  const { db, repo, orchestrator } = fixture();
  const spec: VerificationSpec = { commands: ['true'], fixer: true, maxAttempts: 3, timeoutMinutes: 5 };
  assert.throws(
    () => orchestrator.create({ name: 'shared', cwd: repo, verification: spec, tasks: [{ id: 'a', name: 'a', prompt: 'x' }] }),
    /needs the graph engine with a worktree per task/,
  );
  assert.throws(
    () => orchestrator.create({ name: 'bad', cwd: repo, worktree: true, verification: { ...spec, commands: [] }, tasks: [{ id: 'a', name: 'a', prompt: 'x' }] }),
    /at least one command/,
  );

  const started = launch(orchestrator, repo, spec);
  const orch = await settle(orchestrator, started.id);
  assert.deepEqual(orchestrator.specOf(orch.id).verification, { ...spec, timeoutMinutes: 5 });
  const copy = orchestrator.relaunch(orch.id);
  assert.deepEqual(copy.verificationSpec, orch.verificationSpec);
  orchestrator.stop(copy.id);
  db.close();
});

test('a wrapper restart in the middle of the checks leaves them failed, not running for ever', () => {
  const config = { ...tempConfig(), claudeBin: '/nonexistent/claude' };
  const db = new Db(config);
  const repo = repoWithCommit();
  const graph: Orchestration = {
    id: 'graph-1',
    name: 'cut',
    objective: null,
    status: 'stopped',
    cwd: repo,
    model: null,
    permissionMode: 'acceptEdits',
    concurrency: 1,
    synthesize: false,
    worktree: true,
    maxAttempts: 2,
    allowedTools: [],
    permissionPrompts: 'none',
    createdAt: '2026-01-01T10:00:00Z',
    endedAt: '2026-01-01T10:30:00Z',
    finalResult: null,
    costUsd: 0,
    tasks: [],
    verificationSpec: { commands: ['pnpm e2e'], fixer: true, maxAttempts: 2 },
    verification: {
      status: 'running',
      attempts: 1,
      commands: [{ command: 'pnpm e2e', status: 'running', output: '', durationMs: 0 }],
      commits: [],
      report: '',
      costUsd: 0,
    },
  };
  db.saveOrchestrations([graph]);

  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  const v = orchestrator.get('graph-1')?.verification;
  assert.equal(v?.status, 'failed');
  assert.match(v?.report ?? '', /wrapper restart/);
  db.close();
});

test('every worker is told which checks are its own, whatever the objective says', () => {
  const { db, repo, orchestrator } = fixture();
  const checked = launch(orchestrator, repo, { commands: ['true'], fixer: false, maxAttempts: 1 });
  const plain = orchestrator.create({ name: 'plain', objective: 'x', cwd: repo, worktree: true, tasks: [{ id: 'a', name: 'a', prompt: 'do a' }] });
  const promptOf = (o: Orchestration) => orchestrator['buildPrompt'](o, o.tasks[0] as Orchestration['tasks'][number]);

  assert.match(promptOf(checked), /Do not run the end-to-end or browser suite: it runs once, on the merged branch, in a verification phase/);
  assert.match(promptOf(checked), /under `timeout`/);
  assert.match(promptOf(plain), /Do not run the end-to-end or browser suite: it is slow/);
  // Before the closing instruction, after the task itself
  assert.ok(promptOf(checked).indexOf('FAKE-WRITE api.txt server') < promptOf(checked).indexOf('Checks:'));
  assert.ok(promptOf(checked).indexOf('Checks:') < promptOf(checked).indexOf('Finish with a concise report'));
  orchestrator.stop(checked.id);
  orchestrator.stop(plain.id);
  db.close();
});
