import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import type { AgentryEvent, AssistantProposalEvent, AssistantRun, AssistantRunDetail, AssistantRunEvent } from '@agentry/shared';
import { keys } from '../src/api';
import { patchActivity, targetsFor } from '../src/lib/events';

// The assistant's runs and proposals refresh from their own events only: a run's list and its page
// in that project, the run it superseded, and the resource an accept saved, which has no event.

/** Every read the assistant's screens keep, across two projects, and a few neighbours. */
const CACHE: Record<string, QueryKey> = {
  runsP1: keys.assistantRuns('p1'),
  runsP1Tasks: keys.assistantRuns('p1', 'work-items'),
  runsP1Resources: keys.assistantRuns('p1', 'resources'),
  runsP2: keys.assistantRuns('p2'),
  runR1: keys.assistantRun('r1'),
  runR0: keys.assistantRun('r0'),
  runR9: keys.assistantRun('r9'),
  agentsP1: keys.resources({ projectId: 'p1' }, 'agents'),
  skillsP1: keys.resources({ projectId: 'p1' }, 'skills'),
  agentsUser: keys.resources({}, 'agents'),
  teamP1: keys.team('p1'),
  boardP1: keys.workItemBoard('p1'),
  projects: keys.projects,
};

const startsWith = (key: QueryKey, prefix: QueryKey) => prefix.every((part, i) => JSON.stringify(part) === JSON.stringify(key[i]));

function refetched(event: AgentryEvent): string[] {
  const targets = targetsFor(event).map(([key]) => key);
  return Object.entries(CACHE)
    .filter(([, key]) => targets.some((prefix) => startsWith(key, prefix)))
    .map(([name]) => name)
    .sort();
}

const base = { id: 1, at: '2026-09-27T10:00:00Z', title: 'x', projectId: 'p1' };

const runEvent = (action: AssistantRunEvent['action'], supersedes: string | null = null): AssistantRunEvent => ({
  ...base,
  type: 'assistant.run',
  runId: 'r1',
  kind: 'work-items',
  action,
  status: action === 'failed' ? 'failed' : action === 'ended' ? 'completed' : 'running',
  chatId: 'c1',
  supersedes,
});

const proposalEvent = (action: AssistantProposalEvent['action'], extra: Partial<AssistantProposalEvent> = {}): AssistantProposalEvent => ({
  ...base,
  type: 'assistant.proposal',
  runId: 'r1',
  proposalId: 'x1',
  proposalKind: 'work-item',
  action,
  itemId: null,
  agent: null,
  resource: null,
  ...extra,
});

test("a run's every step reads its page and every list of its project, whatever the kind filter", () => {
  for (const action of ['started', 'read', 'ended', 'failed'] as const) {
    assert.deepEqual(refetched(runEvent(action)), ['runR1', 'runsP1', 'runsP1Resources', 'runsP1Tasks'], action);
  }
});

test('suggesting again also reads the run whose pending proposals it set aside', () => {
  assert.deepEqual(refetched(runEvent('started', 'r0')), ['runR0', 'runR1', 'runsP1', 'runsP1Resources', 'runsP1Tasks']);
});

test("a proposal decided reads its run and the lists' counts, and nothing it did not write", () => {
  for (const action of ['accepted', 'discarded', 'restored'] as const) {
    assert.deepEqual(refetched(proposalEvent(action, { itemId: action === 'accepted' ? 'i1' : null })), ['runR1', 'runsP1', 'runsP1Resources', 'runsP1Tasks'], action);
  }
});

test('a resource accepted is saved, so the list of its kind and scope reads again', () => {
  const inProject = proposalEvent('accepted', { proposalKind: 'resource', resource: { kind: 'agents', name: 'migration-reviewer', scope: 'project' } });
  assert.deepEqual(refetched(inProject), ['agentsP1', 'runR1', 'runsP1', 'runsP1Resources', 'runsP1Tasks']);
  const forUser = proposalEvent('accepted', { proposalKind: 'resource', resource: { kind: 'agents', name: 'glossary-reviewer', scope: 'user' } });
  assert.deepEqual(refetched(forUser), ['agentsUser', 'runR1', 'runsP1', 'runsP1Resources', 'runsP1Tasks']);
});

test("a running assistant's live line follows its chat's activity, without a refetch", () => {
  const client = new QueryClient();
  const run = (id: string, chatId: string | null): AssistantRun => ({
    id,
    projectId: 'p1',
    kind: 'project',
    status: 'running',
    model: 'sonnet',
    description: null,
    resourceKind: null,
    chatId,
    activity: null,
    empty: false,
    template: 'software',
    sources: [],
    findings: [],
    counts: {
      'team-member': { total: 0, pending: 0, accepted: 0, discarded: 0, superseded: 0 },
      resource: { total: 0, pending: 0, accepted: 0, discarded: 0, superseded: 0 },
      'work-item': { total: 0, pending: 0, accepted: 0, discarded: 0, superseded: 0 },
    },
    costUsd: 0.03,
    durationMs: null,
    error: null,
    supersedes: null,
    supersededBy: null,
    startedAt: base.at,
    endedAt: null,
  });
  const list = [run('r1', 'c1'), run('r2', 'c2')];
  const detail: AssistantRunDetail = { ...run('r1', 'c1'), proposals: [] };
  client.setQueryData(keys.assistantRuns('p1'), list);
  client.setQueryData(keys.assistantRun('r1'), detail);
  client.setQueryData(keys.assistantRun('r2'), { ...run('r2', 'c2'), proposals: [] });
  const activity = { kind: 'tool' as const, tool: 'Read', target: 'src/webhooks/stripe.ts', since: base.at };
  patchActivity(client, {
    id: 2,
    at: base.at,
    title: '',
    type: 'chat.activity',
    runId: 'c1',
    runName: 'Assistant',
    sessionId: 'c1',
    orchestrationId: null,
    internal: false,
    taskId: null,
    activity,
  });
  const patched = client.getQueryData<AssistantRun[]>(keys.assistantRuns('p1'));
  assert.deepEqual(patched?.[0]?.activity, activity);
  assert.equal(patched?.[1]?.activity, null, 'another chat keeps its line');
  assert.deepEqual(client.getQueryData<AssistantRunDetail>(keys.assistantRun('r1'))?.activity, activity);
  assert.deepEqual(client.getQueryData<AssistantRunDetail>(keys.assistantRun('r1'))?.proposals, []);
  assert.equal(client.getQueryData<AssistantRunDetail>(keys.assistantRun('r2'))?.activity, null);
});
