import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import type { AgentryEvent, ChatActivityEvent, FlowRunEvent, FlowRunPage, ProjectFlow, TeamChangedEvent, WorkItemMovedEvent } from '@agentry/shared';
import { api, ApiRequestError, keys } from '../src/api';
import { patchActivity, targetMatches, targetsFor } from '../src/lib/events';

// The contract of orchestration 6 (docs/plans/project-ecosystem.md, "ecosystem-gaps") as the web
// reads it: an item by its key in one request, the board's Done column and the lists paged, every
// flow run of an item and of a project, and the events that keep each of those fresh.

const realFetch = globalThis.fetch;

/** Runs `call` against a stub server that answers `reply` and records every path asked. */
async function asked<T>(call: () => Promise<T>, reply: (path: string) => Response = () => json({})): Promise<{ paths: string[]; result: T }> {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    return reply(path);
  }) as typeof fetch;
  try {
    return { paths, result: await call() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an item is found by its key in one request to the route by key, not through a search', async () => {
  const detail = { id: 'i1', key: 'AGN-12' };
  const found = await asked(() => api.workItemByKey(' agn-12 '), () => json(detail));
  assert.deepEqual(found.paths, ['/api/work-items/by-key/AGN-12']);
  assert.deepEqual(found.result, detail);

  const missing = await asked(() => api.workItemByKey('AGN-99'), () => json({ error: 'work item not found' }, 404));
  assert.equal(missing.result, null);

  // What is not a key is never asked for
  const none = await asked(() => api.workItemByKey('fix the build'));
  assert.deepEqual(none.paths, []);
  assert.equal(none.result, null);

  // Any other failure is still an error, not "no such item"
  await assert.rejects(
    asked(() => api.workItemByKey('AGN-12'), () => json({ error: 'boom' }, 500)),
    (err: unknown) => err instanceof ApiRequestError && err.status === 500,
  );
});

test("the board asks for a larger Done column only when told to, and keeps the unpaged board's address otherwise", async () => {
  const plain = await asked(() => api.workItemBoard('p1', { status: ['done'] }));
  assert.deepEqual(plain.paths, ['/api/projects/p1/work-items/board?status=done']);
  const more = await asked(() => api.workItemBoard('p1', {}, { doneLimit: 40 }));
  assert.deepEqual(more.paths, ['/api/projects/p1/work-items/board?doneLimit=40']);
  const filtered = await asked(() => api.workItemBoard(null, { q: 'login' }, { doneLimit: 60 }));
  assert.deepEqual(filtered.paths, ['/api/work-items/board?q=login&doneLimit=60']);
});

test('a list page carries its filter, its size and the cursor of the page before', async () => {
  const first = await asked(() => api.workItemPage('p1', { type: ['bug', 'task'] }));
  assert.deepEqual(first.paths, ['/api/projects/p1/work-items/page?type=bug%2Ctask']);
  const next = await asked(() => api.workItemPage(null, { limit: 100, cursor: 'c:2' }));
  assert.deepEqual(next.paths, ['/api/work-items/page?limit=100&cursor=c%3A2']);
});

test("an item's runs and a project's activity are read from their own routes", async () => {
  const runs = await asked(() => api.workItemRuns('i 1'), () => json([]));
  assert.deepEqual(runs.paths, ['/api/work-items/i%201/runs']);
  const activity = await asked(() => api.flowRuns('p1', { agent: ['qa', 'developer'], status: ['failed'], limit: 50, cursor: 'x' }));
  assert.deepEqual(activity.paths, ['/api/projects/p1/flow/runs?agent=qa%2Cdeveloper&status=failed&limit=50&cursor=x']);
  const all = await asked(() => api.flowRuns('p1'));
  assert.deepEqual(all.paths, ['/api/projects/p1/flow/runs']);
});

test('the new reads sit under the prefixes their events reach', () => {
  const under = (prefix: QueryKey, key: QueryKey) => prefix.every((part, i) => JSON.stringify(part) === JSON.stringify(key[i]));
  // The sidebar's count shares the unpaged board's entry, whose key did not change
  assert.deepEqual(keys.workItemBoard('p1'), ['work-items', 'board', 'p1', '']);
  assert.ok(under(keys.workItemBoards('p1'), keys.workItemBoard('p1', {}, 40)));
  assert.notDeepEqual(keys.workItemBoard('p1', {}, 40), keys.workItemBoard('p1'));
  assert.ok(under(keys.workItemLists(null), keys.workItemPages(null, { q: 'x' })));
  assert.ok(under(keys.workItem('i1'), keys.workItemRuns('i1')));
  // Not under `flow`: `chat.activity` patches that prefix as a snapshot of what runs now
  assert.equal(under(['flow'], keys.flowRuns('p1')), false);
  assert.ok(under(keys.flowRunsOf('p1'), keys.flowRuns('p1', { agent: ['qa'], status: ['failed'] })));
  // A filter is one key whatever the order it was picked in
  assert.deepEqual(keys.flowRuns('p1', { agent: ['qa', 'developer'] }), keys.flowRuns('p1', { agent: ['developer', 'qa'] }));
});

const CACHE: Record<string, QueryKey> = {
  activityP1: keys.flowRuns('p1'),
  activityP1Failed: keys.flowRuns('p1', { status: ['failed'] }),
  activityP2: keys.flowRuns('p2'),
  runsI1: keys.workItemRuns('i1'),
  runsI2: keys.workItemRuns('i2'),
  pagesP1: keys.workItemPages('p1'),
  pagesAll: keys.workItemPages(null),
  boardP1More: keys.workItemBoard('p1', {}, 40),
  teamP1: keys.team('p1'),
  agentsP1: keys.resources({ projectId: 'p1' }, 'agents'),
  developerFileP1: [...keys.resources({ projectId: 'p1' }, 'agents'), 'developer'],
};

function refetched(event: AgentryEvent): string[] {
  const targets = targetsFor(event);
  return Object.entries(CACHE)
    .filter(([, key]) => targets.some((target) => targetMatches(target, key)))
    .map(([name]) => name)
    .sort();
}

const base = { id: 1, at: '2026-09-28T10:00:00Z', title: 'x', projectId: 'p1' };

test("a flow run refreshes the project's activity and its item's runs, and nothing of another project", () => {
  const ended: FlowRunEvent = {
    ...base,
    type: 'flow.run',
    itemId: 'i1',
    key: 'AGN-1',
    runId: 'r1',
    action: 'ended',
    role: 'qa',
    agent: 'qa',
    stage: 'verify',
    step: 'verify',
    cause: null,
    retryOf: null,
    chatId: 'c1',
    outcome: 'failed',
  };
  const got = refetched(ended);
  for (const name of ['activityP1', 'activityP1Failed', 'runsI1', 'pagesP1', 'teamP1']) assert.ok(got.includes(name), `${name} in ${got.join(', ')}`);
  for (const name of ['activityP2', 'runsI2', 'pagesAll']) assert.equal(got.includes(name), false, name);
});

test("an item moving refreshes the lists' pages, the larger boards and the activity that names it", () => {
  const moved: WorkItemMovedEvent = {
    ...base,
    type: 'workitem.moved',
    itemId: 'i1',
    key: 'AGN-1',
    status: 'done',
    previousStatus: 'in_review',
    overLimit: false,
    actor: { kind: 'person' },
    cause: null,
  } as WorkItemMovedEvent;
  const got = refetched(moved);
  for (const name of ['activityP1', 'pagesP1', 'pagesAll', 'boardP1More']) assert.ok(got.includes(name), `${name} in ${got.join(', ')}`);
  assert.equal(got.includes('activityP2'), false);
});

test("an agent file saved through the resources reads the team and that member's open file again", () => {
  const saved: TeamChangedEvent = { ...base, type: 'team.changed', action: 'file', agents: ['developer'] };
  assert.deepEqual(refetched(saved), ['agentsP1', 'developerFileP1', 'teamP1']);
});

test("a chat's live line patches the flow's snapshot and leaves the activity's pages alone", () => {
  const client = new QueryClient();
  const run = { id: 'r1', chatId: 'c1', state: 'running', activity: null };
  const flow = { projectId: 'p1', enabled: true, maxParallel: 2, running: [run], queued: [] } as unknown as ProjectFlow;
  const pages = { pages: [{ runs: [run], total: 1, nextCursor: null }], pageParams: [''] } as unknown as { pages: FlowRunPage[] };
  client.setQueryData(keys.flow('p1'), flow);
  client.setQueryData(keys.flowRuns('p1'), pages);
  const event = { ...base, type: 'chat.activity', runId: 'c1', sessionId: 'c1', activity: { kind: 'tool', text: 'Reading a.ts' } } as unknown as ChatActivityEvent;
  patchActivity(client, event);
  assert.deepEqual(client.getQueryData<ProjectFlow>(keys.flow('p1'))?.running[0]?.activity, event.activity);
  assert.equal(client.getQueryData(keys.flowRuns('p1')), pages);
});
