import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { RunEvent, RunSummary } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { RunManager } from '../src/runner.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

// Incident, 2026-09-19: after the API restarted under `tsx watch`, one run came back as three
// `claude -p --resume` processes started in the same second. Only the last one was recorded on the
// run; the other two carried on the same conversation untracked, and the run was later marked
// `failed` while the process it recorded was still working.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Every CLI process the fake saw start, tracked by the run or not. */
function spawned(log: string): Array<{ pid: number; argv: string }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ pid: Number(line.slice(0, line.indexOf(' '))), argv: line.slice(line.indexOf(' ') + 1) }));
}

/** A store holding one run that was live when the previous wrapper process went away. */
function previousWrapper(sessionId: string, pid: number | null = null) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const saved: RunSummary = {
    id: randomUUID(),
    name: 'coordinator',
    sessionId,
    cwd: config.workspaceDir,
    model: null,
    permissionMode: 'bypassPermissions',
    status: 'busy',
    pid,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    turns: 3,
    costUsd: 0,
    prompt: 'coordinate',
    lastText: null,
    error: null,
    orchestrationId: null,
    orchestrationTaskId: null,
    internal: false,
    account: null,
    backgroundTasks: [],
    subagents: [],
    workflows: [],
    workingDir: config.workspaceDir,
    permissionPrompts: 'none',
    pendingPrompts: 0,
  };
  const before = new Db(config);
  before.saveRuns([saved], 200);
  before.close();
  const log = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  const db = new Db(config);
  const runs = new RunManager(config, db);
  return { config, db, runs, saved, log };
}

/** Kills what this test spawned, through the manager or by hand, and nothing else. */
function cleanUp(runs: RunManager, db: Db, log: string, extra: number[] = []): void {
  runs.stopAll();
  for (const { pid } of spawned(log)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (const pid of extra) if (alive(pid)) process.kill(pid, 'SIGKILL');
  db.close();
  delete process.env.FAKE_CLAUDE_SPAWNS;
  delete process.env.FAKE_CLAUDE_LINGER_MS;
}

test('a restored run resumed from several places at once starts one process', async () => {
  const { config, db, runs, saved, log } = previousWrapper(randomUUID());
  try {
    await runs.restore(new SessionStore(config));
    assert.equal(runs.get(saved.id)?.status, 'stopped');

    // The panel, a retried request and whatever else resumes the run, all in the same tick
    runs.send(saved.id, 'one');
    runs.send(saved.id, 'two');
    runs.send(saved.id, 'three');
    const first = await until(() => runs.get(saved.id)?.status === 'idle' && runs.get(saved.id), 'the resumed turn');
    assert.equal(spawned(log).length, 1);
    assert.equal(first.pid, spawned(log)[0]?.pid);
    assert.match(spawned(log)[0]?.argv ?? '', new RegExp(`--resume ${saved.sessionId}`));
  } finally {
    cleanUp(runs, db, log);
  }
});

test('a message sent while the stopped process is still exiting waits for it, and the run does not fail', async () => {
  const { config, db, runs, saved, log } = previousWrapper(randomUUID());
  try {
    await runs.restore(new SessionStore(config));
    runs.send(saved.id, 'wake up');
    const first = await until(() => runs.get(saved.id)?.status === 'idle' && runs.get(saved.id), 'the resumed turn');
    const statuses: string[] = [];
    runs.subscribe(saved.id, (event: RunEvent) => {
      if (event.kind === 'status' && event.status) statuses.push(event.status);
    });

    // A stopped process takes a moment to go; being signalled is not being gone
    runs.stop(saved.id);
    runs.send(saved.id, 'again');
    runs.send(saved.id, 'and again');
    assert.ok(first.pid !== null && alive(first.pid), 'the stopped process has not exited yet');
    assert.equal(runs.get(saved.id)?.pid, first.pid, 'nothing is spawned beside a process that is still up');

    await until(() => spawned(log).length === 2 && runs.get(saved.id)?.status === 'idle' && runs.get(saved.id), 'the next process');
    await new Promise((r) => setTimeout(r, 300)); // room for a late exit to land on the run
    const after = runs.get(saved.id);
    assert.equal(spawned(log).length, 2);
    assert.equal(after?.status, 'idle');
    assert.equal(after?.pid, spawned(log)[1]?.pid);
    assert.ok(after?.pid && alive(after.pid));
    // The old process's exit ended its own turn, as a stop, and nothing the new one does
    assert.ok(!statuses.includes('failed'), `statuses: ${statuses.join(' → ')}`);
    assert.equal(after?.error, null);
    // Both messages reached the one replacement
    const users = runs.events(saved.id).filter((e) => e.kind === 'message' && e.entry?.role === 'user');
    assert.deepEqual(users.slice(-2).map((e) => e.entry?.blocks.at(-1)), [{ type: 'text', text: 'again' }, { type: 'text', text: 'and again' }]);
  } finally {
    cleanUp(runs, db, log);
  }
});

test('messages sent while the process is on its way out all go to one replacement', async () => {
  const { config, db, runs, log } = previousWrapper(randomUUID());
  try {
    // The CLI stays up after its stdin closes while background work finishes: that can be minutes,
    // and every message sent in that time used to schedule a respawn of its own
    process.env.FAKE_CLAUDE_LINGER_MS = '400';
    const run = runs.start({ prompt: 'first', keepAlive: false, cwd: config.workspaceDir });
    await until(() => runs.events(run.id).some((e) => e.kind === 'result'), 'the first result');
    runs.send(run.id, 'a');
    runs.send(run.id, 'b');
    runs.send(run.id, 'c');

    await until(() => spawned(log).length >= 2 && runs.get(run.id)?.status === 'completed', 'the replacement to finish', 15_000);
    await new Promise((r) => setTimeout(r, 300));
    const all = spawned(log);
    assert.equal(all.length, 2, all.map((p) => p.argv).join('\n'));
    assert.ok(all.every(({ pid }) => !alive(pid)), 'no process outlives the run');
    assert.equal(runs.get(run.id)?.status, 'completed');
    const users = runs.events(run.id).filter((e) => e.kind === 'message' && e.entry?.role === 'user');
    assert.deepEqual(users.map((e) => e.entry?.blocks.at(-1)), ['first', 'a', 'b', 'c'].map((text) => ({ type: 'text', text })));
  } finally {
    cleanUp(runs, db, log);
  }
});

test('a CLI process a previous wrapper left behind is reported, and never gets a twin', async () => {
  const sessionId = randomUUID();
  // Spawned here, not by the manager: it plays the process the previous API left running
  const leftover = spawn(FAKE_CLAUDE, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--resume', sessionId], { stdio: 'pipe' });
  assert.ok(leftover.pid);
  const { config, db, runs, saved, log } = previousWrapper(sessionId, leftover.pid);
  try {
    await until(() => existsSync(`/proc/${leftover.pid}/cmdline`) && readFileSync(`/proc/${leftover.pid}/cmdline`, 'utf8').includes(sessionId), 'the leftover to start');
    await runs.restore(new SessionStore(config));

    assert.deepEqual(runs.strays(), [{ runId: saved.id, sessionId, pid: leftover.pid }]);
    const notice = runs.events(saved.id).find((e) => e.kind === 'notice');
    assert.match(notice?.text ?? '', new RegExp(`${leftover.pid}`));
    assert.equal(runs.get(saved.id)?.status, 'stopped');

    assert.throws(() => runs.send(saved.id, 'carry on'), /still running/);
    // Continuing the same session as a new run is the same second process, by another door
    const before = runs.list().length;
    assert.throws(() => runs.start({ prompt: 'carry on', resumeSessionId: sessionId }), /still running/);
    assert.equal(runs.list().length, before, 'a refused start leaves no run behind');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(spawned(log).length, 0, 'no second process on a conversation that already has one');

    // Stopping the run is how someone clears it from the panel
    runs.stop(saved.id);
    await until(() => leftover.exitCode !== null || leftover.signalCode !== null, 'the leftover to exit');
    assert.deepEqual(runs.strays(), []);
    runs.send(saved.id, 'carry on');
    await until(() => runs.get(saved.id)?.status === 'idle', 'the resumed turn');
    assert.equal(spawned(log).length, 1);
  } finally {
    cleanUp(runs, db, log, leftover.pid ? [leftover.pid] : []);
  }
});
