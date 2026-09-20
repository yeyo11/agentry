import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentryEvent } from '@agentry/shared';
import { ChatConflictError } from '../src/chat-service.ts';
import { HealthMonitor } from '../src/health-service.ts';
import { Core } from '../src/index.ts';
import { descendantsOf, processTable } from '../src/processes.ts';
import { tempConfig } from './helpers.ts';

// A worker that hangs, seen from outside: the CLI's heartbeat for a command, the history of how
// long its kind takes, the health that says so, and the two things a person can do about it that
// are not ending the turn — cancel that one command, or send a hint. The fake CLI runs a real
// process tree for `SLEEP`, so what is cancelled is a real one.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  const started = (prompt: string) => core.runtime.start({ prompt });
  return { core, started };
}

/** A chat that is running `sleep` as a command, once the fake CLI has started it. */
async function sleeping(core: Core, id: string) {
  return until(() => {
    const command = core.runtime.pulse(id)?.commands[0];
    const pid = core.runtime.get(id)?.pid;
    return command && pid ? { command, pid } : null;
  }, 'the command to start');
}

const base = { state: 'working' as const, lastEnded: null, context: null, failedBranches: 0 };

test('the CLI heartbeat for a running command is kept with it, and does not fill the transcript', async () => {
  const { core, started } = setup();
  try {
    const chat = started('SLEEP 60');
    const { command } = await sleeping(core, chat.id);
    await until(() => core.runtime.pulse(chat.id)?.commands[0]?.heartbeat, 'the heartbeat');
    assert.equal(core.runtime.pulse(chat.id)?.commands[0]?.heartbeat?.elapsedSeconds, 90);
    assert.equal(command.command, 'sleep 60');
    assert.ok(command.toolUseId.startsWith('toolu_sleep_'));
    // A beat is state, not an event: one every 30 s per command would drown the events of the chat
    assert.equal(core.runtime.events(chat.id).some((e) => e.type === 'tool_progress'), false);
  } finally {
    core.shutdown();
  }
});

test('cancelling a command kills its process tree and the turn goes on, with the worker told a person did it', async () => {
  const { core, started } = setup();
  try {
    const chat = started('SLEEP 60');
    const { command, pid } = await sleeping(core, chat.id);
    const tree = await until(() => {
      const found = descendantsOf(processTable(), pid);
      return found.length >= 2 ? found.map((p) => p.pid) : null;
    }, 'the shell and its sleep');

    const result = await core.chats.cancelCommand(chat.id, command.toolUseId, { reason: 'the suite hangs on an open connection' });
    assert.equal(result.command, 'sleep 60');
    assert.equal(result.processes, tree.length);
    await until(() => !tree.some(alive), 'the whole tree to be gone');

    // The chat's own process is untouched, and the CLI's failed result for that call arrived
    assert.equal(alive(pid), true);
    assert.equal(core.runtime.get(chat.id)?.pid, pid);
    const failed = await until(
      () => core.runtime.events(chat.id).flatMap((e) => e.entry?.blocks ?? []).find((b) => b.type === 'tool_result' && b.toolUseId === command.toolUseId),
      'the failed result',
    );
    assert.equal(failed.type === 'tool_result' && failed.isError, true);
    // The worker carries on: the turn ends normally, not as a failure of the chat
    await until(() => core.runtime.get(chat.id)?.status === 'idle', 'the turn to end');
    assert.equal(core.runtime.get(chat.id)?.error, null);

    // It was told, in words, since an exit status alone looks like the command's own crash
    const said = core.runtime.events(chat.id).flatMap((e) => e.entry?.blocks ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : []));
    assert.ok(said.some((t) => t.includes('A person cancelled the command `sleep 60`') && t.includes('the suite hangs on an open connection')), said.join('|'));
    // And what the chat's page shows notes it
    assert.ok(core.runtime.events(chat.id).some((e) => e.kind === 'notice' && e.text?.startsWith('A person cancelled the command')));

    // A cancelled run says nothing about how long the command takes, and is recorded as what it was
    assert.deepEqual(core.db.commandRuns('sleep').map((r) => r.outcome), ['cancelled']);
  } finally {
    core.shutdown();
  }
});

test('a call that is not a running command is refused, and so is a chat with no process', async () => {
  const { core, started } = setup();
  try {
    const chat = started('SLEEP 60');
    const { pid } = await sleeping(core, chat.id);
    await assert.rejects(core.chats.cancelCommand(chat.id, 'toolu_nope'), (err) => err instanceof ChatConflictError && /not a command that is running/.test(err.message));
    await assert.rejects(core.chats.cancelCommand('no-such-chat', 'toolu_nope'), /not found/);
    // Nothing was killed by the refusal
    assert.equal(alive(pid), true);
    assert.ok(descendantsOf(processTable(), pid).length >= 2);

    await core.chats.stop(chat.id);
    await core.runtime.exited(chat.id);
    await assert.rejects(core.chats.cancelCommand(chat.id, 'toolu_nope'), (err) => err instanceof ChatConflictError && /no live process/.test(err.message));
  } finally {
    core.shutdown();
  }
});

test('a command that ends well is recorded with how long it took, by kind', async () => {
  const { core, started } = setup();
  try {
    const chat = started('SLEEP 1');
    await until(() => core.db.commandRuns('sleep').length === 1 && core.db.commandRuns('sleep'), 'the run to be recorded');
    const [run] = core.db.commandRuns('sleep');
    assert.equal(run?.outcome, 'ok');
    assert.ok((run?.durationMs ?? 0) >= 900 && (run?.durationMs ?? 0) < 6000, `took ${String(run?.durationMs)} ms`);
    await until(() => core.runtime.get(chat.id)?.status === 'idle', 'the turn to end');
    // The same event twice (a replay) is one run, not two. `commandRuns` does not return the tool
    // use id, so the replay is told apart by a duration the real `sleep 1` above cannot produce
    core.db.recordCommand({ kind: 'sleep', chatId: chat.id, toolUseId: 'dup', startedAt: new Date().toISOString(), durationMs: 5, outcome: 'ok' });
    core.db.recordCommand({ kind: 'sleep', chatId: chat.id, toolUseId: 'dup', startedAt: new Date().toISOString(), durationMs: 7, outcome: 'error' });
    assert.equal(core.db.commandRuns('sleep').filter((r) => r.durationMs === 5).length, 1);
    assert.equal(core.db.commandRuns('sleep').some((r) => r.durationMs === 7), false);
  } finally {
    core.shutdown();
  }
});

test('longer than usual is measured on the history of the kind, with the fixed limit only until there is one', async () => {
  const { core, started } = setup();
  try {
    const chat = started('SLEEP 60');
    const { command } = await sleeping(core, chat.id);
    await until(() => core.runtime.pulse(chat.id)?.commands[0]?.heartbeat, 'the heartbeat');

    // Ninety seconds by the CLI's clock is no reason to worry about anything
    assert.deepEqual(core.health.read(chat.id, base).signals, []);

    // Four minutes later it has run about 5½ minutes: hung by the fixed three-minute limit, with no history
    const later = Date.now() + 4 * 60_000;
    const fallback = core.health.read(chat.id, base, later).signals[0];
    assert.equal(fallback?.kind, 'hung-command');
    assert.equal(fallback?.toolUseId, command.toolUseId);
    assert.match(fallback?.reason ?? '', /past the 3 min a command is expected to need/);
    assert.match(fallback?.hint ?? '', /run long commands under `timeout`/);

    // Six earlier runs that took 80 s say what is usual for it, and 5½ minutes is far past that
    for (let i = 0; i < 6; i++) {
      core.db.recordCommand({ kind: 'sleep', chatId: 'earlier', toolUseId: `earlier-${String(i)}`, startedAt: new Date().toISOString(), durationMs: 80_000 + i * 1000, outcome: 'ok' });
    }
    const measured = core.health.read(chat.id, base, later).signals[0];
    assert.equal(measured?.kind, 'hung-command');
    assert.match(measured?.reason ?? '', /commands like it usually take 83 s/);
    // The same age, when the history says it takes that long: nothing to say
    for (let i = 0; i < 6; i++) {
      core.db.recordCommand({ kind: 'sleep', chatId: 'longer', toolUseId: `longer-${String(i)}`, startedAt: new Date().toISOString(), durationMs: 600_000, outcome: 'ok' });
    }
    assert.deepEqual(core.health.read(chat.id, base, later).signals, []);
  } finally {
    core.shutdown();
  }
});

test('a failed or cancelled run does not teach what is usual', async () => {
  const { core } = setup();
  try {
    for (let i = 0; i < 8; i++) {
      core.db.recordCommand({ kind: 'pnpm e2e', chatId: 'c', toolUseId: `t${String(i)}`, startedAt: new Date().toISOString(), durationMs: 420_000, outcome: i % 2 ? 'error' : 'cancelled' });
    }
    assert.equal(core.health.usualOf('pnpm e2e'), null, 'eight hangs are not a history of what the command takes');
    for (let i = 0; i < 5; i++) {
      core.db.recordCommand({ kind: 'pnpm e2e', chatId: 'c', toolUseId: `ok${String(i)}`, startedAt: new Date().toISOString(), durationMs: 80_000, outcome: 'ok' });
    }
    assert.equal(core.health.usualOf('pnpm e2e')?.medianMs, 80_000);
  } finally {
    core.shutdown();
  }
});

test('a hint reaches a chat that is working as its next message, and is refused for one with no process', async () => {
  const { core, started } = setup();
  try {
    const chat = started('SLEEP 60');
    await sleeping(core, chat.id);
    await core.chats.hint(chat.id, { text: 'the e2e run hangs: is a connection left open?' });
    const said = core.runtime.events(chat.id).flatMap((e) => e.entry?.blocks ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : []));
    assert.ok(said.some((t) => t.startsWith('A hint from the person following this chat') && t.includes('is a connection left open?')));
    await assert.rejects(core.chats.hint(chat.id, { text: '   ' }), /text is required/);

    await core.chats.stop(chat.id);
    await core.runtime.exited(chat.id);
    await assert.rejects(core.chats.hint(chat.id, { text: 'hello' }), (err) => err instanceof ChatConflictError && /no live process/.test(err.message));
    await assert.rejects(core.chats.hint('no-such-chat', { text: 'hello' }), /not found/);
  } finally {
    core.shutdown();
  }
});

test('the feed hears of a chat that looks stuck once, of a change in how it looks, and of its recovery', async () => {
  const { core, started } = setup();
  const events: Extract<AgentryEvent, { type: 'health.changed' }>[] = [];
  const monitor = new HealthMonitor(
    {
      runtime: core.runtime,
      health: core.health,
      emit: (event) => {
        if (event.type === 'health.changed') events.push({ ...event, id: events.length + 1, at: new Date().toISOString() });
      },
      taskOf: () => null,
    },
    0,
  );
  try {
    const chat = started('SLEEP 60');
    await sleeping(core, chat.id);
    await until(() => core.runtime.pulse(chat.id)?.commands[0]?.heartbeat, 'the heartbeat');

    monitor.check();
    assert.equal(events.length, 0, 'a command that has run for ninety seconds is not news');

    monitor.check(Date.now() + 4 * 60_000);
    monitor.check(Date.now() + 4 * 60_000 + 1000);
    assert.equal(events.length, 1, 'one event however many times it is looked at');
    const [stuck] = events;
    assert.equal(stuck?.level, 'warn');
    assert.equal(stuck?.previousLevel, 'ok');
    assert.deepEqual(stuck?.signals, ['hung-command']);
    assert.equal(stuck?.runId, chat.id);
    assert.equal(stuck?.taskId, null);
    assert.match(stuck?.reason ?? '', /`sleep 60` has been running for/);
    assert.equal(stuck?.title.startsWith(`${core.runtime.get(chat.id)?.name}:`), true);

    // Worse is news again
    monitor.check(Date.now() + 12 * 60_000);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.level, 'bad');
    assert.equal(events[1]?.previousLevel, 'warn');

    // Once the chat has no process it is not stuck any more, and the feed is told so
    await core.chats.stop(chat.id);
    await core.runtime.exited(chat.id);
    monitor.check(Date.now() + 12 * 60_000);
    assert.equal(events.length, 3);
    assert.equal(events[2]?.level, 'ok');
    assert.deepEqual(events[2]?.signals, []);
    monitor.check(Date.now() + 13 * 60_000);
    assert.equal(events.length, 3, 'and only once');
  } finally {
    monitor.stop();
    core.shutdown();
  }
});
