import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AgentryEvent, JournalEntry, JournalPage, MemoryFile, MemoryProposal, Project, WorkItem } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// The journal and memory proposal routes over a real core with scratch dirs and a missing CLI:
// nothing here spawns Claude or reads the real ~/.claude.
let app: FastifyInstance;
let core: Core;
let root: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function importProject(name: string, modules: string[]): Promise<Project & { dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-api-journal-project-'));
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name, modules }) });
  assert.equal(res.statusCode, 201, res.body);
  return { ...res.json<Project>(), dir };
}

async function feed(fn: () => Promise<void>): Promise<AgentryEvent[]> {
  const events: AgentryEvent[] = [];
  const stop = core.events.subscribe((e) => events.push(e));
  try {
    await fn();
  } finally {
    stop();
  }
  return events;
}

const qa = { proposedBy: { kind: 'agent' as const, role: 'qa' } };

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-journal-'));
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

after(() => app.close());

test('the journal is read with the Memory module off and changed only with it on', async () => {
  const project = await importProject('Quiet', []);
  const url = `/api/projects/${project.id}/journal`;
  const off = await app.inject({ method: 'POST', url, ...json({ text: 'Too early' }) });
  assert.equal(off.statusCode, 409);
  assert.match(off.json().error, /Memory module is off/);
  assert.equal((await app.inject(url)).statusCode, 200);
  assert.equal((await app.inject(`/api/projects/${project.id}/memory/proposals`)).statusCode, 200);
  assert.equal((await app.inject('/api/projects/nope/journal')).statusCode, 404);

  await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, ...json({ modules: ['memory'] }) });
  let created: JournalEntry | null = null;
  const events = await feed(async () => {
    const res = await app.inject({ method: 'POST', url, ...json({ text: 'Columns stay fixed', kind: 'decision' }) });
    assert.equal(res.statusCode, 201, res.body);
    created = res.json<JournalEntry>();
  });
  const entry = created as JournalEntry | null;
  assert.equal(entry?.kind, 'decision');
  assert.deepEqual(
    events.filter((e) => e.type === 'journal.changed').map((e) => (e.type === 'journal.changed' ? `${e.action}:${e.kind}` : '')),
    ['added:decision'],
  );
  assert.equal((await app.inject({ method: 'POST', url, ...json({ text: 'x', kind: 'closed' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, ...json({ text: 'x', itemId: 'nope' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, ...json({ text: 'x', itemId: true }) })).statusCode, 400);

  const page = (await app.inject(`${url}?limit=10`)).json<JournalPage>();
  assert.deepEqual(page.entries.map((e) => e.text), ['Columns stay fixed']);
  assert.equal(page.handed.entries, 1);

  // Switched off again, the entry stays readable and cannot be deleted
  await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, ...json({ modules: [] }) });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/journal/${entry?.id ?? ''}` })).statusCode, 409);
  await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, ...json({ modules: ['memory'] }) });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/journal/${entry?.id ?? ''}` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/journal/${entry?.id ?? ''}` })).statusCode, 404);
});

test('an item a person moves to done is journalled once', async () => {
  const project = await importProject('Closing', ['board', 'memory']);
  const item = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Ship the board' }) })).json<WorkItem>();
  const move = (status: string) => app.inject({ method: 'POST', url: `/api/work-items/${item.id}/move`, ...json({ status }) });
  assert.equal((await move('done')).statusCode, 200);
  await move('in_progress');
  await move('done');
  const page = (await app.inject(`/api/projects/${project.id}/journal`)).json<JournalPage>();
  assert.deepEqual(page.entries.map((e) => `${e.kind}:${e.text}:${e.item?.key ?? ''}`), [`closed:Ship the board:${item.key}`]);
  assert.equal(page.entries[0]?.approvedBy?.kind, 'person');
});

test('approving writes each proposal to its target, and nothing is written before', async () => {
  const project = await importProject('Remembering', ['memory']);
  const toInstructions = core.memoryProposals.propose(project.id, { target: { kind: 'instructions', file: null, section: 'Testing' }, text: 'Use the fake CLI', reason: 'Never the real one' }, qa);
  const toMemory = core.memoryProposals.propose(project.id, { target: { kind: 'memory', file: 'fake-cli.md', section: null }, text: 'The fake CLI lives in e2e/', reason: 'Where to find it' }, qa);
  const toJournal = core.memoryProposals.propose(project.id, { target: { kind: 'journal', file: null, section: null }, text: 'QA runs every criterion', reason: 'Agreed' }, qa);
  const rejected = core.memoryProposals.propose(project.id, { target: { kind: 'journal', file: null, section: null }, text: 'Skip QA on Fridays', reason: 'Speed' }, qa);

  const pending = (await app.inject(`/api/projects/${project.id}/memory/proposals?status=pending`)).json<MemoryProposal[]>();
  assert.equal(pending.length, 4);
  assert.equal(existsSync(join(project.dir, 'CLAUDE.md')), false);
  assert.deepEqual((await app.inject(`/api/memory/${project.id}`)).json<MemoryFile[]>(), []);
  assert.equal((await app.inject(`/api/projects/${project.id}/memory/proposals?status=maybe`)).statusCode, 400);

  const events = await feed(async () => {
    const a = await app.inject({ method: 'POST', url: `/api/memory-proposals/${toInstructions.id}/approve`, ...json({ text: 'Use the fake CLI, always' }) });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json<MemoryProposal>().approvedText, 'Use the fake CLI, always');
    assert.equal((await app.inject({ method: 'POST', url: `/api/memory-proposals/${toMemory.id}/approve` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/memory-proposals/${toJournal.id}/approve`, ...json({}) })).statusCode, 200);
    const r = await app.inject({ method: 'POST', url: `/api/memory-proposals/${rejected.id}/reject`, ...json({ reason: 'No' }) });
    assert.equal(r.json<MemoryProposal>().status, 'rejected');
  });
  assert.deepEqual(
    events.filter((e) => e.type === 'memory.proposal').map((e) => (e.type === 'memory.proposal' ? `${e.action}:${e.target.kind}` : '')),
    ['approved:instructions', 'approved:memory', 'approved:journal', 'rejected:journal'],
  );

  assert.equal(readFileSync(join(project.dir, 'CLAUDE.md'), 'utf8'), '## Testing\n\nUse the fake CLI, always\n');
  const files = (await app.inject(`/api/memory/${project.id}`)).json<MemoryFile[]>();
  assert.deepEqual(files.map((f) => f.name), ['MEMORY.md', 'fake-cli.md']);
  assert.equal(files[1]?.description, 'Where to find it');
  const journal = (await app.inject(`/api/projects/${project.id}/journal`)).json<JournalPage>();
  assert.deepEqual(journal.entries.map((e) => `${e.kind}:${e.text}:${e.author.role ?? ''}`), ['memory:QA runs every criterion:qa']);

  assert.equal((await app.inject({ method: 'POST', url: `/api/memory-proposals/${rejected.id}/approve` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/memory-proposals/nope/reject' })).statusCode, 404);
});
