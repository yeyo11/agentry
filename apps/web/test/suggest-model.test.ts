import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantProposal, AssistantResourceProposal, AssistantRun, AssistantSource, AssistantWorkItemProposal } from '@agentry/shared';
import { byDecision, proposalRuns, resourceProposals, savePath, sectionFrom, sectionKinds, shownName } from '../src/pages/home/resources/model';
import { initialSelection, isRunning, latestFocus, readPhrases, selectedPending, suggestRequest, workItemProposals } from '../src/pages/tasks/suggest/model';

const base = { runId: 'r1', projectId: 'p1', reason: 'why', decidedBy: null, decidedAt: null, createdAt: '2026-09-27T10:00:00Z' };

function item(id: string, over: Partial<AssistantWorkItemProposal> = {}, similar = false): AssistantWorkItemProposal {
  return {
    ...base,
    id,
    kind: 'work-item',
    status: 'pending',
    position: 0,
    created: null,
    workItem: {
      type: 'task',
      title: id,
      description: '',
      priority: 'medium',
      labels: [],
      acceptanceCriteria: [],
      epicId: null,
      epic: null,
      similarTo: similar ? { id: 'w1', key: 'AGN-45', title: 'x' } : null,
    },
    ...over,
  } as AssistantWorkItemProposal;
}

function resource(id: string, kind: 'agents' | 'skills' | 'commands', over: Partial<AssistantResourceProposal> = {}): AssistantResourceProposal {
  return {
    ...base,
    id,
    kind: 'resource',
    status: 'pending',
    position: 0,
    saved: null,
    resource: { kind, name: id, description: '', content: '', scope: 'project', path: '' },
    ...over,
  } as AssistantResourceProposal;
}

const source = (over: Partial<AssistantSource>): AssistantSource => ({ kind: 'file', path: null, state: 'read', count: null, total: null, unit: null, names: [], ...over });
const run = (id: string, over: Partial<AssistantRun> = {}): AssistantRun => ({ id, status: 'completed', description: null, ...over }) as AssistantRun;

test('work item proposals: in the order proposed, superseded ones and other kinds left out', () => {
  const proposals: AssistantProposal[] = [
    item('b', { position: 1 }),
    item('a', { position: 0 }),
    item('gone', { position: 2, status: 'superseded' }),
    resource('r', 'agents'),
  ];
  assert.deepEqual(
    workItemProposals(proposals).map((p) => p.id),
    ['a', 'b'],
  );
  assert.deepEqual(workItemProposals(undefined), []);
});

test('selection: pending proposals start selected, except one like an existing item', () => {
  const list = [item('a'), item('like', {}, true), item('done', { status: 'accepted' }), item('out', { status: 'discarded' })];
  assert.deepEqual([...initialSelection(list)], ['a']);
});

test('only pending proposals are created, whatever the selection still holds', () => {
  const list = [item('a'), item('b', { status: 'accepted' }), item('c')];
  assert.deepEqual(
    selectedPending(list, new Set(['a', 'b'])).map((p) => p.id),
    ['a'],
  );
});

test('the done line names the board first, then what it read of the project, at most three', () => {
  const phrases = readPhrases([
    source({ kind: 'file', path: 'README.md' }),
    source({ kind: 'journal' }),
    source({ kind: 'work-items', count: 27, unit: 'items' }),
    source({ kind: 'git', state: 'partial', count: 14, total: 20 }),
    source({ kind: 'dir', path: 'docs/', state: 'pending' }),
  ]);
  assert.deepEqual(phrases, [{ key: 'board' }, { key: 'path', path: 'README.md' }, { key: 'commits', count: 14 }]);
  assert.deepEqual(readPhrases([]), []);
});

test('a run moves only while it runs', () => {
  assert.equal(isRunning({ status: 'running' }), true);
  assert.equal(isRunning({ status: 'completed' }), false);
  assert.equal(isRunning(null), false);
});

test('resources: the section in the address, and the kinds it shows', () => {
  assert.equal(sectionFrom(null), 'all');
  assert.equal(sectionFrom('skills'), 'skills');
  assert.equal(sectionFrom('rules'), 'rules');
  assert.equal(sectionFrom('nonsense'), 'all');
  assert.deepEqual(sectionKinds('all'), ['agents', 'skills', 'commands']);
  assert.deepEqual(sectionKinds('commands'), ['commands']);
  assert.deepEqual(sectionKinds('workflows'), []);
});

test('resources: a command is shown with its slash, and each kind saves where the CLI reads it', () => {
  assert.equal(shownName('commands', 'openapi'), '/openapi');
  assert.equal(shownName('agents', 'x'), 'x');
  assert.equal(savePath('agents', 'migration-reviewer', 'project'), '.claude/agents/migration-reviewer.md');
  assert.equal(savePath('skills', 'design-tokens', 'project'), '.claude/skills/design-tokens/');
  assert.equal(savePath('commands', 'openapi', 'user'), 'commands/openapi.md');
});

test('resources: the runs whose proposals the tab reads', () => {
  const suggest = run('s');
  const created = run('c', { description: 'an agent' });
  const failed = run('f', { description: 'broken', status: 'failed' });
  const project = run('p');
  assert.deepEqual(proposalRuns([created, suggest, failed], [project], false), { suggest, ids: ['s', 'c'] });
  // A link to a proposal the tab has not found also reads the latest project runs
  assert.deepEqual(proposalRuns([suggest], [project], true).ids, ['s', 'p']);
  assert.deepEqual(proposalRuns([], [], false), { suggest: null, ids: [] });
});

test('suggest tasks: the focus goes as its own field, never as what the project is for', () => {
  assert.deepEqual(suggestRequest('  the checkout errors ', false), { kind: 'work-items', focus: 'the checkout errors' });
  assert.deepEqual(suggestRequest('', true), { kind: 'work-items', supersede: true });
  assert.equal('description' in suggestRequest('x', true), false);
  // The field starts with what the latest run looked for; a run stored before focus kept it in description
  assert.equal(latestFocus({ focus: 'errors', description: null }), 'errors');
  assert.equal(latestFocus({ description: 'old' }), 'old');
  assert.equal(latestFocus({ focus: null, description: null }), '');
});

test('resources: proposals once each, superseded ones out, pending first', () => {
  const list = resourceProposals([resource('a', 'agents', { status: 'accepted' }), resource('b', 'skills'), resource('b', 'skills'), resource('x', 'commands', { status: 'superseded' }), item('w')]);
  assert.deepEqual(
    list.map((p) => p.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    byDecision([resource('d', 'agents', { status: 'discarded' }), ...list]).map((p) => p.id),
    ['b', 'a', 'd'],
  );
});
