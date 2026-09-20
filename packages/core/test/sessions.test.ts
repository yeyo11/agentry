import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isLiveCliSession } from '../src/cli.ts';
import { Locator } from '../src/locations.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

const line = (o: object) => JSON.stringify(o);

test('reads a transcript in windows, newest first, without gaps or overlap', async () => {
  const config = tempConfig();
  const dir = join(config.projectsDir, '-work-long');
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 25 }, (_, i) =>
    line({ type: 'user', uuid: `u${i}`, timestamp: '2026-01-01T10:00:00Z', cwd: '/work/long', message: { role: 'user', content: `message ${i}` } }),
  );
  writeFileSync(join(dir, 'bbbb-2222.jsonl'), lines.join('\n'));
  const store = new SessionStore(config);

  // No `before`: the newest page, and what is still above it
  const tail = await store.getSession('bbbb-2222', { limit: 10 });
  assert.equal(tail?.total, 25);
  assert.equal(tail?.from, 15);
  assert.deepEqual(tail?.entries.map((e) => e.uuid), Array.from({ length: 10 }, (_, i) => `u${15 + i}`));

  // Reading backwards from a page's `from` gives exactly the entries before it
  const middle = await store.getSession('bbbb-2222', { limit: 10, before: tail?.from });
  assert.equal(middle?.from, 5);
  assert.deepEqual(middle?.entries.map((e) => e.uuid), Array.from({ length: 10 }, (_, i) => `u${5 + i}`));

  // A short first page stops at the start
  const head = await store.getSession('bbbb-2222', { limit: 10, before: middle?.from });
  assert.equal(head?.from, 0);
  assert.equal(head?.entries.length, 5);

  // The three pages together are the whole transcript, in order and read once each
  const all = [...(head?.entries ?? []), ...(middle?.entries ?? []), ...(tail?.entries ?? [])];
  assert.deepEqual(all.map((e) => e.uuid), lines.map((_, i) => `u${i}`));

  // A limit beyond the end, and a `before` past it, stay in bounds
  assert.equal((await store.getSession('bbbb-2222', { limit: 9999 }))?.entries.length, 25);
  assert.equal((await store.getSession('bbbb-2222', { limit: 10, before: 0 }))?.entries.length, 0);
  assert.equal((await store.getSession('bbbb-2222', { limit: 10, before: 999 }))?.total, 25);
});

const entryLine = (uuid: string, extra: object = {}) =>
  line({ type: 'user', uuid, timestamp: '2026-01-01T10:00:00Z', cwd: '/work/idx', message: { role: 'user', content: `message ${uuid}` }, ...extra });
const uuids = (detail: { entries: { uuid: string }[] } | null | undefined) => detail?.entries.map((e) => e.uuid);

function indexedSession(): { store: SessionStore; file: string } {
  const config = tempConfig();
  const dir = join(config.projectsDir, '-work-idx');
  mkdirSync(dir, { recursive: true });
  return { store: new SessionStore(config), file: join(dir, 'cccc-3333.jsonl') };
}

test('pages through the index, skipping lines that are not entries', async () => {
  const { store, file } = indexedSession();
  // Non-entry lines between the messages, and a line past the one-megabyte read chunk
  const lines = [line({ type: 'mode', mode: 'normal' })];
  for (let i = 0; i < 30; i++) {
    lines.push(entryLine(`u${i}`, i === 12 ? { message: { role: 'user', content: 'x'.repeat(1_500_000) } } : {}));
    lines.push(line({ type: 'file-history-snapshot', snapshot: { n: i } }), '', '{"broken');
  }
  writeFileSync(file, `${lines.join('\n')}\n`);

  const seen: string[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await store.getSession('cccc-3333', { limit: 7, before });
    assert.equal(page?.total, 30);
    seen.unshift(...(uuids(page) ?? []));
    if (!page || page.from === 0) break;
    before = page.from;
  }
  assert.deepEqual(seen, Array.from({ length: 30 }, (_, i) => `u${i}`));
  const big = await store.getSession('cccc-3333', { limit: 1, before: 13 });
  assert.equal(big?.entries[0]?.blocks[0]?.type === 'text' && big.entries[0].blocks[0].text.length, 1_500_000);
});

test('a session that grows is read on from where the index stopped', async () => {
  const { store, file } = indexedSession();
  writeFileSync(file, `${[entryLine('a'), entryLine('b')].join('\n')}\n`);
  assert.deepEqual(uuids(await store.getSession('cccc-3333')), ['a', 'b']);

  // An edit in place, far from the end, that only a pass from the start would see
  const handle = await open(file, 'r+');
  await handle.write('/work/xdi', readFileSync(file, 'utf8').indexOf('/work/idx'));
  await handle.close();
  appendFileSync(file, `${[entryLine('c'), line({ type: 'custom-title', customTitle: 'Renamed' }), entryLine('d')].join('\n')}\n`);
  const grown = await store.getSession('cccc-3333', { limit: 3 });
  assert.equal(grown?.total, 4);
  assert.equal(grown?.from, 1);
  assert.deepEqual(uuids(grown), ['b', 'c', 'd']);
  // The summary is carried on too, not just the entries
  assert.equal(grown?.summary.messageCount, 4);
  assert.equal(grown?.summary.title, 'Renamed');
  assert.equal(grown?.summary.projectPath, '/work/idx');
  assert.deepEqual(uuids(await store.getSession('cccc-3333', { limit: 2, before: 2 })), ['a', 'b']);
});

test('a rewritten transcript is indexed again', async () => {
  const { store, file } = indexedSession();
  writeFileSync(file, `${[entryLine('a'), entryLine('b'), entryLine('c')].join('\n')}\n`);
  assert.equal((await store.getSession('cccc-3333'))?.total, 3);

  // Shorter than before
  writeFileSync(file, `${entryLine('x')}\n`);
  assert.deepEqual(uuids(await store.getSession('cccc-3333')), ['x']);

  // Longer than before, but not by appending: what was indexed is no longer where it was
  writeFileSync(file, `${[entryLine('p', { cwd: '/work/rewritten' }), entryLine('q'), entryLine('r'), entryLine('s')].join('\n')}\n`);
  const rewritten = await store.getSession('cccc-3333');
  assert.deepEqual(uuids(rewritten), ['p', 'q', 'r', 's']);
  assert.equal(rewritten?.summary.projectPath, '/work/rewritten');
  assert.equal(rewritten?.summary.messageCount, 4);
});

test('a half-written last line counts once it parses, and only once', async () => {
  const { store, file } = indexedSession();
  const last = entryLine('c');
  writeFileSync(file, `${[entryLine('a'), entryLine('b')].join('\n')}\n${last.slice(0, 20)}`);
  assert.deepEqual(uuids(await store.getSession('cccc-3333')), ['a', 'b']);

  // Complete JSON, still without its newline: read, but not yet final
  appendFileSync(file, last.slice(20));
  const complete = await store.getSession('cccc-3333');
  assert.deepEqual(uuids(complete), ['a', 'b', 'c']);
  assert.equal(complete?.summary.messageCount, 3);

  // Its newline and the next line: the tail is indexed for good, and not counted twice
  appendFileSync(file, `\n${entryLine('d')}\n`);
  const after = await store.getSession('cccc-3333');
  assert.deepEqual(uuids(after), ['a', 'b', 'c', 'd']);
  assert.equal(after?.summary.messageCount, 4);
});

test('the index serves the main thread and the one with sidechains', async () => {
  const { store, file } = indexedSession();
  const lines = Array.from({ length: 12 }, (_, i) => entryLine(`m${i}`, i % 3 === 2 ? { isSidechain: true } : {}));
  writeFileSync(file, `${lines.join('\n')}\n${entryLine('side-tail', { isSidechain: true })}`);

  const main = await store.getSession('cccc-3333', { limit: 3 });
  assert.equal(main?.total, 8);
  assert.deepEqual(uuids(main), ['m7', 'm9', 'm10']);
  assert.deepEqual(uuids(await store.getSession('cccc-3333', { limit: 3, before: main?.from })), ['m3', 'm4', 'm6']);

  const all = await store.getSession('cccc-3333', { limit: 3, includeSidechains: true });
  assert.equal(all?.total, 13);
  assert.deepEqual(uuids(all), ['m10', 'm11', 'side-tail']);
  assert.deepEqual(uuids(await store.getSession('cccc-3333', { limit: 3, before: all?.from, includeSidechains: true })), ['m7', 'm8', 'm9']);
  assert.equal(all?.summary.messageCount, 8);
});

test('summarizes sessions and reads transcripts', async () => {
  const config = tempConfig();
  const dir = join(config.projectsDir, '-work-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'aaaa-1111.jsonl'),
    [
      line({ type: 'mode', mode: 'normal' }),
      line({ type: 'user', uuid: '1', timestamp: '2026-01-01T10:00:00Z', cwd: '/work/demo', gitBranch: 'main', version: '2.1.0', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      line({ type: 'user', uuid: '2', timestamp: '2026-01-01T10:00:01Z', cwd: '/work/demo', message: { role: 'user', content: 'Fix the login bug\nplease' } }),
      line({ type: 'assistant', uuid: '3', timestamp: '2026-01-01T10:00:05Z', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'On it' }] } }),
      line({ type: 'assistant', uuid: '4', isSidechain: true, timestamp: '2026-01-01T10:00:06Z', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
      '{"broken json',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'empty-0000.jsonl'), line({ type: 'mode', mode: 'normal' }));

  const store = new SessionStore(config);
  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1); // sessions without messages are hidden
  const [s] = sessions;
  assert.equal(s?.title, 'Fix the login bug'); // synthetic <command> message skipped
  assert.equal(s?.messageCount, 3); // sidechain not counted
  assert.equal(s?.projectPath, '/work/demo');
  assert.equal(s?.model, 'claude-sonnet');
  assert.equal(s?.gitBranch, 'main');
  assert.equal(s?.updatedAt, '2026-01-01T10:00:06Z');

  const projects = await store.listProjects();
  assert.deepEqual(projects.map((p) => [p.id, p.path, p.name, p.sessionCount]), [['-work-demo', '/work/demo', 'demo', 1]]);

  assert.equal((await store.getSession('aaaa-1111'))?.entries.length, 3);
  assert.equal((await store.getSession('aaaa-1111', { includeSidechains: true }))?.entries.length, 4);
  assert.equal(await store.getSession('missing'), null);
  await assert.rejects(store.deleteSession('missing'), /not found/);
  assert.equal(await store.getSession('../../etc/passwd'), null);

  await store.deleteSession('aaaa-1111');
  assert.deepEqual(await store.listSessions(), []);
});

test('a spare session is one with a transcript but no user turn', async () => {
  const config = tempConfig();
  const dir = join(config.projectsDir, '-work-spare');
  mkdirSync(dir, { recursive: true });
  // What `claude attach` leaves behind: the slash command that spawned it and nothing else
  writeFileSync(
    join(dir, 'bbbb-2222.jsonl'),
    [
      line({ type: 'user', uuid: '1', timestamp: '2026-01-01T10:00:00Z', cwd: '/work/spare', message: { role: 'user', content: '<command-name>/resume</command-name>' } }),
      line({ type: 'user', uuid: '2', timestamp: '2026-01-01T10:00:01Z', cwd: '/work/spare', message: { role: 'user', content: '<local-command-stdout>(no content)</local-command-stdout>' } }),
    ].join('\n'),
  );

  const store = new SessionStore(config);
  const spare = await store.summary('bbbb-2222');
  assert.equal(spare?.firstPrompt, null); // the signature the liveness rule keys on
  assert.equal(spare?.messageCount, 2); // it is not empty, so the store still lists it
  assert.equal(spare?.title, '/resume'); // the command that spawned it, not its own uuid
  assert.equal(await store.summary('nope-9999'), null);
});

test('only a session someone is working in counts as live', () => {
  const real = { firstPrompt: 'Fix the login bug' };
  const spare = { firstPrompt: null };

  assert.equal(isLiveCliSession({}, real), true);
  assert.equal(isLiveCliSession({ state: 'blocked' }, real), true);
  // A process the CLI itself reports as finished, whatever its transcript says
  assert.equal(isLiveCliSession({ state: 'done' }, real), false);
  // The pre-warmed spare: a session id, a transcript, and nobody in it
  assert.equal(isLiveCliSession({ state: 'blocked' }, spare), false);
  // No transcript yet proves nothing: a session seconds old must not be dropped
  assert.equal(isLiveCliSession({}, null), true);
});

test('a CLI session\'s background agents are read from its files, with their real state', async () => {
  const config = tempConfig();
  const project = join(config.projectsDir, '-work-agents');
  const sid = 'cccc-3333';
  const agents = join(project, sid, 'subagents');
  mkdirSync(agents, { recursive: true });

  const notify = (id: string, status: string, at: string) =>
    line({
      type: 'user',
      uuid: `n-${id}-${at}`,
      timestamp: at,
      message: { role: 'user', content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>` },
    });
  const launch = (id: string, at: string) =>
    line({ type: 'user', uuid: `l-${id}`, timestamp: at, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } });

  writeFileSync(
    join(project, `${sid}.jsonl`),
    [
      line({ type: 'user', uuid: 'u0', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'Fan out' } }),
      launch('done', '2026-01-01T10:00:01Z'),
      launch('busy', '2026-01-01T10:00:02Z'),
      launch('back', '2026-01-01T10:00:03Z'),
      notify('done', 'completed', '2026-01-01T10:05:00Z'),
      notify('back', 'completed', '2026-01-01T10:06:00Z'),
    ].join('\n'),
  );
  for (const [id, description, mtime] of [
    ['done', 'Finished', '2026-01-01T10:04:59Z'], // wrote just before it stopped
    ['busy', 'Still going', '2026-01-01T10:07:00Z'], // never stopped
    ['back', 'Resumed', '2026-01-01T10:09:00Z'], // stopped, then wrote again
  ] as const) {
    writeFileSync(join(agents, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'fork', description, toolUseId: `toolu_${id}` }));
    const file = join(agents, `agent-${id}.jsonl`);
    // `busy` was started with isolation: worktree, so it works in a worktree of its own
    const cwd = id === 'busy' ? '/work/agents/.claude/worktrees/agent-busy' : '/work/agents';
    writeFileSync(file, line({ type: 'assistant', uuid: `a-${id}`, cwd, message: { role: 'assistant', content: [] } }));
    const when = new Date(mtime);
    utimesSync(file, when, when);
  }

  const byId = Object.fromEntries((await new SessionStore(config).subagents(sid)).map((a) => [a.agentId, a]));
  assert.equal(byId.done?.status, 'completed');
  assert.equal(byId.done?.endedAt, '2026-01-01T10:05:00Z');
  assert.equal(byId.busy?.status, 'running');
  // The CLI can resume an agent after it stopped: writing after the notification means it is back
  assert.equal(byId.back?.status, 'running');
  assert.equal(byId.back?.endedAt, null);
  assert.equal(byId.done?.startedAt, '2026-01-01T10:00:01Z');
  // Each agent's own directory, not its parent session's
  assert.equal(byId.done?.cwd, '/work/agents');
  assert.equal(byId.busy?.cwd, '/work/agents/.claude/worktrees/agent-busy');
  const where = new Locator().locate(byId.busy?.cwd ?? '');
  assert.equal(where.projectPath, '/work/agents');
  assert.equal(where.worktree?.name, 'agent-busy');
  assert.deepEqual(await new SessionStore(config).subagents('no-such-session'), []);
});

test('background commands are read from the transcript, including ones stopped on request', async () => {
  const config = tempConfig();
  const projectId = '-work-tasks';
  const project = join(config.projectsDir, projectId);
  mkdirSync(project, { recursive: true });
  const sid = 'dddd-4444';

  const bash = (id: string, command: string, description: string) =>
    line({ type: 'assistant', uuid: `u-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input: { command, description } }] } });
  const launched = (id: string, at: string, byUser = false) =>
    line({
      type: 'user',
      uuid: `r-${id}`,
      timestamp: at,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: '' }] },
      toolUseResult: { backgroundTaskId: id, backgroundedByUser: byUser },
    });

  writeFileSync(
    join(project, `${sid}.jsonl`),
    [
      line({ type: 'user', uuid: 'u0', timestamp: '2026-01-01T09:00:00Z', message: { role: 'user', content: 'Build it' } }),
      bash('build', 'pnpm build', 'Build the app'),
      launched('build', '2026-01-01T09:00:01Z', true),
      bash('serve', 'pnpm dev', 'Start the dev server'),
      launched('serve', '2026-01-01T09:00:02Z'),
      bash('watch', 'pnpm test --watch', 'Watch the tests'),
      launched('watch', '2026-01-01T09:00:03Z'),
      line({
        type: 'user',
        uuid: 'n1',
        timestamp: '2026-01-01T09:02:00Z',
        message: { role: 'user', content: '<task-notification>\n<task-id>build</task-id>\n<status>completed</status>\n<summary>Build done</summary>\n</task-notification>' },
      }),
      // TaskStop leaves only its own result behind, never a notification
      line({ type: 'user', uuid: 's1', timestamp: '2026-01-01T09:03:00Z', toolUseResult: { message: 'Successfully stopped task: serve (pnpm dev)', task_id: 'serve', task_type: 'local_bash' } }),
    ].join('\n'),
  );

  const store = new SessionStore(config);
  const byId = Object.fromEntries((await store.backgroundTasks(sid, true)).map((t) => [t.id, t]));
  assert.equal(byId.build?.status, 'completed');
  assert.equal(byId.build?.summary, 'Build done');
  assert.equal(byId.build?.command, 'pnpm build');
  assert.equal(byId.build?.backgroundedByUser, true);
  // Without this it read as running for as long as the session lived
  assert.equal(byId.serve?.status, 'stopped');
  assert.equal(byId.watch?.status, 'running');

  // The same command, with its session gone, cannot still be running
  const ended = Object.fromEntries((await store.backgroundTasks(sid, false)).map((t) => [t.id, t]));
  assert.equal(ended.watch?.status, 'stopped');
});

test('monitors are read from the transcript, which names their task differently', async () => {
  const config = tempConfig();
  const project = join(config.projectsDir, '-work-monitors');
  mkdirSync(project, { recursive: true });
  const sid = 'mmmm-7777';

  const monitor = (id: string, input: object) =>
    line({ type: 'assistant', uuid: `u-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Monitor', input }] } });
  // Shape captured from CLI 2.1.278: `taskId`, not the `backgroundTaskId` of a backgrounded Bash call
  const started = (id: string, at: string, timeoutMs: number, persistent = false) =>
    line({
      type: 'user',
      uuid: `r-${id}`,
      timestamp: at,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Monitor started (task ${id})` }] },
      toolUseResult: { taskId: id, timeoutMs, persistent },
    });
  const recent = new Date(Date.now() - 60_000).toISOString();

  writeFileSync(
    join(project, `${sid}.jsonl`),
    [
      line({ type: 'user', uuid: 'u0', timestamp: '2026-01-01T09:00:00Z', message: { role: 'user', content: 'Watch CI' } }),
      monitor('ci', { command: 'gh pr checks 50 --watch', description: 'CI checks on PR #50' }),
      started('ci', '2026-01-01T09:00:01Z', 1_800_000),
      line({
        type: 'user',
        uuid: 'n1',
        timestamp: '2026-01-01T09:05:00Z',
        message: { role: 'user', content: '<task-notification>\n<task-id>ci</task-id>\n<status>completed</status>\n<summary>Monitor "CI checks on PR #50" ended</summary>\n</task-notification>' },
      }),
      monitor('logs', { command: 'tail -f app.log', description: 'App errors', persistent: true }),
      started('logs', '2026-01-01T09:06:00Z', 0, true),
      // Timed out long ago and nothing in the transcript says so
      monitor('old', { command: 'watch-deploy', description: 'Deploy' }),
      started('old', '2026-01-01T09:07:00Z', 300_000),
      monitor('now', { command: 'watch-queue', description: 'Queue depth' }),
      started('now', recent, 1_800_000),
      // A result carrying `taskId` from some other tool is not a monitor launch
      line({ type: 'user', uuid: 'x1', timestamp: '2026-01-01T09:08:00Z', toolUseResult: { taskId: 'other' } }),
    ].join('\n'),
  );

  const store = new SessionStore(config);
  const tasks = await store.backgroundTasks(sid, true);
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(byId).sort(), ['ci', 'logs', 'now', 'old']);
  assert.equal(byId.ci?.type, 'monitor');
  assert.equal(byId.ci?.status, 'completed');
  assert.equal(byId.ci?.description, 'CI checks on PR #50');
  assert.equal(byId.ci?.command, 'gh pr checks 50 --watch');
  assert.equal(byId.logs?.status, 'running'); // persistent: no timeout to run out
  assert.equal(byId.now?.status, 'running');
  assert.equal(byId.old?.status, 'stopped');
  assert.equal(byId.old?.endedAt, '2026-01-01T09:12:00.000Z');
});

test('a task output is read from the CLI temp dir and never from a path found in a transcript', async () => {
  const config = tempConfig();
  const projectId = '-work-output';
  mkdirSync(join(config.projectsDir, projectId), { recursive: true });
  const sid = `eeee-${String(process.pid)}`;
  writeFileSync(join(config.projectsDir, projectId, `${sid}.jsonl`), line({ type: 'user', uuid: 'u', timestamp: '2026-01-01T09:00:00Z', message: { role: 'user', content: 'go' } }));

  const dir = join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, projectId, sid, 'tasks');
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'job.output'), `${'x'.repeat(70 * 1024)}\nall 6 spec file(s) passed\n`);
    const store = new SessionStore(config);
    const out = await store.taskOutput(sid, 'job');
    // Only the end of a long output: the part that says how it finished
    assert.equal(out.truncated, true);
    assert.match(out.output, /all 6 spec file\(s\) passed/);

    for (const bad of ['../../etc/passwd', 'a/b', '..']) {
      await assert.rejects(store.taskOutput(sid, bad), /invalid task id/);
    }
    await assert.rejects(store.taskOutput(sid, 'missing'), /no output was kept/);
  } finally {
    rmSync(join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, projectId), { recursive: true, force: true });
  }
});
