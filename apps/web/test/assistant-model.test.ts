import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantProposal, AssistantRun, AssistantRunDetail, AssistantSource } from '@agentry/shared';
import {
  assistantPath,
  followingRun,
  latestRun,
  projectPath,
  proposalsOf,
  proposesByDefault,
  readSummary,
  resourceReviewHref,
  stageOf,
  tally,
} from '../src/pages/assistant/model.ts';

const zero = { total: 0, pending: 0, accepted: 0, discarded: 0, superseded: 0 };

const run = (over: Partial<AssistantRun> = {}): AssistantRun => ({
  id: 'r1',
  projectId: 'p',
  kind: 'project',
  status: 'completed',
  model: 'sonnet',
  description: null,
  resourceKind: null,
  chatId: 'c1',
  empty: false,
  template: 'software',
  sources: [],
  findings: [],
  counts: { 'team-member': zero, resource: zero, 'work-item': zero },
  costUsd: 0.08,
  durationMs: 72_000,
  error: null,
  supersedes: null,
  supersededBy: null,
  startedAt: '2026-09-27T10:00:00.000Z',
  endedAt: '2026-09-27T10:01:12.000Z',
  ...over,
});

const base = { runId: 'r1', projectId: 'p', reason: 'why', decidedBy: null, decidedAt: null, createdAt: '2026-09-27T10:01:12.000Z' };
const item = (id: string, position: number, status: AssistantProposal['status']): AssistantProposal => ({
  ...base,
  id,
  position,
  status,
  kind: 'work-item',
  created: null,
  workItem: { type: 'task', title: id, description: '', priority: 'medium', labels: [], acceptanceCriteria: [], epicId: null, epic: null, similarTo: null },
});
const member = (id: string, position: number): AssistantProposal => ({
  ...base,
  id,
  position,
  status: 'pending',
  kind: 'team-member',
  acceptedAgent: null,
  member: { role: 'qa', model: 'sonnet', responsibility: '', agent: 'qa', writes: [], fromTemplate: true, description: '', instructions: '' },
});

const source = (over: Partial<AssistantSource>): AssistantSource => ({ kind: 'file', path: null, state: 'read', count: null, total: null, unit: null, names: [], ...over });

test('the assistant lives under its project, and the project page is the way out', () => {
  assert.equal(assistantPath('a b'), '/projects/a%20b/assistant');
  assert.equal(projectPath('a b'), '/?project=a%20b');
});

test("Review opens a proposed resource in the project's Resources tab, unsaved", () => {
  const href = resourceReviewHref('p1', {
    id: 'prop-1',
    resource: { kind: 'commands', name: 'migrate', description: '', content: '', scope: 'project', path: '.claude/commands/migrate.md' },
  });
  const url = new URL(href, 'http://x');
  assert.equal(url.pathname, '/');
  assert.deepEqual(Object.fromEntries(url.searchParams), { project: 'p1', view: 'resources', section: 'commands', proposal: 'prop-1' });
});

test('the wizard proposes by default for every template but Simple', () => {
  assert.equal(proposesByDefault('simple'), false);
  for (const id of ['software', 'library', 'research', 'custom'] as const) assert.equal(proposesByDefault(id), true, id);
});

test('the latest run is the first of a list served latest first', () => {
  assert.equal(latestRun([]), null);
  assert.equal(latestRun(undefined), null);
  assert.equal(latestRun([run({ id: 'b' }), run({ id: 'a' })])?.id, 'b');
});

test("an empty project's first tasks come from the work-items run started after it", () => {
  const empty = run({ empty: true, chatId: null, startedAt: '2026-09-27T10:00:00.000Z' });
  const before = run({ id: 'old', kind: 'work-items', startedAt: '2026-09-27T09:00:00.000Z' });
  const after = run({ id: 'new', kind: 'work-items', startedAt: '2026-09-27T10:05:00.000Z' });
  assert.equal(followingRun(empty, [after, before])?.id, 'new');
  assert.equal(followingRun(empty, [before]), null);
  // A project that had something to read proposes its own tasks
  assert.equal(followingRun(run(), [after]), null);
});

test('proposals of a kind come in the order proposed, without the superseded ones', () => {
  const detail: AssistantRunDetail = { ...run(), proposals: [item('b', 1, 'pending'), member('m', 0), item('a', 0, 'accepted'), item('s', 2, 'superseded')] };
  assert.deepEqual(
    proposalsOf(detail, 'work-item').map((p) => p.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    proposalsOf(detail, 'team-member').map((p) => p.id),
    ['m'],
  );
  assert.deepEqual(proposalsOf(null, 'resource'), []);
  assert.deepEqual(tally(proposalsOf(detail, 'work-item')), { accepted: 1, pending: 1, total: 2 });
});

test('a finished run sums what it read: files, chats, and folders of documents by name', () => {
  const summary = readSummary([
    source({ kind: 'file', path: 'README.md', unit: 'lines', count: 142 }),
    source({ kind: 'dir', path: 'src/', state: 'partial', unit: 'files', count: 31, total: 48 }),
    source({ kind: 'dir', path: 'docs/', unit: 'documents', count: 9 }),
    source({ kind: 'instructions', path: 'CLAUDE.md', state: 'missing' }),
    source({ kind: 'chats', unit: 'chats', count: 23 }),
    source({ kind: 'git', state: 'pending' }),
  ]);
  assert.deepEqual(summary, { files: 32, chats: 23, dirs: ['docs/'] });
});

test('each state of a run asks for its own screen', () => {
  assert.equal(stageOf(null), 'none');
  assert.equal(stageOf(run({ status: 'running' })), 'running');
  assert.equal(stageOf(run({ status: 'failed' })), 'failed');
  assert.equal(stageOf(run({ status: 'stopped' })), 'stopped');
  assert.equal(stageOf(run({ empty: true })), 'empty');
  assert.equal(stageOf(run()), 'done');
});
