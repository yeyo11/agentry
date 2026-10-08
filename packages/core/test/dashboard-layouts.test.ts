import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentryEventInput } from '../src/events.ts';
import { DashboardLayoutStore } from '../src/dashboard-layouts.ts';

const layout = (...types: string[]) => ({ version: 1, widgets: types.map((type) => ({ id: type, type, size: 'm' })) });

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentry-layouts-'));
  const events: AgentryEventInput[] = [];
  const open = () => new DashboardLayoutStore({ dataDir }, { hasProject: async (id) => id === 'p1' || id === 'p2', emit: (e) => events.push(e) });
  return { events, open, file: join(dataDir, 'dashboard-layouts.json'), done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test('a layout saved on one project does not change another, and survives a restart', async (t) => {
  const { open, events, done } = setup();
  t.after(done);
  const store = open();
  assert.deepEqual(await store.get('p1'), { project: 'p1', layout: null });
  await store.set('p1', layout('documents', 'flows'));
  await store.set('all', layout('pickUp'));
  assert.equal((await store.get('p2')).layout, null);
  const again = open();
  assert.deepEqual((await again.get('p1')).layout?.widgets.map((w) => w.type), ['documents', 'flows']);
  assert.deepEqual((await again.get('all')).layout?.widgets.map((w) => w.type), ['pickUp']);
  assert.deepEqual(events.map((e) => e.type), ['dashboard.layout', 'dashboard.layout']);

  await again.reset('p1');
  assert.equal((await open().get('p1')).layout, null);
  assert.equal((await open().get('all')).layout?.widgets.length, 1);
  assert.equal(events.at(-1)?.type, 'dashboard.layout');
});

test('an invalid layout and an unknown project are refused, and nothing is written', async (t) => {
  const { open, events, file, done } = setup();
  t.after(done);
  const store = open();
  await assert.rejects(store.set('p1', layout('projects')), /does not belong/);
  await assert.rejects(store.set('p1', { version: 1 }), /widgets/);
  await assert.rejects(store.set('nope', layout('documents')), /project not found/);
  await assert.rejects(store.get('nope'), /project not found/);
  assert.throws(() => readFileSync(file));
  assert.equal(events.length, 0);
});

test('an entry that no longer validates falls back to the default; a broken file refuses writes', async (t) => {
  const { open, file, done } = setup();
  t.after(done);
  writeFileSync(file, JSON.stringify({ version: 1, layouts: { p1: { version: 9, widgets: [] }, p2: layout('documents') } }));
  const store = open();
  assert.equal((await store.get('p1')).layout, null);
  assert.equal((await store.get('p2')).layout?.widgets.length, 1);

  writeFileSync(file, '{ not json');
  const broken = open();
  assert.equal((await broken.get('p1')).layout, null);
  await assert.rejects(broken.set('p1', layout('documents')), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
});
