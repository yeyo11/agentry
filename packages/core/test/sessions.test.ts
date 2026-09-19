import assert from 'node:assert/strict';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isLiveCliSession } from '../src/cli.ts';
import { Locator } from '../src/locations.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

const line = (o: object) => JSON.stringify(o);

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
  assert.equal(byId.done?.source, 'cli');
  assert.equal(byId.done?.sessionId, sid);
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
