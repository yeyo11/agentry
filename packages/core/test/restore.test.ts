import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { RunEvent } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { ChatManager } from '../src/chats.ts';
import { SessionStore } from '../src/sessions.ts';
import { encodeProjectId } from '../src/workspace.ts';
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

/** A store holding one chat whose execution was live when the previous wrapper process went away. */
function previousWrapper(sessionId: string, updatedAt = new Date().toISOString()) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const saved = {
    // A chat is its session id
    id: sessionId,
    sessionId,
  };
  const before = new Db(config);
  before.saveChats(
    [
      {
        record: {
          id: sessionId,
          name: 'coordinator',
          cwd: config.workspaceDir,
          workingDir: config.workspaceDir,
          origin: 'agentry',
          orchestrationId: null,
          orchestrationTaskId: null,
          derivedFrom: null,
          prompt: 'coordinate',
          lastText: null,
          model: null,
          permissionMode: 'bypassPermissions',
          account: null,
          permissionPrompts: 'none',
          createdAt: startedAt,
          updatedAt,
        },
        executions: [
          {
            id: randomUUID(),
            startedAt,
            endedAt: null,
            outcome: null,
            error: null,
            permissionMode: 'bypassPermissions',
            model: null,
            account: null,
            maxBudgetUsd: null,
            costUsd: null,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
            turns: 3,
          },
        ],
      },
    ],
    200,
  );
  before.close();
  const log = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  return { config, db, runs, saved, log };
}

/** Kills what this test spawned, through the manager or by hand, and nothing else. */
function cleanUp(runs: ChatManager, db: Db, log: string, extra: number[] = []): void {
  runs.stopAll();
  for (const { pid } of spawned(log)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (const pid of extra) if (alive(pid)) process.kill(pid, 'SIGKILL');
  db.close();
  delete process.env.FAKE_CLAUDE_SPAWNS;
  delete process.env.FAKE_CLAUDE_LINGER_MS;
}

test('a restored chat resumed from several places at once starts one process', async () => {
  const { config, db, runs, saved, log } = previousWrapper(randomUUID());
  try {
    await runs.restore(new SessionStore(config));
    assert.equal(runs.get(saved.id)?.status, 'stopped');
    // Its execution was live when the wrapper went away and nobody stopped it: it is not "stopped"
    assert.deepEqual(runs.get(saved.id)?.executions.map((e) => e.outcome), ['interrupted']);

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

test('an execution a restart cut off says why, and stopped when the transcript last heard from it', async () => {
  const sessionId = randomUUID();
  const recorded = new Date(Date.now() - 50_000).toISOString();
  const lastLine = new Date(Date.now() - 20_000).toISOString();
  const { config, db, runs, log } = previousWrapper(sessionId, recorded);
  try {
    // The record is only written at a few moments of a turn; the transcript is written as it goes
    const dir = join(config.projectsDir, encodeProjectId(config.workspaceDir));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      [
        { type: 'user', uuid: 'u1', timestamp: recorded, cwd: config.workspaceDir, sessionId, message: { role: 'user', content: 'coordinate' } },
        { type: 'assistant', uuid: 'a1', timestamp: lastLine, cwd: config.workspaceDir, sessionId, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'working' }] } },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n'),
    );
    await runs.restore(new SessionStore(config));
    const cut = runs.get(sessionId)?.executions[0];
    assert.equal(cut?.outcome, 'interrupted');
    assert.equal(cut?.error, 'interrupted by a wrapper restart');
    assert.equal(cut?.endedAt, lastLine);
    assert.equal(runs.get(sessionId)?.endedAt, lastLine);
  } finally {
    cleanUp(runs, db, log);
  }
});

test('with no transcript to read, a cut-off execution stops when its record was last written', async () => {
  const sessionId = randomUUID();
  const recorded = new Date(Date.now() - 50_000).toISOString();
  const { config, db, runs, log } = previousWrapper(sessionId, recorded);
  try {
    await runs.restore(new SessionStore(config));
    const cut = runs.get(sessionId)?.executions[0];
    assert.equal(cut?.endedAt, recorded);
    assert.equal(cut?.error, 'interrupted by a wrapper restart');
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
  const { config, db, runs, saved, log } = previousWrapper(sessionId);
  try {
    await until(() => existsSync(`/proc/${leftover.pid}/cmdline`) && readFileSync(`/proc/${leftover.pid}/cmdline`, 'utf8').includes(sessionId), 'the leftover to start');
    await runs.restore(new SessionStore(config));

    assert.deepEqual(runs.strays(), [{ chatId: saved.id, pid: leftover.pid }]);
    const notice = runs.events(saved.id).find((e) => e.kind === 'notice');
    assert.match(notice?.text ?? '', new RegExp(`${leftover.pid}`));
    assert.equal(runs.get(saved.id)?.status, 'stopped');

    assert.throws(() => runs.send(saved.id, 'carry on'), /still running/);
    // Resuming the chat is the same second process, by another door
    const before = runs.list().length;
    assert.throws(() => runs.resume(sessionId, { prompt: 'carry on' }), /still running/);
    assert.equal(runs.list().length, before, 'a refused resume leaves no chat behind');
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
