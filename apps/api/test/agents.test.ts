import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { AgentTranscript, BackgroundTaskOutput, ChatBackgroundTaskEntry, ChatDetail, TranscriptSearchResult } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// Subagent and workflow-agent transcripts and task output over HTTP, against synthetic sessions
// laid out the way the CLI keeps them (the fixtures live with the core tests).
const FIXTURES = fileURLToPath(new URL('../../../packages/core/test/fixtures', import.meta.url));
const SESSION = 'sess-api-agents';
const PROJECT = '-work-api-agents';
const AGENT = 'a1b2c3d4e5f60718';
const WF_RUN = 'wf_5c79d6c0-b39';
const WF_AGENT = 'a4fdeef8a7b5856b5';

let app: FastifyInstance;
let tasksRoot: string;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-agents-'));
  const config = loadConfig({
    CLAUDE_BIN: '/nonexistent/claude',
    CSWAP_BIN: '/nonexistent/cswap',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
    AGENTRY_DATA_DIR: join(root, 'data'),
  });
  const projectDir = join(config.projectsDir, PROJECT);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${SESSION}.jsonl`),
    [
      { type: 'user', uuid: 'm1', timestamp: '2026-01-01T10:00:00.000Z', cwd: '/work/demo', message: { role: 'user', content: 'survey the build' } },
      { type: 'user', uuid: 'm3', timestamp: '2026-01-01T10:00:00.500Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_explore01', content: 'ok' }] }, toolUseResult: { agentId: AGENT } },
      { type: 'user', uuid: 'm4', timestamp: '2026-01-01T10:00:30.000Z', message: { role: 'user', content: `<task-notification><task-id>${AGENT}</task-id><status>completed</status><summary>done</summary></task-notification>` } },
    ].map((l) => JSON.stringify(l)).join('\n'),
  );
  const sessionDir = join(projectDir, SESSION);
  cpSync(join(FIXTURES, 'agent-session'), sessionDir, { recursive: true });
  cpSync(join(FIXTURES, 'workflow-session'), sessionDir, { recursive: true });
  const stopped = new Date('2026-01-01T10:00:30.000Z');
  utimesSync(join(sessionDir, 'subagents', `agent-${AGENT}.jsonl`), stopped, stopped);

  // Where the CLI keeps task output: a temp dir per user, project and session
  tasksRoot = join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, PROJECT);
  mkdirSync(join(tasksRoot, SESSION, 'tasks'), { recursive: true });
  writeFileSync(join(tasksRoot, SESSION, 'tasks', 'bg-sub-1.output'), 'watching…\nrebuilt\n');

  app = await buildApp(new Core(config), { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  rmSync(tasksRoot, { recursive: true, force: true });
  await app.close();
});

test('a subagent comes back with its prompt, usage, result and the tasks it launched', async () => {
  const res = await app.inject(`/api/chats/${SESSION}/subagents/${AGENT}`);
  assert.equal(res.statusCode, 200);
  const detail = res.json<AgentTranscript>();
  assert.equal(detail.kind, 'subagent');
  assert.equal(detail.subagentType, 'Explore');
  assert.equal(detail.status, 'completed');
  assert.equal(detail.usage.total, 332);
  assert.equal(detail.result, 'Found 3 build scripts: build, test, watch.');
  assert.equal(detail.total, 5);
  assert.deepEqual(detail.tasks.map((t) => t.id), ['bg-sub-1']);

  // The panel appends: only what it does not have yet
  const tail = (await app.inject(`/api/chats/${SESSION}/subagents/${AGENT}?after=4`)).json<AgentTranscript>();
  assert.equal(tail.from, 4);
  assert.equal(tail.entries.length, 1);
});

test('a workflow agent is served under its run', async () => {
  const res = await app.inject(`/api/chats/${SESSION}/workflows/${WF_RUN}/agents/${WF_AGENT}`);
  assert.equal(res.statusCode, 200);
  const detail = res.json<AgentTranscript>();
  assert.equal(detail.kind, 'workflow');
  assert.equal(detail.workflowRunId, WF_RUN);
  assert.equal(detail.description, 'one');
  assert.equal(detail.result, 'red');
});

test('an agent, run or session that is not there is a 404', async () => {
  for (const url of [
    `/api/chats/${SESSION}/subagents/ffffffffffffffff`,
    `/api/chats/no-such-session/subagents/${AGENT}`,
    `/api/chats/${SESSION}/workflows/wf_missing/agents/${WF_AGENT}`,
    `/api/chats/${SESSION}/workflows/${WF_RUN}/agents/ffffffffffffffff`,
  ]) {
    assert.equal((await app.inject(url)).statusCode, 404, url);
  }
});

test('ids that could leave the agent directories, and a bad `after`, are a 400', async () => {
  for (const url of [
    `/api/chats/${SESSION}/subagents/..%2F..%2Fsess`,
    `/api/chats/${SESSION}/subagents/a.b`,
    `/api/chats/${SESSION}/workflows/..%2Fx/agents/${WF_AGENT}`,
    `/api/chats/${SESSION}/workflows/notaworkflow/agents/${WF_AGENT}`,
    `/api/chats/${SESSION}/workflows/${WF_RUN}/agents/..%2Fx`,
    `/api/chats/${SESSION}/subagents/${AGENT}?after=-1`,
    `/api/chats/${SESSION}/subagents/${AGENT}?after=abc`,
    `/api/chats/${SESSION}/tasks/bg-sub-1/output?offset=1.5`,
  ]) {
    assert.equal((await app.inject(url)).statusCode, 400, url);
  }
});

test('a task launched by a subagent is listed with its owner and can be followed live', async () => {
  const [task] = (await app.inject(`/api/chats/${SESSION}/tasks`)).json<ChatBackgroundTaskEntry[]>();
  assert.equal(task?.ownerId, AGENT);
  assert.equal(task?.chat.id, SESSION);

  const first = (await app.inject(`/api/chats/${SESSION}/tasks/bg-sub-1/output`)).json<BackgroundTaskOutput>();
  assert.equal(first.output, 'watching…\nrebuilt\n');
  assert.equal(first.offset, first.bytes);

  writeFileSync(join(tasksRoot, SESSION, 'tasks', 'bg-sub-1.output'), 'done\n', { flag: 'a' });
  const more = (await app.inject(`/api/chats/${SESSION}/tasks/bg-sub-1/output?offset=${String(first.offset)}`)).json<BackgroundTaskOutput>();
  assert.equal(more.output, 'done\n');
  assert.equal(more.truncated, false);
  assert.equal(more.offset, more.bytes);
});

test('a session is searched whole over HTTP, and a search without a query or a target is refused', async () => {
  const res = await app.inject(`/api/chats/${SESSION}/search?q=${encodeURIComponent('SURVEY the')}`);
  assert.equal(res.statusCode, 200);
  const result = res.json<TranscriptSearchResult>();
  assert.equal(result.total, (await app.inject(`/api/chats/${SESSION}`)).json<ChatDetail>().total);
  assert.deepEqual(result.hits.map((h) => h.index), [0]);
  assert.equal(result.hits[0]?.snippet, 'survey the build');
  assert.equal(result.truncated, false);

  assert.equal((await app.inject(`/api/chats/${SESSION}/search`)).statusCode, 400);
  assert.equal((await app.inject(`/api/chats/${SESSION}/search?q=%20`)).statusCode, 400);
  assert.equal((await app.inject('/api/chats/no-such-session/search?q=x')).statusCode, 404);
  assert.equal((await app.inject('/api/chats/ghost/search?q=x')).statusCode, 404);
  assert.equal((await app.inject('/api/chats/ghost/search')).statusCode, 400);
});
