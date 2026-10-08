import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AGENTRY_MCP_READ_TOOL_NAMES } from '../src/names.ts';
import { chatRows, documentRows, flowRunRows, journalRows, orchestrationRows, providerRows, teamRows } from '../src/fields.ts';
import { seed, type Seeded } from './fixture.ts';

let s: Seeded;
before(async () => {
  s = await seed();
});
after(() => s.close());

const keys = (value: unknown): string[] => Object.keys(value as object).sort();

test('no read tool indents its answer: compact JSON is one line', async () => {
  const args: Record<string, Record<string, unknown>> = {
    get_board: { projectId: s.project.id },
    get_work_item: { item: s.item.key },
    get_orchestration: { orchestrationId: s.orchestration.id },
    get_team: { projectId: s.project.id },
    list_flow_runs: { projectId: s.project.id },
    get_journal: { projectId: s.project.id },
    list_documents: { projectId: s.project.id },
    read_document: { projectId: s.project.id, path: 'docs/plan.md' },
  };
  for (const name of AGENTRY_MCP_READ_TOOL_NAMES) {
    if (name === 'get_chat') continue;
    const { isError, text } = await s.call(name, args[name] ?? {});
    assert.equal(isError, false, name);
    assert.ok(!text.includes('\n'), `${name} is not on one line`);
    assert.equal(text, JSON.stringify(JSON.parse(text)), `${name} is not compact`);
  }
});

test('list_projects keeps what picks a project and drops its worktrees', async () => {
  const rows = (await s.call('list_projects')).json as Array<Record<string, unknown>>;
  assert.deepEqual(keys(rows[0]), ['chatCount', 'exists', 'id', 'key', 'modules', 'name', 'path']);
  assert.equal(rows[0]?.id, s.project.id);
});

test('get_board keeps one row per card, with no description or relations', async () => {
  const board = (await s.call('get_board', { projectId: s.project.id })).json as { columns: Array<{ status: string; items: Array<Record<string, unknown>> }> };
  const card = board.columns.find((c) => c.status === 'todo')?.items[0];
  assert.equal(card?.key, s.item.key);
  for (const dropped of ['description', 'relations', 'acceptanceCriteria', 'rank', 'createdAt']) assert.ok(!(dropped in (card ?? {})), dropped);
  assert.ok(keys(card).every((k) => ['hasDescription', 'id', 'key', 'labels', 'priority', 'status', 'title', 'type', 'assignee', 'epic', 'waiting'].includes(k)));
});

test('list_orchestrations answers counts, not tasks', async () => {
  const rows = (await s.call('list_orchestrations')).json as Array<Record<string, any>>;
  const row = rows.find((o) => o.id === s.orchestration.id);
  assert.equal(row?.tasks.total, 1);
  assert.ok(!('objective' in (row ?? {})) && !('allowedTools' in (row ?? {})));
});

test('list_flow_runs, get_team, get_journal and list_documents answer their short rows', async () => {
  const runs = (await s.call('list_flow_runs', { projectId: s.project.id })).json as { runs: Array<Record<string, unknown>> };
  assert.equal(runs.runs[0]?.id, 'run-1');
  assert.equal(runs.runs[0]?.item, s.item.key);
  assert.ok(!('projectId' in (runs.runs[0] ?? {})));
  const docs = (await s.call('list_documents', { projectId: s.project.id })).json as { tree: Array<Record<string, unknown>> };
  assert.ok(docs.tree.every((n) => !('ties' in n) && !('size' in n) && !('name' in n)));
  assert.ok(Array.isArray(((await s.call('get_team', { projectId: s.project.id })).json as { members: unknown }).members));
  assert.ok(Array.isArray(((await s.call('get_journal', { projectId: s.project.id })).json as { entries: unknown }).entries));
});

test('list_chats and list_providers keep the fields that choose', () => {
  const chat = {
    id: 'c1', title: 'T', state: 'waiting', origin: 'agentry', model: 'opus', messageCount: 3, updatedAt: 'x', cwd: '/p', provider: 'claude-code',
    project: { id: 'p1', name: 'Shop' }, orchestration: null, cost: { usd: 1.5, tokens: [{}], total: {} }, executions: [{}], context: {}, worktree: { path: '/w' },
  };
  assert.deepEqual(chatRows([chat]), [{ id: 'c1', title: 'T', state: 'waiting', origin: 'agentry', model: 'opus', messageCount: 3, updatedAt: 'x', project: 'Shop', projectId: 'p1', costUsd: 1.5 }]);
  const provider = { id: 'claude-code', label: 'Claude Code', state: 'ready', reason: null, account: 'a@b', version: '2', binaryPath: '/bin', capabilities: ['x'], checkedAt: 'z', limit: { state: 'ok', window: '5h', utilization: 0.2, resetsAt: null, windows: { '5h': {} }, source: 'stream' } };
  assert.deepEqual(providerRows([provider]), [{ id: 'claude-code', label: 'Claude Code', state: 'ready', account: 'a@b', version: '2', limit: { state: 'ok', window: '5h', utilization: 0.2 } }]);
});

test('team, journal, runs, documents and orchestrations drop the weight', () => {
  const run = { id: 'r', item: { key: 'A-1' }, outcome: 'done' };
  const team = teamRows({ projectId: 'p', enabled: true, unassignedAgents: ['x'], members: [{ agent: 'dev', role: 'developer', model: 'opus', responsibility: 'builds', file: { big: 1 }, columns: ['todo'], running: [run], queued: 0, lastRun: run }] }) as any;
  assert.deepEqual(team.members[0], { agent: 'dev', role: 'developer', model: 'opus', responsibility: 'builds', columns: ['todo'], queued: 0, running: [{ run: 'r', item: 'A-1' }], lastRun: { run: 'r', item: 'A-1', outcome: 'done' } });
  assert.ok(!('unassignedAgents' in team));
  const journal = journalRows({ entries: [{ id: 'j', kind: 'note', text: 't', item: { key: 'A-1' }, author: { kind: 'agent', role: 'qa' }, sources: [1], approvedBy: null, createdAt: 'c' }], total: 1, handed: {}, nextBefore: null });
  assert.deepEqual(journal, { entries: [{ id: 'j', kind: 'note', text: 't', createdAt: 'c', item: 'A-1', author: 'qa' }], total: 1 });
  assert.deepEqual(flowRunRows({ runs: [{ id: 'r', projectId: 'p', item: null, step: 'work' }], total: 1, nextCursor: 'n' }), { runs: [{ id: 'r', step: 'work' }], total: 1, nextCursor: 'n' });
  const docs = documentRows({ root: 'docs', exists: true, fileCount: 1, tiedCount: 0, tree: [{ name: 'a', path: 'docs/a', type: 'dir', fileCount: 1, ties: [], children: [{ name: 'b.md', path: 'docs/a/b.md', type: 'file', title: 'B', size: 3, ties: [] }] }] });
  assert.deepEqual(docs, { root: 'docs', exists: true, fileCount: 1, tree: [{ path: 'docs/a', type: 'dir', fileCount: 1, children: [{ path: 'docs/a/b.md', type: 'file', title: 'B' }] }] });
  assert.deepEqual(orchestrationRows([{ id: 'o', status: 'done', tasks: [{ status: 'done' }, { status: 'failed' }], verification: { status: 'passed', commands: [] } }]), [{ id: 'o', status: 'done', tasks: { total: 2, done: 1, failed: 1 }, verification: 'passed' }]);
});
