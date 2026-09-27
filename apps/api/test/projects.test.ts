import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AgentryEvent, Board, Project, ProjectSettings, ProjectTemplate, WorkItem } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// Project modules and templates over the routes. Scratch dirs and a missing CLI: nothing here
// spawns Claude or reads the real ~/.claude.
let app: FastifyInstance;
let core: Core;
let root: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const scratch = () => mkdtempSync(join(tmpdir(), 'agentry-api-proj-'));

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-projects-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(() => app.close());

test('the templates are listed, and the route is not taken for a project id', async () => {
  const res = await app.inject('/api/projects/templates');
  assert.equal(res.statusCode, 200);
  const templates = res.json<ProjectTemplate[]>();
  assert.deepEqual(
    templates.map((t) => [t.id, t.modules.length]),
    [
      ['simple', 0],
      ['software', 4],
      ['library', 3],
      ['research', 3],
      ['custom', 0],
    ],
  );
});

test('a project is created or imported from a template, and a bad one is refused before anything exists', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'web-shop', template: 'software' }) });
  assert.equal(created.statusCode, 201);
  const project = created.json<Project>();
  assert.deepEqual([project.key, project.modules], ['WS', ['board', 'team', 'documents', 'memory']]);

  const bad = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'ghost', template: 'enterprise' }) });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /unknown template/);
  assert.equal(existsSync(join(root, 'workspace', 'ghost')), false);

  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: scratch(), name: 'Notes', modules: ['memory'] }) });
  assert.equal(imported.statusCode, 201);
  assert.deepEqual(imported.json<Project>().modules, ['memory']);
  const plain = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: scratch(), name: 'Plain' }) });
  assert.deepEqual(plain.json<Project>().modules, []);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: scratch(), modules: ['wiki'] }) })).statusCode, 400);

  for (const p of [project, imported.json<Project>(), plain.json<Project>()]) await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
});

test('settings are read and replaced whole, validated, and each change reaches the event feed', async () => {
  const events: AgentryEvent[] = [];
  const stop = core.events.subscribe((e) => events.push(e));
  const { id } = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: scratch(), name: 'Agentry' }) })).json<Project>();
  const other = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: scratch(), name: 'Other' }) })).json<Project>();
  try {
    const read = await app.inject(`/api/projects/${id}/settings`);
    assert.equal(read.statusCode, 200);
    const settings = read.json<ProjectSettings>();
    assert.deepEqual([settings.modules, settings.keyPrefix, settings.template], [[], 'AGN', null]);

    const next: ProjectSettings = { ...settings, modules: ['board'], board: { types: ['task', 'bug'], columnLimits: { in_progress: 2 } } };
    const put = await app.inject({ method: 'PUT', url: `/api/projects/${id}/settings`, ...json(next) });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json<ProjectSettings>(), next);
    assert.deepEqual((await app.inject(`/api/projects/${id}/settings`)).json<ProjectSettings>(), next);

    const invalid = await app.inject({ method: 'PUT', url: `/api/projects/${id}/settings`, ...json({ ...next, board: { types: [], columnLimits: {} } }) });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /at least one type/);
    const clash = await app.inject({ method: 'PUT', url: `/api/projects/${other.id}/settings`, ...json({ ...next, keyPrefix: 'AGN' }) });
    assert.equal(clash.statusCode, 400);
    assert.match(clash.json().error, /already used/);

    assert.equal((await app.inject('/api/projects/nope/settings')).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/projects/nope/settings', ...json(next) })).statusCode, 404);

    const updated = events.filter((e) => e.type === 'project.updated');
    assert.equal(updated.length, 1);
    assert.ok(updated[0]?.type === 'project.updated');
    assert.deepEqual([updated[0].projectId, updated[0].changes, updated[0].modules], [id, ['modules', 'settings'], ['board']]);
  } finally {
    stop();
    for (const p of [id, other.id]) await app.inject({ method: 'DELETE', url: `/api/projects/${p}` });
  }
});

test('PATCH renames a project, or changes its key and modules, keeping what a module holds', async () => {
  const { id } = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: scratch(), name: 'Shop', template: 'software' }) })).json<Project>();
  try {
    const renamed = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, ...json({ name: 'Store' }) });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json<Project>().name, 'Store');

    const off = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, ...json({ key: 'sto', modules: [] }) });
    assert.deepEqual([off.json<Project>().key, off.json<Project>().modules], ['STO', []]);
    const on = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, ...json({ modules: ['board'] }) });
    assert.deepEqual(on.json<Project>().modules, ['board']);
    // The template's board came back with the module
    assert.deepEqual((await app.inject(`/api/projects/${id}/settings`)).json<ProjectSettings>().board.columnLimits, { in_progress: 3, in_review: 2 });

    for (const body of [{}, { name: '' }, { key: '9X' }, { modules: ['wiki'] }]) {
      assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, ...json(body) })).statusCode, 400, JSON.stringify(body));
    }
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/projects/nope', ...json({ name: 'x' }) })).statusCode, 404);
  } finally {
    await app.inject({ method: 'DELETE', url: `/api/projects/${id}` });
  }
});

test('removing a project keeps its settings, and importing the directory again brings them back', async () => {
  const path = scratch();
  const first = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path, name: 'Lib', template: 'library' }) })).json<Project>();
  await app.inject({ method: 'DELETE', url: `/api/projects/${first.id}` });
  const again = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path, name: 'Lib' }) })).json<Project>();
  assert.deepEqual([again.id, again.key, again.modules], [first.id, first.key, ['board', 'documents', 'memory']]);
  await app.inject({ method: 'DELETE', url: `/api/projects/${again.id}` });
});

test('the Board switched off and on again keeps its work items, their keys, columns and order', async () => {
  const { id } = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: scratch(), name: 'Round Trip', template: 'software' }) })).json<Project>();
  try {
    const create = async (body: object) => {
      const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/work-items`, ...json(body) });
      assert.equal(res.statusCode, 201, res.body);
      return res.json<WorkItem>();
    };
    const epic = await create({ title: 'Checkout', type: 'epic' });
    const first = await create({ title: 'Pay by card', epicId: epic.id, status: 'todo' });
    const second = await create({ title: 'Pay by transfer', epicId: epic.id, status: 'todo' });
    // The order a person dragged must survive too
    await app.inject({ method: 'POST', url: `/api/work-items/${second.id}/move`, ...json({ status: 'todo', afterId: null }) });
    const board = async () => (await app.inject(`/api/projects/${id}/work-items/board`)).json<Board>();
    const shape = (b: Board) => b.columns.map((c) => [c.status, c.items.map((i) => [i.key, i.epicId])]);
    const before = shape(await board());
    assert.deepEqual(before[1], ['todo', [[second.key, epic.id], [first.key, epic.id]]]);

    const off = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, ...json({ modules: [] }) });
    assert.deepEqual(off.json<Project>().modules, []);
    // Hidden, not gone: the items still read, and nothing can change them
    assert.equal((await app.inject(`/api/work-items/${first.id}`)).json<WorkItem>().key, first.key);
    const refused = await app.inject({ method: 'POST', url: `/api/projects/${id}/work-items`, ...json({ title: 'Nope' }) });
    assert.equal(refused.statusCode, 409);

    const on = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, ...json({ modules: ['board'] }) });
    assert.deepEqual([on.json<Project>().key, on.json<Project>().modules], ['RT', ['board']]);
    assert.deepEqual(shape(await board()), before);
    // A number is never reused, so the next item follows the last one made before the switch
    assert.equal((await create({ title: 'Refunds' })).number, second.number + 1);
  } finally {
    await app.inject({ method: 'DELETE', url: `/api/projects/${id}` });
  }
});
