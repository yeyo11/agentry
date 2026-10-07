import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { Orchestration, OrchestrationSpec, Project, Schedule, Team } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// Effort on the routes that take a model: an unknown level is a 400, a known one is kept, and a live
// chat takes none. Nothing here spawns Claude: the CLI is missing.
let app: FastifyInstance;
let core: Core;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const task = { id: 'a', name: 'a', prompt: 'do it' };

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-effort-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  core.shutdown();
});

test('a new chat, a plan, a workflow run and an assistant run refuse an unknown effort with a 400', async () => {
  const chat = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', effort: 'turbo' }) });
  assert.equal(chat.statusCode, 400);
  assert.match(chat.json<{ error: string }>().error, /effort must be one of low, medium, high, xhigh, max/);
  const plan = await app.inject({ method: 'POST', url: '/api/orchestrations/plan/start', ...json({ objective: 'x', effort: 'turbo' }) });
  assert.equal(plan.statusCode, 400);
  const workflow = await app.inject({ method: 'POST', url: '/api/workflows/saved/run', ...json({ name: 'x', effort: 'turbo' }) });
  assert.equal(workflow.statusCode, 400);
});

test('an orchestration keeps the effort of the graph and of its tasks, and refuses an unknown one', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ name: 'g', effort: 'turbo', tasks: [task] }) });
  assert.equal(bad.statusCode, 400);
  const badTask = await app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ name: 'g', tasks: [{ ...task, effort: 'turbo' }] }) });
  assert.equal(badTask.statusCode, 400);
  const spec: OrchestrationSpec = { name: 'g', effort: 'high', engine: 'graph', tasks: [{ ...task, effort: 'low' }, { id: 'b', name: 'b', prompt: 'then', dependsOn: ['a'] }] };
  const made = await app.inject({ method: 'POST', url: '/api/orchestrations', ...json(spec) });
  assert.equal(made.statusCode, 201, made.body);
  const orch = made.json<Orchestration>();
  assert.equal(orch.effort, 'high');
  assert.deepEqual(
    orch.tasks.map((t) => t.effort),
    ['low', undefined],
  );
  await app.inject({ method: 'POST', url: `/api/orchestrations/${orch.id}/stop` });
});

test('a schedule refuses an unknown effort in its target and keeps a valid one', async () => {
  const body = (effort: string) => ({ name: 'nightly', cron: '0 3 * * *', timezone: 'UTC', target: { kind: 'chat', chat: { prompt: 'tidy up', effort } } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/schedules', ...json(body('turbo')) })).statusCode, 400);
  const made = await app.inject({ method: 'POST', url: '/api/schedules', ...json(body('low')) });
  assert.equal(made.statusCode, 201, made.body);
  const target = made.json<Schedule>().target;
  assert.equal(target.kind === 'chat' ? target.chat.effort : null, 'low');
});

test('a team member keeps its effort, and one with an unknown level is refused', async () => {
  const path = mkdtempSync(join(tmpdir(), 'agentry-api-effort-project-'));
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path, name: 'Crew', template: 'software', modules: ['board', 'team'] }) });
  assert.equal(imported.statusCode, 201, imported.body);
  const project = imported.json<Project>();
  const member = { role: 'developer', model: 'sonnet', responsibility: 'builds it' };
  const bad = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/team/developer`, ...json({ ...member, effort: 'turbo' }) });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/team/developer`, ...json({ ...member, effort: 'high' }) });
  assert.equal(ok.statusCode, 200, ok.body);
  const team = (await app.inject(`/api/projects/${project.id}/team`)).json<Team>();
  assert.equal(team.members.find((m) => m.agent === 'developer')?.effort, 'high');
});

test('an assistant run refuses an unknown effort', async () => {
  const path = mkdtempSync(join(tmpdir(), 'agentry-api-effort-assistant-'));
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path, name: 'Helper', modules: ['board'] }) });
  const project = imported.json<Project>();
  const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/assistant/runs`, ...json({ kind: 'work-items', effort: 'turbo' }) });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /effort must be one of/);
});

test('a live chat takes no effort from PATCH /chats/:id', async () => {
  const res = await app.inject({ method: 'PATCH', url: '/api/chats/any', ...json({ effort: 'high' }) });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /effort cannot change on a live chat/);
});
