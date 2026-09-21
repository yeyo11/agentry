import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { AgentryEvent, ChangeSummary, ChatChanges, Checklist, FileDiff, Orchestration } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// What a worker did on disk, over HTTP: real git worktrees made by real orchestrations, driven by
// the fake CLI the core tests use, which writes the files a prompt asks for.
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;
let repo: string;
let projectsDir: string;
let graph: Orchestration;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(id: string): Promise<Orchestration> {
  for (let i = 0; i < 300; i++) {
    const orch = core.orchestrator.get(id);
    if (orch && orch.status !== 'running') return orch;
    await sleep(50);
  }
  throw new Error('the orchestration never finished');
}

function repoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-api-changes-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(dir, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-changes-data-'));
  const config = loadConfig({
    CLAUDE_BIN: FAKE_CLAUDE,
    CSWAP_BIN: '/nonexistent/cswap',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
    AGENTRY_DATA_DIR: join(root, 'data'),
  });
  projectsDir = config.projectsDir;
  core = new Core(config);
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  repo = repoWithCommit();

  const res = await app.inject({
    method: 'POST',
    url: '/api/orchestrations',
    ...json({
      name: 'Observed',
      cwd: repo,
      worktree: true,
      synthesize: false,
      tasks: [
        { id: 'api', name: 'API', prompt: 'FAKE-WRITE api.txt server' },
        { id: 'shell', name: 'Shell', prompt: 'FAKE-WRITE shell.txt electron', dependsOn: ['api'] },
      ],
    }),
  });
  assert.equal(res.statusCode, 201);
  graph = await settle(res.json().id);
  assert.equal(graph.status, 'completed');
});

after(async () => {
  await app.close();
  core.shutdown();
});

const get = async <T>(url: string): Promise<{ status: number; body: T }> => {
  const res = await app.inject(url);
  return { status: res.statusCode, body: res.json() as T };
};

test('a task reports what it committed against where its own branch started, not the graph', async () => {
  const api = (await get<ChangeSummary>(`/api/orchestrations/${graph.id}/tasks/api/changes`)).body;
  assert.equal(api.branch, graph.tasks.find((t) => t.id === 'api')?.branch);
  assert.equal(api.base, graph.baseCommit);
  assert.equal(api.ahead, 1);
  assert.deepEqual(api.files, [{ path: 'api.txt', status: 'added', additions: 1, deletions: 0 }]);
  assert.deepEqual(api.uncommitted, []);
  assert.ok(api.commits[0]?.author);

  // `shell` builds on `api`: its own change is one file, not the two the branch holds against main
  const shell = (await get<ChangeSummary>(`/api/orchestrations/${graph.id}/tasks/shell/changes`)).body;
  assert.deepEqual(shell.files.map((f) => f.path), ['shell.txt']);
  assert.notEqual(shell.base, graph.baseCommit);
  assert.equal(shell.ahead, 1);
});

test('the integration branch shows the work of every task, and each file has its own diff', async () => {
  const integration = (await get<ChangeSummary>(`/api/orchestrations/${graph.id}/integration/changes`)).body;
  assert.equal(integration.branch, graph.integration?.branch);
  assert.deepEqual(integration.files.map((f) => f.path).sort(), ['api.txt', 'shell.txt']);
  assert.ok(integration.ahead >= 2);

  const diff = (await get<FileDiff>(`/api/orchestrations/${graph.id}/integration/changes/diff?path=shell.txt`)).body;
  assert.equal(diff.path, 'shell.txt');
  assert.match(diff.diff, /^\+electron$/m);
  assert.match(diff.diff, /^new file mode/m);
});

test("a worker's uncommitted work is in its summary and its diff the moment it is written", async () => {
  const worktree = graph.tasks.find((t) => t.id === 'api')?.worktree as string;
  writeFileSync(join(worktree, 'draft.txt'), 'wip\nmore\n');
  writeFileSync(join(worktree, 'api.txt'), 'server\nchanged\n');

  const summary = (await get<ChangeSummary>(`/api/orchestrations/${graph.id}/tasks/api/changes`)).body;
  assert.deepEqual(summary.uncommitted.map((f) => [f.path, f.status, f.additions]).sort(), [['api.txt', 'modified', 1], ['draft.txt', 'added', 2]]);

  const draft = (await get<FileDiff>(`/api/orchestrations/${graph.id}/tasks/api/changes/diff?path=draft.txt`)).body;
  assert.match(draft.diff, /^\+wip$/m);
  // The committed line and the one added since are one diff against the base
  const api = (await get<FileDiff>(`/api/orchestrations/${graph.id}/tasks/api/changes/diff?path=api.txt`)).body;
  assert.match(api.diff, /^\+server$/m);
  assert.match(api.diff, /^\+changed$/m);
});

test('a bad request is a 4xx that says what was wrong', async () => {
  const base = `/api/orchestrations/${graph.id}`;
  assert.equal((await get(`${base}/tasks/api/changes/diff`)).status, 400);
  assert.equal((await get(`${base}/tasks/api/changes/diff?path=../../etc/passwd`)).status, 400);
  assert.equal((await get(`${base}/tasks/api/changes/diff?path=/etc/passwd`)).status, 400);
  assert.equal((await get(`${base}/tasks/api/changes/diff?path=README.md`)).status, 404); // the task never touched it
  assert.equal((await get(`${base}/tasks/nope/changes`)).status, 404);
  assert.equal((await get('/api/orchestrations/nope/tasks/api/changes')).status, 404);
  assert.equal((await get('/api/orchestrations/nope/integration/changes')).status, 404);
});

test('a graph whose tasks share one checkout has no branch to compare and says so', async () => {
  const started = await app.inject({
    method: 'POST',
    url: '/api/orchestrations',
    ...json({ name: 'Shared', cwd: repo, worktree: false, synthesize: false, tasks: [{ id: 'a', name: 'A', prompt: 'FAKE-WRITE shared.txt x' }] }),
  });
  const shared = await settle(started.json().id);
  const res = await app.inject(`/api/orchestrations/${shared.id}/tasks/a/changes`);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /share one checkout/);
});

test("a worker's checklist is read from the plan its own calls kept in the transcript", async () => {
  const sessionId = graph.tasks.find((t) => t.id === 'api')?.sessionId as string;
  assert.ok(sessionId);
  const empty = (await get<Checklist>(`/api/orchestrations/${graph.id}/tasks/api/checklist`)).body;
  assert.deepEqual(empty, { items: [], updatedAt: null });

  const dir = join(projectsDir, '-work-api-changes');
  mkdirSync(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  const use = (uuid: string, timestamp: string, id: string, name: string, input: unknown) =>
    line({ type: 'assistant', uuid, timestamp, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T10:00:00Z', cwd: repo, message: { role: 'user', content: 'go' } }),
      use('a1', '2026-01-01T10:00:01Z', 't1', 'TaskCreate', { subject: 'write the server' }),
      line({ type: 'user', uuid: 'u2', timestamp: '2026-01-01T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Task #1 created successfully: write the server' }] } }),
      use('a2', '2026-01-01T10:00:03Z', 't2', 'TaskCreate', { subject: 'test it' }),
      line({ type: 'user', uuid: 'u3', timestamp: '2026-01-01T10:00:04Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Task #2 created successfully: test it' }] } }),
      use('a3', '2026-01-01T10:00:05Z', 't3', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      use('a4', '2026-01-01T10:00:06Z', 't4', 'Write', { file_path: join(repo, 'src', 'server.ts') }),
    ].join('\n'),
  );

  const list = (await get<Checklist>(`/api/orchestrations/${graph.id}/tasks/api/checklist`)).body;
  assert.deepEqual(list.items, [{ text: 'write the server', status: 'completed' }, { text: 'test it', status: 'pending' }]);
  assert.equal(list.updatedAt, '2026-01-01T10:00:05Z');
  // The same plan, asked of the chat itself
  assert.deepEqual((await get<Checklist>(`/api/chats/${sessionId}/checklist`)).body, list);
  assert.equal((await get('/api/chats/no-such-chat/checklist')).status, 404);
});

test('a chat in a worktree answers with its branch, and any chat with the files its own calls touched', async () => {
  const task = graph.tasks.find((t) => t.id === 'shell');
  const chat = (await get<ChatChanges>(`/api/chats/${task?.sessionId}/changes`)).body;
  // A worker's chat is measured like its task
  assert.deepEqual(chat.summary?.files.map((f) => f.path), ['shell.txt']);
  assert.deepEqual(chat.touched, []);
  const diff = (await get<FileDiff>(`/api/chats/${task?.sessionId}/changes/diff?path=shell.txt`)).body;
  assert.match(diff.diff, /^\+electron$/m);

  // A conversation somewhere with no git: only the transcript knows what it wrote
  const dir = join(projectsDir, '-work-elsewhere');
  mkdirSync(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  const use = (uuid: string, timestamp: string, id: string, name: string, input: unknown) =>
    line({ type: 'assistant', uuid, timestamp, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  writeFileSync(
    join(dir, 'plain-chat.jsonl'),
    [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T09:00:00Z', cwd: '/work/elsewhere', message: { role: 'user', content: 'edit things' } }),
      use('a1', '2026-01-01T09:00:01Z', 'w1', 'Write', { file_path: '/work/elsewhere/a.md' }),
      use('a2', '2026-01-01T09:00:02Z', 'e1', 'Edit', { file_path: '/work/elsewhere/b.md', old_string: 'x', new_string: 'y' }),
      use('a3', '2026-01-01T09:00:03Z', 'e2', 'Edit', { file_path: '/work/elsewhere/a.md', old_string: 'x', new_string: 'z' }),
      use('a4', '2026-01-01T09:00:04Z', 'n1', 'NotebookEdit', { notebook_path: '/work/elsewhere/n.ipynb' }),
      use('a5', '2026-01-01T09:00:05Z', 'bad', 'Edit', { file_path: '/work/elsewhere/refused.md' }),
      line({ type: 'user', uuid: 'r1', timestamp: '2026-01-01T09:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad', is_error: true, content: 'rejected' }] } }),
    ].join('\n'),
  );
  const plain = (await get<ChatChanges>('/api/chats/plain-chat/changes')).body;
  assert.equal(plain.summary, null);
  assert.deepEqual(plain.touched.map((t) => [t.path, t.tool]), [
    ['/work/elsewhere/n.ipynb', 'NotebookEdit'],
    ['/work/elsewhere/a.md', 'Edit'],
    ['/work/elsewhere/b.md', 'Edit'],
  ]);
  const noDiff = await app.inject('/api/chats/plain-chat/changes/diff?path=a.md');
  assert.equal(noDiff.statusCode, 400);
  assert.match(noDiff.json().error, /no worktree/);
  assert.equal((await get('/api/chats/no-such-chat/changes')).status, 404);
});

test('while a worker runs, the global feed announces its commits and uncommitted files without being asked', async () => {
  const started = await app.inject({
    method: 'POST',
    url: '/api/orchestrations',
    ...json({ name: 'Live', cwd: repo, worktree: true, synthesize: false, tasks: [{ id: 'busy', name: 'Busy', prompt: 'FAKE-WRITE busy.txt working\nFAKE-HANG' }] }),
  });
  const id = started.json().id as string;
  const heard: AgentryEvent[] = [];
  const unsubscribe = core.events.subscribe((e) => {
    if (e.type === 'changes.updated') heard.push(e);
  });
  try {
    for (let i = 0; i < 120 && heard.length === 0; i++) await sleep(100);
  } finally {
    unsubscribe();
    await app.inject({ method: 'POST', url: `/api/orchestrations/${id}/stop` });
  }
  const event = heard[0];
  assert.equal(event?.type, 'changes.updated');
  if (event?.type !== 'changes.updated') return;
  assert.equal(event.orchestrationId, id);
  assert.equal(event.taskId, 'busy');
  assert.equal(event.uncommitted, 1);
  assert.equal(event.ahead, 0);
});

test('every changes route is documented with a summary and a tag', async () => {
  const spec = (await app.inject('/openapi.json')).json() as { paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> };
  for (const path of [
    '/api/orchestrations/{id}/tasks/{taskId}/changes',
    '/api/orchestrations/{id}/tasks/{taskId}/changes/diff',
    '/api/orchestrations/{id}/tasks/{taskId}/checklist',
    '/api/orchestrations/{id}/integration/changes',
    '/api/orchestrations/{id}/integration/changes/diff',
    '/api/chats/{id}/changes',
    '/api/chats/{id}/changes/diff',
    '/api/chats/{id}/checklist',
  ]) {
    const op = spec.paths[path]?.get;
    assert.ok(op?.summary && op.tags?.length, `${path} is not documented`);
  }
});
