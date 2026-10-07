import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Orchestration, VerificationSpec } from '@agentry/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { Orchestrator, verificationSteps } from '../src/orchestrator.ts';
import { failedSpecs, fixerPrompt, installStep, normalizeVerification, runCommand, tail, workerChecks } from '../src/verification.ts';
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
    commands: ['pnpm build', 'pnpm e2e'],
    failed: [{ command: 'pnpm e2e', failure: 'It timed out after 20 min and was killed.', output: 'spec a failed' }],
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

test('a parallel group in a verification spec is kept, a group of one is its command, and a bad entry is refused by its index', () => {
  const spec = (commands: unknown): VerificationSpec => ({ commands, fixer: false, maxAttempts: 1 }) as VerificationSpec;
  assert.deepEqual(normalizeVerification(spec([[' pnpm typecheck', 'pnpm test '], ['pnpm build'], 'pnpm e2e']))?.commands, [
    ['pnpm typecheck', 'pnpm test'],
    'pnpm build',
    'pnpm e2e',
  ]);
  assert.throws(() => normalizeVerification(spec(['true', []])), /commands\[1\] is an empty list/);
  assert.throws(() => normalizeVerification(spec([['true', ['nested']]])), /commands\[0\]\[1\].*does not nest/);
  assert.throws(() => normalizeVerification(spec([['true', 3]])), /commands\[0\]\[1\] must be a shell command/);
  assert.throws(() => normalizeVerification(spec(['true', 7])), /commands\[1\] must be a shell command/);
  assert.throws(() => normalizeVerification(spec([['true', '  ']])), /empty command/);
  // The limit is on commands, whatever the entries they are grouped in
  assert.throws(() => normalizeVerification(spec([Array.from({ length: 7 }, () => 'true'), Array.from({ length: 6 }, () => 'true')])), /at most 12 commands/);
  assert.equal(normalizeVerification(spec([Array.from({ length: 6 }, () => 'true'), Array.from({ length: 6 }, () => 'true')]))?.commands.flat().length, 12);
});

test('a detected install already in a parallel group of the checks is not added twice', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agentry-install-'));
  writeFileSync(join(repo, 'pnpm-lock.yaml'), '');
  const spec: VerificationSpec = { commands: [['pnpm install --frozen-lockfile', 'pnpm lint'], 'pnpm test'], fixer: false, maxAttempts: 1 };
  assert.equal(installStep(spec, repo, repo), null);
});

test('the checks run in steps: the install alone, a group together, and rows stored before groups one by one', () => {
  const row = (command: string, extra: { group?: number; install?: boolean } = {}) => ({ command, status: 'pending' as const, output: '', durationMs: 0, ...extra });
  assert.deepEqual(
    verificationSteps([row('pnpm install', { install: true }), row('tc', { group: 0 }), row('test', { group: 0 }), row('build', { group: 1 }), row('e2e', { group: 2 })]),
    [[0], [1, 2], [3], [4]],
  );
  assert.deepEqual(verificationSteps([row('a'), row('b')]), [[0], [1]]);
});

test('the spec files a runner reports as failed are read in order, once each, from the summary repeat too', () => {
  const output = [
    '✓ auth.spec.mjs (3.1s)',
    '✗ chats.spec.mjs',
    '  assertion failed: the title is the first prompt',
    '  ✗ nested.spec.mjs is part of a message, not a failed spec',
    '- live.spec.mjs (skipped: E2E_LIVE is not set)',
    '✗ \u001b[31mconfig.spec.mjs\u001b[0m',
    '✓ tunnel.spec.mjs (1.0s)',
    '',
    'failed:',
    '✗ chats.spec.mjs',
    '✗ config.spec.mjs',
    '2 spec(s) failed',
  ].join('\n');
  assert.deepEqual(failedSpecs(output), ['chats.spec.mjs', 'config.spec.mjs']);
  assert.deepEqual(failedSpecs('all 12 spec file(s) passed\n'), []);
  assert.equal(failedSpecs(Array.from({ length: 30 }, (_, i) => `✗ s${String(i)}.spec.mjs`).join('\n')).length, 20);
});

test('a command reports the failed specs of all its output, not only of the tail it keeps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-cmd-'));
  const outcome = await runCommand("printf '✗ early.spec.mjs\\n'; head -c 60000 /dev/zero | tr '\\0' x; printf '\\n✗ late.spec.mjs\\n'; exit 1", dir, 30_000);
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(outcome.output, /early\.spec/);
  assert.deepEqual(outcome.failedSpecs, ['early.spec.mjs', 'late.spec.mjs']);
});

test('the fixer is told the failed spec files only when there are some, in words that fit any repository', () => {
  const base = {
    objective: 'x',
    branch: 'b',
    worktree: '/w',
    commands: [['lint', 'unit'], 'suite'],
    failed: [
      { command: 'lint', failure: 'It exited with code 1.', output: 'lint says no' },
      { command: 'unit', failure: 'It exited with code 2.', output: 'unit says no' },
    ],
    attempt: 1,
    maxAttempts: 2,
    earlier: [],
    tasks: [],
    timeoutMinutes: 20,
  } satisfies Parameters<typeof fixerPrompt>[0];
  const without = fixerPrompt(base);
  assert.doesNotMatch(without, /These spec files failed/);
  assert.match(without, /1\. at the same time: lint \| unit/);
  assert.match(without, /ran at the same time and failed/);
  assert.match(without, /lint says no[\s\S]*unit says no/);
  const withSpecs = fixerPrompt({ ...base, failedSpecs: ['a.spec.mjs', 'b.spec.mjs'] });
  const paragraph = withSpecs.split('\n\n').find((p) => p.startsWith('These spec files failed')) ?? '';
  // The names come from the checked project's output, so they are pasted content (CW-24)
  assert.match(
    paragraph,
    /^These spec files failed \(read from the check's output\):\n<pasted_content id="([0-9a-f]{8})">\na\.spec\.mjs\nb\.spec\.mjs\n<\/pasted_content id="\1">\nStart with them, one at a time; do not run the whole suite to find them\.$/,
  );
  // The block's random hex id can hold four digits in a row: only the words are checked for a port
  assert.doesNotMatch(paragraph.replace(/ id="[0-9a-f]{8}"/g, ''), /pnpm|e2e\/|port|\d{4}/);
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

test('the commands of a parallel group run at the same time, and the next entry waits for all of them', async () => {
  const { db, repo, orchestrator } = fixture();
  // Each passes only if the other started while it slept: run one after the other, the first fails
  const a = 'touch a.started; sleep 1; test -f b.started; touch a.done';
  const b = 'touch b.started; sleep 1; test -f a.started; touch b.done';
  const started = launch(orchestrator, repo, { commands: [[a, b], 'test -f a.done && test -f b.done'], fixer: false, maxAttempts: 1 });
  const orch = await settle(orchestrator, started.id);

  const v = orch.verification;
  assert.equal(v?.status, 'passed', v?.report ?? '');
  assert.deepEqual(v?.commands.map((c) => [c.status, c.group]), [
    ['passed', 0],
    ['passed', 0],
    ['passed', 1],
  ]);
  for (const c of v?.commands.slice(0, 2) ?? []) assert.ok(c.durationMs >= 900 && c.durationMs < 1900, `each keeps its own duration: ${String(c.durationMs)}`);
  assert.match(v?.report ?? '', /All 3 checks passed/);
  db.close();
});

test('a group with failures lets its other commands finish, and with no fixer the report names every failed one', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = launch(orchestrator, repo, { commands: [['echo lint broke; exit 3', 'sleep 0.3', 'echo unit broke; exit 4'], 'echo never'], fixer: false, maxAttempts: 1 });
  const orch = await settle(orchestrator, started.id);

  const v = orch.verification;
  assert.equal(v?.status, 'failed');
  assert.deepEqual(v?.commands.map((c) => c.status), ['failed', 'passed', 'failed', 'pending']);
  assert.match(v?.commands[0]?.output ?? '', /lint broke/);
  assert.match(v?.commands[2]?.output ?? '', /unit broke/);
  assert.match(v?.report ?? '', /`echo lint broke; exit 3` exited with code 3; `echo unit broke; exit 4` exited with code 4\. The fixer is off/);
  assert.match(v?.report ?? '', /Not run: `echo never`/);
  db.close();
});

test('one fixer attempt covers every failed command of a group, and the checks all run again after it', async () => {
  const { db, repo, orchestrator } = fixture();
  // Each prints the line the stand-in for the CLI reads as an instruction, so one prompt carrying both outputs mends both
  const lint = "echo 'FAKE-WRITE lint.txt ok'; test -f lint.txt";
  const unit = "echo 'FAKE-WRITE unit.txt ok'; test -f unit.txt";
  const started = launch(orchestrator, repo, { commands: ['true', [lint, unit]], fixer: true, maxAttempts: 1 });
  const orch = await settle(orchestrator, started.id);

  const v = orch.verification;
  assert.equal(v?.status, 'fixed', v?.report ?? '');
  // With maxAttempts 1, an attempt per command would have run out on the second one
  assert.equal(v?.attempts, 1);
  assert.deepEqual(v?.commands.map((c) => c.status), ['passed', 'fixed', 'fixed']);
  assert.match(v?.report ?? '', /2 checks failed and were fixed in 1 attempt/);
  db.close();
});

test('stopping the orchestration stops every command of the group that is running', async () => {
  const { db, repo, orchestrator } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'agentry-pid-'));
  const one = join(dir, 'one');
  const two = join(dir, 'two');
  const started = launch(orchestrator, repo, {
    commands: [[`sleep 120 & echo $! > ${one}; wait`, `sleep 120 & echo $! > ${two}; wait`]],
    fixer: true,
    maxAttempts: 2,
  });
  await until(() => existsSync(one) && existsSync(two) && readFileSync(two, 'utf8').trim() !== '' && readFileSync(one, 'utf8').trim() !== '', 'both commands to be running');
  const pids = [one, two].map((f) => Number(readFileSync(f, 'utf8').trim()));

  orchestrator.stop(started.id);
  await until(() => orchestrator.get(started.id)?.verification?.status === 'failed', 'the checks to end');
  const v = orchestrator.get(started.id)?.verification;
  assert.match(v?.report ?? '', /Stopped/);
  assert.equal(v?.attempts, 0);
  await until(() => pids.every((pid) => !alive(pid)), 'both commands’ processes to be gone');
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

  await assert.rejects(() => orchestrator.pullRequest(started.id), /checks are still running/);
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

// ---------- the fixer's cost, the install step, failGraph ----------

function commitFile(repo: string, file: string, content: string): void {
  writeFileSync(join(repo, file), content);
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', `add ${file}`], { stdio: 'pipe' });
}

test('a spec keeps its cost limit, install step and failGraph, and refuses what could not mean anything', () => {
  const spec = (over: Partial<VerificationSpec>): VerificationSpec => ({ commands: ['true'], fixer: true, maxAttempts: 2, ...over });
  assert.deepEqual(normalizeVerification(spec({ maxCostUsd: 1.5, install: ' npm ci ', failGraph: true })), {
    commands: ['true'],
    fixer: true,
    maxAttempts: 2,
    timeoutMinutes: 20,
    maxCostUsd: 1.5,
    install: 'npm ci',
    failGraph: true,
  });
  // null is a decision (no install step) and survives; absent means "detect it" and stays absent
  assert.equal(normalizeVerification(spec({ install: null }))?.install, null);
  assert.equal('install' in (normalizeVerification(spec({})) ?? {}), false);
  assert.equal('failGraph' in (normalizeVerification(spec({ failGraph: false })) ?? {}), false);
  assert.throws(() => normalizeVerification(spec({ maxCostUsd: 0 })), /maxCostUsd/);
  assert.throws(() => normalizeVerification(spec({ maxCostUsd: -1 })), /maxCostUsd/);
  assert.throws(() => normalizeVerification(spec({ maxCostUsd: Number.NaN })), /maxCostUsd/);
  assert.throws(() => normalizeVerification(spec({ install: '  ' })), /install must not be empty/);
  assert.throws(() => normalizeVerification(spec({ install: 3 as unknown as string })), /install must be a shell command/);
  assert.throws(() => normalizeVerification(spec({ failGraph: 'yes' as unknown as boolean })), /failGraph/);
});

test('the install step comes from the nearest lockfile inside the worktree, or from the spec', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-install-'));
  const sub = join(root, 'packages', 'app');
  mkdirSync(sub, { recursive: true });
  const spec: VerificationSpec = { commands: ['pnpm test'], fixer: false, maxAttempts: 1 };

  assert.equal(installStep(spec, root, sub), null, 'no lockfile, no install step');
  writeFileSync(join(root, 'yarn.lock'), '');
  assert.deepEqual(installStep(spec, root, sub), { command: 'yarn install --frozen-lockfile', cwd: root });
  writeFileSync(join(root, 'package-lock.json'), '{}');
  assert.deepEqual(installStep(spec, root, root), { command: 'npm ci', cwd: root });
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  assert.deepEqual(installStep(spec, root, sub), { command: 'pnpm install --frozen-lockfile', cwd: root });
  // The nearest one wins: a graph confined to a package with its own lockfile installs that package
  writeFileSync(join(sub, 'package-lock.json'), '{}');
  assert.deepEqual(installStep(spec, root, sub), { command: 'npm ci', cwd: sub });

  assert.equal(installStep({ ...spec, install: null }, root, sub), null);
  assert.deepEqual(installStep({ ...spec, install: 'make deps' }, root, sub), { command: 'make deps', cwd: sub });
  // A spec written before the step existed, which installs as its first check, does not install twice
  assert.equal(installStep({ ...spec, commands: ['pnpm install --frozen-lockfile', 'pnpm test'] }, root, root), null);
  // A lockfile above the worktree belongs to some other checkout
  const inner = join(root, 'wt');
  mkdirSync(inner);
  assert.equal(installStep(spec, inner, inner), null);
});

test('a detected install runs first, as its own row, where the lockfile is', async () => {
  const { db, repo, orchestrator } = fixture();
  commitFile(repo, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  // A stand-in for pnpm, so the test proves what ran without installing anything
  const bin = mkdtempSync(join(tmpdir(), 'agentry-bin-'));
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "installed with $*" | tee installed.txt\n');
  chmodSync(join(bin, 'pnpm'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  try {
    const started = launch(orchestrator, repo, { commands: ['test -f installed.txt'], fixer: false, maxAttempts: 1 });
    const orch = await settle(orchestrator, started.id);
    const v = orch.verification;
    assert.equal(v?.status, 'passed', v?.report ?? '');
    assert.deepEqual(
      v?.commands.map((c) => [c.command, c.status, c.install === true]),
      [
        ['pnpm install --frozen-lockfile', 'passed', true],
        ['test -f installed.txt', 'passed', false],
      ],
    );
    assert.match(v?.commands[0]?.output ?? '', /installed with install --frozen-lockfile/);
  } finally {
    process.env.PATH = path;
  }
  db.close();
});

test('install: null runs no install step, and a given one replaces the detected one', async () => {
  const { db, repo, orchestrator } = fixture();
  commitFile(repo, 'yarn.lock', '');
  const none = await settle(orchestrator, launch(orchestrator, repo, { commands: ['true'], fixer: false, maxAttempts: 1, install: null }).id);
  assert.deepEqual(none.verification?.commands.map((c) => c.command), ['true']);

  const given = await settle(
    orchestrator,
    launch(orchestrator, repo, { commands: ['test -f deps.txt'], fixer: false, maxAttempts: 1, install: 'echo ok > deps.txt' }).id,
  );
  assert.equal(given.verification?.status, 'passed', given.verification?.report ?? '');
  assert.deepEqual(given.verification?.commands.map((c) => [c.command, c.install === true]), [
    ['echo ok > deps.txt', true],
    ['test -f deps.txt', false],
  ]);
  db.close();
});

test('the fixer gets what is left of its cost limit on each attempt, and stops when it is spent', async () => {
  const { db, repo, orchestrator } = fixture();
  const spawns = join(mkdtempSync(join(tmpdir(), 'agentry-spawns-')), 'spawns');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  try {
    // The stand-in for the CLI reports $0.01 a run: two attempts spend the limit, a third is not started
    const started = launch(orchestrator, repo, { commands: ['echo still broken; exit 1'], fixer: true, maxAttempts: 5, maxCostUsd: 0.02 });
    const orch = await settle(orchestrator, started.id);
    const v = orch.verification;
    assert.equal(v?.status, 'failed');
    assert.equal(v?.attempts, 2);
    assert.ok(Math.abs((v?.costUsd ?? 0) - 0.02) < 1e-9, String(v?.costUsd));
    assert.match(v?.report ?? '', /cost limit of \$0\.02 is spent \(\$0\.02 over 2 attempts\)/);
    // The worker and the fixer, both in the graph's cost
    assert.ok(Math.abs(orch.costUsd - 0.03) < 1e-9, String(orch.costUsd));
    const budgets = readFileSync(spawns, 'utf8')
      .split('\n')
      .map((line) => / --max-budget-usd (\S+)/.exec(line)?.[1])
      .filter((b): b is string => b !== undefined)
      .map(Number);
    assert.deepEqual(budgets, [0.02, 0.01]);
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
  }
  db.close();
});

test('a fixer cut short by its cost limit fails the verification without running the checks again', async () => {
  const { db, repo, orchestrator } = fixture();
  // Printed by the check, so the fixer prompt carries the line that makes the stand-in end on its budget
  const started = launch(orchestrator, repo, { commands: ["echo 'FAKE-BUDGET'; exit 1", 'echo never'], fixer: true, maxAttempts: 3, maxCostUsd: 1 });
  const orch = await settle(orchestrator, started.id);
  const v = orch.verification;
  assert.equal(v?.status, 'failed');
  assert.equal(v?.attempts, 1);
  assert.match(v?.report ?? '', /cost limit of \$1\.00 ran out during attempt 1/);
  assert.deepEqual(v?.commands.map((c) => c.status), ['failed', 'pending']);
  assert.ok((v?.costUsd ?? 0) > 0);
  db.close();
});

test('failGraph: failed checks fail the graph and hold back the pull request, until they pass again', async () => {
  const { db, repo, orchestrator } = fixture();
  const spec: VerificationSpec = { commands: ['echo the build broke; exit 2'], fixer: false, maxAttempts: 1, failGraph: true };
  const orch = await settle(orchestrator, launch(orchestrator, repo, spec).id);
  assert.equal(orch.verification?.status, 'failed');
  assert.equal(orch.status, 'failed');
  assert.match(orch.error ?? '', /The checks on the merged branch failed: `echo the build broke; exit 2` exited with code 2/);
  // Every task did its part: the failure is the checks'
  assert.ok(orch.tasks.every((t) => t.status === 'completed'));
  await assert.rejects(() => orchestrator.pullRequest(orch.id), /launched to fail with them/);

  orchestrator.verify(orch.id, { verification: { ...spec, commands: ['true'] } });
  await until(() => orchestrator.get(orch.id)?.verification?.status === 'passed', 'the checks to pass');
  await until(() => orchestrator.get(orch.id)?.status === 'completed', 'the graph to be completed again');
  assert.equal(orchestrator.get(orch.id)?.error, null);

  // And a completed graph whose checks, run again, fail, fails with them
  orchestrator.verify(orch.id, { verification: spec });
  await until(() => orchestrator.get(orch.id)?.status === 'failed', 'the graph to fail by its checks');
  assert.match(orchestrator.get(orch.id)?.error ?? '', /checks on the merged branch failed/);
  db.close();
});

test('a verification recorded before the fixer had a cost reads as zero', () => {
  const config = { ...tempConfig(), claudeBin: '/nonexistent/claude' };
  const db = new Db(config);
  const old = {
    id: 'graph-old',
    name: 'old',
    objective: null,
    status: 'completed',
    cwd: repoWithCommit(),
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
    verificationSpec: { commands: ['true'], fixer: false, maxAttempts: 1 },
    verification: { status: 'passed', attempts: 0, commands: [], commits: [], report: 'ok' },
  } as unknown as Orchestration;
  db.saveOrchestrations([old]);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  assert.equal(orchestrator.get('graph-old')?.verification?.costUsd, 0);
  db.close();
});

// ---------- timings ----------

const inOrder = (start: string | null | undefined, end: string | null | undefined): boolean => !!start && !!end && start <= end;

test('integration, verification and synthesis record when they started and ended', async () => {
  const { db, repo, orchestrator } = fixture();
  const started = launch(orchestrator, repo, { commands: ['true'], fixer: false, maxAttempts: 1 }, { synthesize: true });
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.verification?.status, 'passed');
  assert.ok(inOrder(orch.integration?.startedAt, orch.integration?.endedAt), 'integration');
  assert.ok(inOrder(orch.verification?.startedAt, orch.verification?.endedAt), 'verification');
  assert.ok(inOrder(orch.synthesisStartedAt, orch.synthesisEndedAt), 'synthesis');
  // In the order they ran
  assert.ok((orch.integration?.endedAt ?? '') <= (orch.verification?.startedAt ?? ''));
  assert.ok((orch.verification?.endedAt ?? '') <= (orch.synthesisStartedAt ?? ''));
  assert.deepEqual(orch.verification?.fixes, []);
  assert.equal(orch.verification?.commands[0]?.runs?.length, 1);
  db.close();
});

test('a check that fails, is fixed and passes keeps both runs, and the fixer attempt is recorded with its chat', async () => {
  const { db, repo, orchestrator } = fixture();
  const command = "echo 'FAKE-WRITE marker.txt repaired'; test -f marker.txt";
  const started = launch(orchestrator, repo, { commands: ['true', command], fixer: true, maxAttempts: 2 });
  const orch = await settle(orchestrator, started.id);

  const v = orch.verification;
  assert.equal(v?.status, 'fixed', v?.report ?? '');
  const fixed = v?.commands[1];
  assert.deepEqual(fixed?.runs?.map((r) => [r.pass, r.status]), [
    [1, 'failed'],
    [2, 'passed'],
  ]);
  for (const run of fixed?.runs ?? []) {
    assert.ok(!Number.isNaN(Date.parse(run.startedAt)));
    assert.ok(run.durationMs >= 0);
  }
  // The last run is still what `durationMs` says, for clients that read only that
  assert.equal(fixed?.durationMs, fixed?.runs?.at(-1)?.durationMs);
  // The first check ran on both passes
  assert.deepEqual(v?.commands[0]?.runs?.map((r) => r.pass), [1, 2]);

  assert.equal(v?.fixes?.length, 1);
  const fix = v?.fixes?.[0];
  assert.equal(fix?.command, command);
  assert.equal(fix?.attempt, 1);
  assert.ok(fix?.runId, 'the fixer chat is findable from the graph');
  assert.ok(inOrder(fix?.startedAt, fix?.endedAt));
  assert.ok((fix?.costUsd ?? 0) > 0);
  assert.equal(fix?.costUsd, v?.costUsd);
  db.close();
});

test('a graph stored before the timings were recorded still loads, with none of them made up', () => {
  const config = { ...tempConfig(), claudeBin: '/nonexistent/claude' };
  const db = new Db(config);
  const graph: Orchestration = {
    id: 'old-graph',
    name: 'old',
    objective: null,
    status: 'completed',
    cwd: repoWithCommit(),
    model: null,
    permissionMode: 'acceptEdits',
    concurrency: 1,
    synthesize: true,
    worktree: true,
    maxAttempts: 2,
    allowedTools: [],
    permissionPrompts: 'none',
    createdAt: '2026-01-01T10:00:00Z',
    endedAt: '2026-01-01T10:30:00Z',
    finalResult: 'done',
    costUsd: 0,
    tasks: [],
    synthesisRunId: 'synth-1',
    integration: { branch: 'agentry/old', worktree: null, status: 'merged', merged: [], conflicts: [], commit: 'abc', error: null, integratorRunId: null },
    verification: { status: 'passed', attempts: 0, commands: [{ command: 'true', status: 'passed', output: '', durationMs: 5 }], commits: [], report: '', costUsd: 0 },
  };
  db.saveOrchestrations([graph]);
  const orch = new Orchestrator(config, new ChatManager(config, db), db).get('old-graph');
  assert.equal(orch?.integration?.status, 'merged');
  assert.equal(orch?.integration?.startedAt, undefined);
  assert.equal(orch?.verification?.startedAt, undefined);
  assert.equal(orch?.verification?.commands[0]?.runs, undefined);
  assert.equal(orch?.synthesisStartedAt, undefined);
  db.close();
});
