import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowRun, TeamMember } from '@agentry/shared';
import {
  agentNameFor,
  cleanWrites,
  columnsOf,
  flowOf,
  memberBody,
  roleFallbackName,
  roleInitials,
  sameFlow,
  sameWrites,
  setColumnRole,
  stageOf,
  teamActivity,
  teamSearch,
  workingCount,
  writeScope,
  writesFor,
} from '../src/pages/team/model.ts';

const run = (id: string, over: Partial<FlowRun> = {}): FlowRun => ({
  id,
  projectId: 'p',
  itemId: `i-${id}`,
  item: null,
  role: 'developer',
  agent: 'developer',
  model: 'sonnet',
  stage: 'work',
  column: 'in_progress',
  state: 'ended',
  chatId: null,
  outcome: 'passed',
  summary: null,
  error: null,
  restarts: 0,
  queuedAt: '2026-09-27T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  ...over,
});

const member = (role: string, over: Partial<TeamMember> = {}): TeamMember => ({
  role,
  agent: role,
  model: 'sonnet',
  responsibility: '',
  file: { path: `.claude/agents/${role}.md`, state: 'ok', drift: [], description: null, model: null, updatedAt: null },
  columns: [],
  running: [],
  queued: 0,
  lastRun: null,
  ...over,
});

test('a role says the template acronym, or the initials of a role someone named', () => {
  assert.equal(roleInitials('product-owner'), 'PO');
  assert.equal(roleInitials('developer'), 'DEV');
  assert.equal(roleInitials('qa'), 'QA');
  assert.equal(roleInitials('writer'), 'DOC');
  assert.equal(roleInitials('tech-writer'), 'TW');
  assert.equal(roleInitials('i18n'), 'I18');
  assert.equal(roleFallbackName('tech-writer'), 'Tech writer');
});

test('each column but done has a stage', () => {
  assert.equal(stageOf('backlog'), 'refine');
  assert.equal(stageOf('todo'), 'refine');
  assert.equal(stageOf('in_progress'), 'work');
  assert.equal(stageOf('in_review'), 'verify');
  assert.equal(stageOf('done'), null);
});

test('a project that never saved a flow starts off, with the template roles it has', () => {
  const flow = flowOf({}, [member('product-owner'), member('qa')]);
  assert.equal(flow.enabled, false);
  assert.deepEqual(flow.columns, { backlog: 'product-owner', todo: 'product-owner', in_review: 'qa' });
  assert.equal(flow.maxBounces, 3);
  const saved = { enabled: true, columns: { in_progress: 'developer' }, maxBounces: 5 };
  const read = flowOf({ flow: saved }, []);
  assert.deepEqual(read, saved);
  assert.notEqual(read.columns, saved.columns, 'the draft never shares the cached object');
});

test('a column given to nobody drops its key, and done never takes a role', () => {
  const flow = { enabled: true, columns: { backlog: 'product-owner', todo: 'product-owner' }, maxBounces: 3 };
  assert.deepEqual(setColumnRole(flow, 'todo', '').columns, { backlog: 'product-owner' });
  assert.deepEqual(setColumnRole(flow, 'done', 'qa').columns, { backlog: 'product-owner', todo: 'product-owner' });
  assert.deepEqual(columnsOf(setColumnRole(flow, 'in_review', 'product-owner'), 'product-owner'), ['backlog', 'todo', 'in_review']);
  assert.ok(sameFlow(flow, { ...flow, columns: { ...flow.columns } }));
  assert.ok(!sameFlow(flow, setColumnRole(flow, 'todo', 'developer')));
  assert.ok(!sameFlow(flow, { ...flow, maxBounces: 4 }));
});

test('the team activity lists what each member does now, else its last run, newest first', () => {
  const members = [
    member('product-owner', { lastRun: run('a', { role: 'product-owner', endedAt: '2026-09-27T09:00:00.000Z' }) }),
    member('developer', { running: [run('b', { state: 'running', startedAt: '2026-09-27T11:00:00.000Z' })], lastRun: run('old', { endedAt: '2026-09-27T08:00:00.000Z' }) }),
    member('qa'),
  ];
  assert.deepEqual(
    teamActivity(members).map((r) => r.id),
    ['b', 'a'],
  );
  assert.equal(workingCount(members), 1);
});

test('agent names and paths are cleaned as the API takes them', () => {
  assert.equal(agentNameFor('Tech writer'), 'tech-writer');
  assert.equal(agentNameFor('Diseñador UX'), 'disenador-ux');
  assert.deepEqual(cleanWrites([' docs/** ', '', 'docs/**', 'apps/**']), ['docs/**', 'apps/**']);
});

test("the Team tab's address keeps the project and names the section and the member", () => {
  const params = new URLSearchParams('project=p1&view=team');
  assert.equal(teamSearch(params, { section: 'flow' }), '?project=p1&view=team&section=flow');
  assert.equal(teamSearch(new URLSearchParams('project=p1&view=team&section=flow'), { section: 'members' }), '?project=p1&view=team');
  assert.equal(teamSearch(params, { member: 'qa' }), '?project=p1&view=team&member=qa');
  assert.equal(teamSearch(new URLSearchParams('view=team&member=qa'), { member: null }), '?view=team');
});

test("a member's writes read three ways: no writes is anywhere, an empty list is only the documents folder", () => {
  assert.equal(writeScope(undefined), 'anywhere');
  assert.equal(writeScope([]), 'documents');
  assert.equal(writeScope(['src/']), 'paths');
  assert.equal(writesFor('anywhere', ['src/']), undefined);
  assert.deepEqual(writesFor('documents', ['src/']), []);
  assert.deepEqual(writesFor('paths', [' src/ ', '', 'src/']), ['src/']);
  assert.ok(sameWrites(undefined, undefined));
  assert.ok(!sameWrites(undefined, []));
  assert.ok(sameWrites(['a'], ['a']));
});

test("saving a member's model keeps a member that may write anywhere writing anywhere", () => {
  // The Flow screen saved `writes: member.writes ?? []`, which turned "anywhere" into "only documents"
  const anywhere = member('developer', { model: 'sonnet' });
  const body = memberBody(anywhere, { model: 'opus' });
  assert.equal(body.model, 'opus');
  assert.ok(!('writes' in body));
  assert.deepEqual(memberBody(member('qa', { writes: [] })).writes, []);
  assert.deepEqual(memberBody(member('dev', { writes: ['src/'] }), { writes: null }), { role: 'dev', model: 'sonnet', responsibility: '' });
  assert.deepEqual(memberBody(anywhere, { writes: ['docs/'] }).writes, ['docs/']);
});
