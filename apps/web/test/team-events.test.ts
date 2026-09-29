import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  AgentryEvent,
  DocumentChangedEvent,
  FlowRun,
  FlowRunEvent,
  JournalChangedEvent,
  MemoryProposalEvent,
  ProjectFlow,
  ProjectUpdatedEvent,
  Team,
  TeamChangedEvent,
} from '@agentry/shared';
import { keys } from '../src/api';
import { patchActivity, targetMatches, targetsFor } from '../src/lib/events';

// The team, the flow, the journal, the proposals and the documents of a project refresh from its
// own events only, and each event reaches exactly the reads that show what it changed.

/** Every read the Team, Memory and Documents screens keep, across two projects, and a few neighbours. */
const CACHE: Record<string, QueryKey> = {
  teamP1: keys.team('p1'),
  teamP2: keys.team('p2'),
  flowP1: keys.flow('p1'),
  flowP2: keys.flow('p2'),
  journalP1: keys.journalPage('p1'),
  journalP1Older: keys.journalPage('p1', { limit: 30, before: '2026-09-26T10:00:00Z' }),
  journalP2: keys.journalPage('p2'),
  proposalsP1Pending: keys.memoryProposals('p1', 'pending'),
  proposalsP1All: keys.memoryProposals('p1'),
  proposalsP2: keys.memoryProposals('p2', 'pending'),
  docsP1: keys.documentTree('p1'),
  docP1Spec: keys.documentFile('p1', 'docs/specs/agn-28.md'),
  docP1Other: keys.documentFile('p1', 'docs/status.md'),
  docsP2: keys.documentTree('p2'),
  memoryFiles: keys.memoryFiles('-home-me-project'),
  instructionsP1: keys.instructions({ projectId: 'p1' }, 'shared'),
  agentsP1: keys.resources({ projectId: 'p1' }, 'agents'),
  skillsP1: keys.resources({ projectId: 'p1' }, 'skills'),
  boardP1: keys.workItemBoard('p1'),
  boardP2: keys.workItemBoard('p2'),
  item1: keys.workItem('i1'),
  item1Changes: keys.workItemChanges('i1'),
  item1Diff: keys.workItemDiff('i1', 'src/a.ts'),
  item2: keys.workItem('i2'),
  settingsP1: keys.projectSettings('p1'),
  projects: keys.projects,
};

function refetched(event: AgentryEvent): string[] {
  const targets = targetsFor(event);
  return Object.entries(CACHE)
    .filter(([, key]) => targets.some((target) => targetMatches(target, key)))
    .map(([name]) => name)
    .sort();
}

const base = { id: 1, at: '2026-09-27T10:00:00Z', title: 'x', projectId: 'p1' };

test('a team change reads the team and the agent files again, in that project only', () => {
  const changed: TeamChangedEvent = { ...base, type: 'team.changed', action: 'template', agents: ['developer', 'qa'] };
  assert.deepEqual(refetched(changed), ['agentsP1', 'teamP1']);
});

test('a journal entry refreshes every page of that journal', () => {
  const added: JournalChangedEvent = { ...base, type: 'journal.changed', entryId: 'j1', action: 'added', kind: 'note', itemId: null };
  assert.deepEqual(refetched(added), ['journalP1', 'journalP1Older']);
});

test('a proposal refreshes the proposals; approving it also reads back what it wrote', () => {
  const proposal = (action: MemoryProposalEvent['action'], kind: MemoryProposalEvent['target']['kind']): MemoryProposalEvent => ({
    ...base,
    type: 'memory.proposal',
    proposalId: 'm1',
    action,
    target: { kind, file: kind === 'memory' ? 'tests.md' : null, section: null },
    role: 'developer',
    itemId: 'i1',
  });
  assert.deepEqual(refetched(proposal('created', 'memory')), ['proposalsP1All', 'proposalsP1Pending']);
  assert.deepEqual(refetched(proposal('rejected', 'instructions')), ['proposalsP1All', 'proposalsP1Pending']);
  assert.deepEqual(refetched(proposal('approved', 'memory')), ['memoryFiles', 'proposalsP1All', 'proposalsP1Pending']);
  assert.deepEqual(refetched(proposal('approved', 'instructions')), ['instructionsP1', 'proposalsP1All', 'proposalsP1Pending']);
  assert.deepEqual(refetched(proposal('approved', 'journal')), ['journalP1', 'journalP1Older', 'proposalsP1All', 'proposalsP1Pending']);
});

test('a document written refreshes the tree and that file; a tie also the item it is tied to', () => {
  const written: DocumentChangedEvent = { ...base, type: 'document.changed', path: 'docs/specs/agn-28.md', action: 'written', itemId: null };
  assert.deepEqual(refetched(written), ['docP1Spec', 'docsP1']);
  const tied: DocumentChangedEvent = { ...written, action: 'tied', itemId: 'i1' };
  assert.deepEqual(refetched(tied), ['docP1Spec', 'docsP1', 'item1']);
});

test('a flow run starting refreshes who works on what, and the card it makes live', () => {
  const started: FlowRunEvent = {
    ...base,
    type: 'flow.run',
    itemId: 'i1',
    key: 'AGN-28',
    runId: 'r1',
    action: 'started',
    role: 'developer',
    agent: 'developer',
    stage: 'work',
    step: 'work',
    cause: null,
    retryOf: null,
    queuedBy: null,
    chatId: 'c1',
    outcome: null,
  };
  assert.deepEqual(refetched(started), ['boardP1', 'flowP1', 'item1', 'teamP1']);
});

test("a project's settings replaced read the team and the flow again, which live in them", () => {
  const updated: ProjectUpdatedEvent = { ...base, type: 'project.updated', projectName: 'p', changes: ['settings'], modules: ['board', 'team'] };
  const names = refetched(updated);
  for (const name of ['teamP1', 'flowP1', 'settingsP1']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('teamP2'));
  const renamed: ProjectUpdatedEvent = { ...updated, changes: ['name'] };
  assert.ok(!refetched(renamed).includes('teamP1'));
});

test("a member's live line follows its chat's activity, without a refetch", () => {
  const client = new QueryClient();
  const run = (id: string, chatId: string | null): FlowRun => ({
    id,
    projectId: 'p1',
    itemId: 'i1',
    item: null,
    role: 'developer',
    agent: 'developer',
    model: 'sonnet',
    stage: 'work',
    step: 'work',
    column: 'in_progress',
    state: chatId ? 'running' : 'queued',
    chatId,
    activity: null,
    outcome: null,
    summary: null,
    error: null,
    cause: null,
    retryOf: null,
    queuedBy: null,
    retriedBy: null,
    retryable: false,
    restarts: 0,
    continuations: 0,
    queuedAt: base.at,
    startedAt: chatId ? base.at : null,
    endedAt: null,
  });
  const team = {
    projectId: 'p1',
    enabled: true,
    unassignedAgents: [],
    members: [{ agent: 'developer', role: 'developer', model: 'sonnet', responsibility: '', running: [run('r1', 'c1')], queued: 0, lastRun: null }],
  } as unknown as Team;
  const flow: ProjectFlow = { projectId: 'p1', enabled: true, maxParallel: 2, running: [run('r1', 'c1'), run('r2', 'c2')], queued: [run('r3', null)] };
  client.setQueryData(keys.team('p1'), team);
  client.setQueryData(keys.flow('p1'), flow);
  const activity = { kind: 'tool' as const, tool: 'Bash', target: 'pnpm test', since: base.at };
  patchActivity(client, {
    id: 2,
    at: base.at,
    title: '',
    type: 'chat.activity',
    runId: 'c1',
    runName: 'AGN-28',
    sessionId: 'c1',
    orchestrationId: null,
    internal: false,
    taskId: null,
    activity,
  });
  assert.deepEqual(client.getQueryData<Team>(keys.team('p1'))?.members[0]?.running[0]?.activity, activity);
  const patched = client.getQueryData<ProjectFlow>(keys.flow('p1'));
  assert.deepEqual(patched?.running[0]?.activity, activity);
  assert.equal(patched?.running[1]?.activity, null, 'another chat keeps its line');
  assert.equal(patched?.queued, flow.queued);
});

test("a flow run or a chat moving reads its item again, but not the git diff of the item's branch", () => {
  // Every flow and run event refetched the item's changes, a `git diff`, though only a turn ending changes them
  const queued: FlowRunEvent = {
    ...base,
    type: 'flow.run',
    itemId: 'i1',
    key: 'AGN-28',
    runId: 'r1',
    action: 'queued',
    role: 'developer',
    agent: 'developer',
    stage: 'work',
    step: 'work',
    cause: null,
    retryOf: null,
    queuedBy: null,
    chatId: null,
    outcome: null,
  };
  const names = refetched(queued);
  assert.ok(names.includes('item1'));
  assert.ok(!names.includes('item1Changes') && !names.includes('item1Diff'), names.join());
  const moving = { id: 5, at: base.at, type: 'run.updated', runId: 'c1', sessionId: 'c1', status: 'running', previousStatus: 'queued' } as unknown as AgentryEvent;
  assert.ok(refetched(moving).includes('item1') && !refetched(moving).includes('item1Changes'));
  const ended = { id: 6, at: base.at, type: 'run.ended', runId: 'c1', sessionId: 'c1', status: 'completed' } as AgentryEvent;
  assert.ok(refetched(ended).includes('item1Changes'), 'a turn that ended may have changed files');
});
