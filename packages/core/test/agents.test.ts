import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Core } from '../src/index.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

// Synthetic sessions laid out as the CLI keeps them: `<session>.jsonl` with a directory of the same
// name beside it. `agent-session` holds a subagent that launched a background command;
// `workflow-session` is a recording of a workflow run with two agents.
const AGENT_SESSION = fileURLToPath(new URL('./fixtures/agent-session', import.meta.url));
const WORKFLOW_SESSION = fileURLToPath(new URL('./fixtures/workflow-session', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

const PROJECT = '-work-demo';
const AGENT = 'a1b2c3d4e5f60718';
const WF_RUN = 'wf_5c79d6c0-b39';
const WF_AGENT = 'a4fdeef8a7b5856b5';
const line = (o: object) => JSON.stringify(o);

/** The main transcript: it launched the subagent and was told when it stopped, but not what it did. */
function installSession(projectsDir: string, sessionId: string): void {
  mkdirSync(join(projectsDir, PROJECT), { recursive: true });
  writeFileSync(
    join(projectsDir, PROJECT, `${sessionId}.jsonl`),
    [
      line({ type: 'user', uuid: 'm1', timestamp: '2026-01-01T10:00:00.000Z', cwd: '/work/demo', message: { role: 'user', content: 'survey the build' } }),
      line({ type: 'assistant', uuid: 'm2', timestamp: '2026-01-01T10:00:00.200Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_explore01', name: 'Agent', input: { description: 'Survey the build scripts', subagent_type: 'Explore' } }] } }),
      line({ type: 'user', uuid: 'm3', timestamp: '2026-01-01T10:00:00.500Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_explore01', content: 'Async agent launched' }] }, toolUseResult: { agentId: AGENT } }),
      line({ type: 'user', uuid: 'm4', timestamp: '2026-01-01T10:00:30.000Z', message: { role: 'user', content: `<task-notification><task-id>${AGENT}</task-id><status>completed</status><summary>done</summary></task-notification>` } }),
    ].join('\n'),
  );
  const dir = join(projectsDir, PROJECT, sessionId);
  cpSync(AGENT_SESSION, dir, { recursive: true });
  cpSync(WORKFLOW_SESSION, dir, { recursive: true });
  // The agent stopped when its parent was told; a write later than that would read as a resume
  const stopped = new Date('2026-01-01T10:00:30.000Z');
  utimesSync(join(dir, 'subagents', `agent-${AGENT}.jsonl`), stopped, stopped);
}

test('a subagent is read with its prompt, outcome, usage, result and the tasks it launched', async () => {
  const config = tempConfig();
  installSession(config.projectsDir, 'sess-agents');
  const store = new SessionStore(config);

  const detail = await store.agentTranscript('sess-agents', AGENT, { live: true });
  assert.ok(detail);
  assert.equal(detail.kind, 'subagent');
  assert.equal(detail.workflowRunId, null);
  assert.equal(detail.subagentType, 'Explore');
  assert.equal(detail.description, 'Survey the build scripts');
  assert.equal(detail.prompt, 'List the build scripts in package.json and keep a watcher running.');
  assert.equal(detail.status, 'completed');
  assert.equal(detail.background, false);
  // Launch time comes from the parent, the end from its notification
  assert.equal(detail.startedAt, '2026-01-01T10:00:00.500Z');
  assert.equal(detail.endedAt, '2026-01-01T10:00:30.000Z');
  assert.equal(detail.durationMs, 29_500);
  assert.equal(detail.model, 'claude-haiku-4-5-20251001');
  assert.equal(detail.cwd, '/work/demo');
  assert.equal(detail.result, 'Found 3 build scripts: build, test, watch.');
  assert.equal(detail.toolCalls, 1);
  // msg_one is written as two lines carrying the same usage: it counts once, with its final figures
  assert.deepEqual(detail.usage, { input: 22, output: 60, cacheRead: 230, cacheCreation: 20, total: 332 });

  assert.equal(detail.total, 5);
  assert.equal(detail.from, 0);
  assert.deepEqual(detail.entries.map((e) => e.role), ['user', 'assistant', 'assistant', 'user', 'assistant']);
  assert.ok(detail.entries.every((e) => e.isSidechain));

  // Launched in the subagent's own transcript, which is the only place that says who owns it
  assert.deepEqual(detail.tasks.map((t) => [t.id, t.ownerId, t.command]), [['bg-sub-1', AGENT, 'npm run watch']]);
});

test('`after` returns only the entries appended since, and starts over when it points past the end', async () => {
  const config = tempConfig();
  installSession(config.projectsDir, 'sess-agents');
  const store = new SessionStore(config);

  const tail = await store.agentTranscript('sess-agents', AGENT, { after: 3 });
  assert.equal(tail?.from, 3);
  assert.equal(tail?.total, 5);
  assert.deepEqual(tail?.entries.map((e) => e.role), ['user', 'assistant']);

  assert.equal((await store.agentTranscript('sess-agents', AGENT, { after: 5 }))?.entries.length, 0);
  // The transcript shrank under the reader (a different agent, a rewrite): the caller must resync
  const past = await store.agentTranscript('sess-agents', AGENT, { after: 99 });
  assert.equal(past?.from, 0);
  assert.equal(past?.entries.length, 5);
});

test('an agent that wrote after its stop notification is running again, and stopped once its session is gone', async () => {
  const config = tempConfig();
  installSession(config.projectsDir, 'sess-agents');
  const transcript = join(config.projectsDir, PROJECT, 'sess-agents', 'subagents', `agent-${AGENT}.jsonl`);
  const later = new Date('2026-01-01T10:05:00.000Z');
  utimesSync(transcript, later, later);
  const store = new SessionStore(config);

  const resumed = await store.agentTranscript('sess-agents', AGENT, { live: true });
  assert.equal(resumed?.status, 'running');
  assert.equal(resumed?.endedAt, null);
  assert.equal(resumed?.durationMs, null);

  const orphaned = await store.agentTranscript('sess-agents', AGENT, { live: false });
  assert.equal(orphaned?.status, 'stopped');
  assert.equal(orphaned?.endedAt, later.toISOString());
});

test('a workflow agent is read from the run directory, with its state from the run record', async () => {
  const config = tempConfig();
  installSession(config.projectsDir, 'sess-agents');
  const store = new SessionStore(config);

  const detail = await store.agentTranscript('sess-agents', WF_AGENT, { runId: WF_RUN, live: false });
  assert.ok(detail);
  assert.equal(detail.kind, 'workflow');
  assert.equal(detail.workflowRunId, WF_RUN);
  assert.equal(detail.subagentType, 'workflow-subagent');
  assert.equal(detail.description, 'one');
  assert.equal(detail.workflowPhase, 'Say');
  assert.equal(detail.prompt, 'Reply with only the word');
  assert.equal(detail.status, 'completed');
  assert.equal(detail.durationMs, 1669);
  assert.equal(detail.startedAt, new Date(1789817315523).toISOString());
  assert.equal(detail.endedAt, new Date(1789817315523 + 1669).toISOString());
  assert.equal(detail.result, 'red');
  assert.equal(detail.total, 2);
  assert.deepEqual(detail.tasks, []);

  // The same agent id under the plain subagents directory is not there: they are different places
  assert.equal(await store.agentTranscript('sess-agents', WF_AGENT), null);
});

test('a workflow agent of a run without a record is running until its journal has a result', async () => {
  const config = tempConfig();
  installSession(config.projectsDir, 'sess-agents');
  const dir = join(config.projectsDir, PROJECT, 'sess-agents');
  rmSync(join(dir, 'workflows', `${WF_RUN}.json`));
  writeFileSync(
    join(dir, 'subagents', 'workflows', WF_RUN, 'journal.jsonl'),
    [
      line({ type: 'started', agentId: WF_AGENT, label: 'one', phase: 'Say' }),
      line({ type: 'started', agentId: 'a6d120918f0c2d6c5', label: 'two', phase: 'Say' }),
      line({ type: 'result', agentId: 'a6d120918f0c2d6c5', result: 'blue' }),
    ].join('\n'),
  );
  const store = new SessionStore(config);

  assert.equal((await store.agentTranscript('sess-agents', WF_AGENT, { runId: WF_RUN, live: true }))?.status, 'running');
  assert.equal((await store.agentTranscript('sess-agents', WF_AGENT, { runId: WF_RUN, live: false }))?.status, 'stopped');
  assert.equal((await store.agentTranscript('sess-agents', 'a6d120918f0c2d6c5', { runId: WF_RUN, live: true }))?.status, 'completed');
});

test('agent ids never leave the agent directories', async () => {
  const config = tempConfig();
  installSession(config.projectsDir, 'sess-agents');
  const store = new SessionStore(config);

  for (const bad of ['../../sess-agents', 'a/b', '..', 'a.b', '']) {
    await assert.rejects(store.agentTranscript('sess-agents', bad), /invalid agent id/);
  }
  for (const bad of ['../x', 'wf_../x', 'notworkflow', 'wf_a/b']) {
    await assert.rejects(store.agentTranscript('sess-agents', AGENT, { runId: bad }), /invalid workflow run id/);
  }
  // Well-formed but absent: null, which the API reports as a 404
  assert.equal(await store.agentTranscript('sess-agents', 'ffffffffffffffff'), null);
  assert.equal(await store.agentTranscript('sess-agents', AGENT, { runId: 'wf_nope' }), null);
  assert.equal(await store.agentTranscript('no-such-session', AGENT), null);
});

test('a task a subagent launched is listed with its owner, and its stop can come from the subagent', async () => {
  const config = tempConfig();
  installSession(config.projectsDir, 'sess-agents');
  const store = new SessionStore(config);

  const tasks = await store.backgroundTasks('sess-agents', true);
  assert.deepEqual(tasks.map((t) => [t.id, t.status, t.fromSubagent, t.ownerAgentId, t.sessionId]), [['bg-sub-1', 'running', true, AGENT, 'sess-agents']]);
  assert.equal((await store.backgroundTasks('sess-agents', false))[0]?.status, 'stopped');
  assert.deepEqual([...(await store.taskOwners('sess-agents'))], [['bg-sub-1', AGENT]]);

  // Told to the subagent that started it, not to the session
  const own = join(config.projectsDir, PROJECT, 'sess-agents', 'subagents', `agent-${AGENT}.jsonl`);
  writeFileSync(own, `${line({ type: 'user', uuid: 'n1', timestamp: '2026-01-01T10:01:00.000Z', message: { role: 'user', content: '<task-notification><task-id>bg-sub-1</task-id><status>completed</status><summary>watcher exited</summary></task-notification>' } })}\n`, { flag: 'a' });
  const [done] = await store.backgroundTasks('sess-agents', true);
  assert.equal(done?.status, 'completed');
  assert.equal(done?.summary, 'watcher exited');
});

/** A task output as the CLI keeps it, in a temp dir of its own so tests never meet the real ones. */
function taskOutputDir(config: ReturnType<typeof tempConfig>, sessionId: string): { dir: string; cleanup: () => void } {
  const projectId = `${PROJECT}-out-${String(process.pid)}`;
  mkdirSync(join(config.projectsDir, projectId), { recursive: true });
  writeFileSync(join(config.projectsDir, projectId, `${sessionId}.jsonl`), line({ type: 'user', uuid: 'u', timestamp: '2026-01-01T09:00:00Z', message: { role: 'user', content: 'go' } }));
  const root = join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, projectId);
  const dir = join(root, sessionId, 'tasks');
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a running task output is followed by passing back the offset of the last read', async () => {
  const config = tempConfig();
  const sid = `follow-${String(process.pid)}`;
  const { dir, cleanup } = taskOutputDir(config, sid);
  try {
    const file = join(dir, 'job.output');
    writeFileSync(file, 'first\n');
    const store = new SessionStore(config);

    const whole = await store.taskOutput(sid, 'job');
    assert.deepEqual([whole.output, whole.offset, whole.bytes, whole.truncated], ['first\n', 6, 6, false]);

    // Nothing new: an empty read that keeps the offset
    const idle = await store.taskOutput(sid, 'job', { offset: whole.offset });
    assert.deepEqual([idle.output, idle.offset, idle.truncated], ['', 6, false]);

    writeFileSync(file, 'second\n', { flag: 'a' });
    const next = await store.taskOutput(sid, 'job', { offset: whole.offset });
    assert.deepEqual([next.output, next.offset, next.bytes], ['second\n', 13, 13]);
    // A resumed read is not "the end of a longer output": the caller already has the start
    assert.equal(next.truncated, false);
    assert.equal(next.reset, undefined);

    // The file was replaced by a shorter one: start over from what is there
    writeFileSync(file, 'new\n');
    const reset = await store.taskOutput(sid, 'job', { offset: next.offset });
    assert.deepEqual([reset.output, reset.offset, reset.reset], ['new\n', 4, true]);
  } finally {
    cleanup();
  }
});

test('a read that stops inside a multi-byte character leaves it for the next one', async () => {
  const config = tempConfig();
  const sid = `utf8-${String(process.pid)}`;
  const { dir, cleanup } = taskOutputDir(config, sid);
  try {
    const bytes = Buffer.from('ok ✓ done', 'utf8'); // ✓ is three bytes
    const file = join(dir, 'job.output');
    // The writer has flushed only the first two bytes of the check mark
    writeFileSync(file, bytes.subarray(0, 5));
    const store = new SessionStore(config);
    const first = await store.taskOutput(sid, 'job');
    assert.equal(first.output, 'ok ');
    assert.equal(first.offset, 3);
    assert.equal(first.bytes, 5);

    writeFileSync(file, bytes);
    const rest = await store.taskOutput(sid, 'job', { offset: first.offset });
    assert.equal(rest.output, '✓ done');
    assert.equal(rest.offset, bytes.length);
  } finally {
    cleanup();
  }
});

test('a long gap since the last read is returned in chunks the caller can keep asking for', async () => {
  const config = tempConfig();
  const sid = `chunks-${String(process.pid)}`;
  const { dir, cleanup } = taskOutputDir(config, sid);
  try {
    writeFileSync(join(dir, 'job.output'), 'y'.repeat(150 * 1024));
    const store = new SessionStore(config);
    let offset = 0;
    let total = '';
    for (let i = 0; i < 5 && offset < 150 * 1024; i++) {
      const chunk = await store.taskOutput(sid, 'job', { offset });
      assert.ok(chunk.output.length <= 64 * 1024);
      total += chunk.output;
      offset = chunk.offset;
    }
    assert.equal(total.length, 150 * 1024);
  } finally {
    cleanup();
  }
});

test('a task from a run stream carries the run session, so its output can be read, and says a subagent owns it', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  try {
    const events = join(config.dataDir, 'turn.jsonl');
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(
      events,
      [
        { type: 'system', subtype: 'task_started', task_id: 'mine', task_type: 'local_bash', is_backgrounded: true, description: 'serve' },
        { type: 'system', subtype: 'task_started', task_id: 'bg-sub-1', task_type: 'local_bash', is_backgrounded: true, description: 'Watch the build', owned_by_subagent: true },
      ].map((e) => line(e)).join('\n'),
    );
    const run = core.runtime.start({ prompt: `REPLAY ${events}` });
    for (let i = 0; i < 200 && core.runtime.get(run.id)?.status !== 'idle'; i++) await new Promise((r) => setTimeout(r, 20));
    const detail = core.runtime.get(run.id);
    assert.ok(detail);

    const [mine, owned] = ['mine', 'bg-sub-1'].map((id) => detail.backgroundTasks.find((t) => t.id === id));
    assert.equal(mine?.sessionId, detail.id);
    assert.equal(mine?.fromSubagent, undefined);
    assert.equal(owned?.sessionId, detail.id);
    assert.equal(owned?.fromSubagent, true);
    // The event does not say which subagent
    assert.equal(owned?.ownerAgentId, undefined);

    // The run's session is on disk with the subagent that launched it: Core names the owner
    installSession(config.projectsDir, detail.id);
    const listed = (await core.chats.allBackgroundTasks()).filter((t) => t.chat.id === detail.id);
    assert.deepEqual(listed.map((t) => [t.id, t.ownerId]).sort(), [['bg-sub-1', AGENT], ['mine', null]]);
  } finally {
    core.shutdown();
  }
});
