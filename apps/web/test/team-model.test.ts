import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { FlowRun, TeamMember } from '@agentry/shared';
import {
  agentNameFor,
  backlogRunsFor,
  cleanWrites,
  commandProblem,
  commandScope,
  commandsFor,
  commandsProblem,
  columnsOf,
  flowOf,
  groupRuns,
  memberBody,
  proposedFlow,
  FREE_ROLE_HUES,
  roleFallbackName,
  roleHue,
  roleInitials,
  runDay,
  runDuration,
  runNote,
  runReason,
  runStep,
  sameFlow,
  sameWrites,
  savedFlow,
  setColumnRole,
  setMaxCost,
  setMaxParallel,
  settledFlow,
  stageOf,
  TEMPLATE_RESPONSIBILITIES,
  templateResponsibilityRole,
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
  step: 'work',
  column: 'in_progress',
  state: 'ended',
  chatId: null,
  outcome: 'passed',
  summary: null,
  error: null,
  cause: null,
  retryOf: null,
  queuedBy: null,
  retriedBy: null,
  retryable: false,
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

test("a role keeps the design's hue, and a named one takes a hue no status is told by", () => {
  assert.equal(roleHue('product-owner'), 300);
  assert.equal(roleHue('architect'), 215);
  assert.equal(roleHue('developer'), 90);
  assert.equal(roleHue('qa'), 330);
  assert.equal(roleHue('writer'), 45);
  // Red (bad), green (ok) and cyan (live) are the statuses' own
  const status = (hue: number) => hue < 25 || hue > 345 || (hue > 120 && hue < 200);
  for (const role of ['payments-security', 'data', 'ops', 'x', 'release-manager', 'designer', 'researcher', 'reviewer']) {
    assert.equal(status(roleHue(role)), false, role);
  }
  assert.ok(FREE_ROLE_HUES.every((hue) => !status(hue)));
  assert.equal(roleHue('payments-security'), roleHue('payments-security'), 'the same on every screen');
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

test('a failed run says why beside its outcome, and one that passed says what it did', () => {
  // The Team screen said "failed" and nothing else, and the item said nothing at all
  assert.equal(runNote(run('a', { outcome: 'failed', error: 'the account hit its rate limit', summary: null })), 'the account hit its rate limit');
  assert.equal(runNote(run('b', { outcome: 'failed', error: null })), null);
  assert.equal(runNote(run('c', { outcome: 'passed', summary: 'Wrote the criteria' })), 'Wrote the criteria');
  assert.equal(runNote(run('d', { state: 'running', outcome: null, error: 'x' })), null);
});

test('a project that never saved a flow has none: its columns answer to nobody until the proposal is saved', () => {
  // The Team screen drew the template's proposal as the flow, while the members said they answered for nothing
  const members = [member('product-owner'), member('developer'), member('qa')];
  assert.deepEqual(savedFlow({}).columns, {});
  assert.equal(savedFlow({}).enabled, false);
  assert.deepEqual(proposedFlow(members).columns, { backlog: 'product-owner', todo: 'product-owner', in_progress: 'developer', in_review: 'qa' });
  const flow = { enabled: true, columns: { in_progress: 'developer' }, maxBounces: 2 };
  assert.deepEqual(savedFlow({ flow }), flow);
  assert.notEqual(savedFlow({ flow }).columns, flow.columns);
});

test('creating suggestions in Backlog says how many flow runs it queues, as core decides it', () => {
  // "Create the selected" on eight suggestions queued eight refine runs with no word
  type Settings = NonNullable<Parameters<typeof backlogRunsFor>[0]>;
  const on: Settings = {
    modules: ['board', 'team'],
    team: { members: [{ role: 'product-owner', agent: 'product-owner', model: 'opus', responsibility: '' }] },
    flow: { enabled: true, columns: { backlog: 'product-owner' }, maxBounces: 3 },
  };
  const flow = on.flow ?? { enabled: false, columns: {}, maxBounces: 3 };
  const types = ['task', 'story', 'bug', 'epic'] as const;
  assert.deepEqual(backlogRunsFor(on, types), { count: 3, role: 'product-owner', parallel: 2 });
  assert.equal(backlogRunsFor({ ...on, flow: { ...flow, maxParallel: 4 } }, ['task'])?.parallel, 4);
  // Nothing is queued with the flow off, a module off, nobody on Backlog, a role with no member, or only epics
  assert.equal(backlogRunsFor({ ...on, flow: { ...flow, enabled: false } }, types), null);
  assert.equal(backlogRunsFor({ ...on, modules: ['board'] }, types), null);
  assert.equal(backlogRunsFor({ ...on, flow: { ...flow, columns: { todo: 'product-owner' } } }, types), null);
  assert.equal(backlogRunsFor({ ...on, team: { members: [] } }, types), null);
  assert.equal(backlogRunsFor(on, ['epic']), null);
  assert.equal(backlogRunsFor(undefined, types), null);
});

test('the Flow screen sets how many runs go at once and what one may spend, unlimited unless chosen', () => {
  // Both could only be set through the settings document: the Flow screen had no control for them
  const base = { enabled: true, columns: {}, maxBounces: 3 };
  assert.equal(setMaxParallel(base, 4).maxParallel, 4);
  // The default and out-of-range values: the default drops the key, the rest are held to 1..10
  assert.ok(!('maxParallel' in setMaxParallel({ ...base, maxParallel: 5 }, 2)));
  assert.ok(!('maxParallel' in setMaxParallel({ ...base, maxParallel: 5 }, undefined)));
  assert.equal(setMaxParallel(base, 0).maxParallel, 1);
  assert.equal(setMaxParallel(base, 99).maxParallel, 10);
  // A cost is rounded to cents and capped; empty or zero is no limit, and no key is saved for it
  assert.equal(setMaxCost(base, 2.345).maxCostUsd, 2.35);
  assert.equal(setMaxCost(base, 500).maxCostUsd, 100);
  assert.ok(!('maxCostUsd' in setMaxCost({ ...base, maxCostUsd: 3 }, undefined)));
  assert.ok(!('maxCostUsd' in setMaxCost({ ...base, maxCostUsd: 3 }, 0)));
  // A cost change is a change to save; typing "0" on the way to "0.5" settles to what is saved
  assert.equal(sameFlow(base, { ...base, maxCostUsd: 1 }), false);
  assert.equal(sameFlow(base, settledFlow({ ...base, maxCostUsd: 0, maxParallel: 2 })), true);
});

test("a member's shell commands read three ways, and saving another field keeps them", () => {
  // Saving the model from the Flow screen sent no commands, which the route reads as unrestricted
  assert.equal(commandScope(undefined), 'any');
  assert.equal(commandScope([]), 'none');
  assert.equal(commandScope(['pnpm test']), 'listed');
  assert.equal(commandsFor('any', ['x']), null);
  assert.deepEqual(commandsFor('none', ['x']), []);
  assert.deepEqual(commandsFor('listed', [' pnpm test ', 'pnpm test', '', 'npm run *']), ['pnpm test', 'npm run *']);
  const limited = member('developer', { commands: ['pnpm test'] });
  assert.deepEqual(memberBody(limited, { model: 'opus' }).commands, ['pnpm test']);
  assert.deepEqual(memberBody(member('qa', { commands: [] })).commands, []);
  assert.ok(!('commands' in memberBody(limited, { commands: null })));
  assert.ok(!('commands' in memberBody(member('dev'))));
  // What the route refuses is refused here first, so Save stays off with a reason
  assert.equal(commandProblem('pnpm *'), null);
  assert.equal(commandProblem('npm test, rm -rf /'), 'comma');
  assert.equal(commandProblem('*'), 'invalid');
  assert.equal(commandProblem('echo (x)'), 'invalid');
  assert.equal(commandsProblem(['pnpm test', 'a,b']), 'comma');
  assert.equal(commandsProblem(Array.from({ length: 51 }, (_, i) => `cmd ${i}`)), 'tooMany');
});

test("a responsibility still the template's is shown in the person's language; an edited one as written", () => {
  // Core writes the template's responsibilities in English, since Claude reads them
  assert.equal(templateResponsibilityRole(member('developer', { responsibility: 'Implements work items in their own worktree' })), 'developer');
  assert.equal(templateResponsibilityRole(member('developer', { responsibility: 'Implements work items, with tests' })), null);
  assert.equal(templateResponsibilityRole(member('tech-writer', { responsibility: 'Turns findings into documents' })), null);
  // The English the web recognises is the English core writes, word for word
  const core = readFileSync(new URL('../../../packages/core/src/project-templates.ts', import.meta.url), 'utf8');
  for (const [role, text] of Object.entries(TEMPLATE_RESPONSIBILITIES)) assert.ok(core.includes(`responsibility: '${text}'`), `${role} drifted from core`);
});

test("a run's duration runs from its start to its end, and a run that never started or has not ended has none", () => {
  assert.equal(runDuration({ startedAt: '2026-09-28T10:00:00.000Z', endedAt: '2026-09-28T10:03:40.000Z' }), 220_000);
  assert.equal(runDuration({ startedAt: null, endedAt: '2026-09-28T10:03:40.000Z' }), null);
  assert.equal(runDuration({ startedAt: '2026-09-28T10:00:00.000Z', endedAt: null }), null);
});

test('Team activity groups the runs: what runs or waits now first, then one group per day, newest first', () => {
  const now = new Date(2026, 8, 28, 12, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 0).toISOString();
  const runs = [
    run('q', { state: 'queued', outcome: null }),
    run('r', { state: 'running', outcome: null, startedAt: at(28, 11) }),
    run('a', { endedAt: at(28, 10) }),
    run('b', { endedAt: at(28, 9) }),
    run('c', { endedAt: at(27, 18) }),
    run('d', { endedAt: at(25, 16) }),
  ];
  assert.deepEqual(
    groupRuns(runs, now).map((group) => [group.kind === 'now' ? 'now' : group.days, group.runs.map((r) => r.id).join('')]),
    [
      ['now', 'rq'],
      [0, 'ab'],
      [1, 'c'],
      [3, 'd'],
    ],
  );
  // No "Now" group when nothing runs or waits
  assert.equal(groupRuns([run('a', { endedAt: at(28, 10) })], now)[0]?.kind, 'day');
});

test("today's figures count what runs or waits and what ended today, by member, failures apart", () => {
  const now = new Date(2026, 8, 28, 12, 0).getTime();
  const at = (day: number) => new Date(2026, 8, day, 10, 0).toISOString();
  const day = runDay(
    [
      run('1', { state: 'running', outcome: null, agent: 'qa' }),
      run('2', { state: 'queued', outcome: null, agent: 'developer' }),
      run('3', { outcome: 'failed', agent: 'product-owner', endedAt: at(28) }),
      run('4', { outcome: 'passed', agent: 'product-owner', endedAt: at(28) }),
      run('5', { outcome: 'failed', agent: 'product-owner', endedAt: at(27) }),
    ],
    now,
  );
  assert.deepEqual({ runs: day.runs, running: day.running, queued: day.queued, failed: day.failed }, { runs: 4, running: 1, queued: 1, failed: 1 });
  assert.deepEqual(day.byAgent['product-owner'], { runs: 2, failed: 1 });
  assert.deepEqual(day.byAgent.qa, { runs: 1, failed: 0 });
});

test("a run's step is its column's, and its reason is its cause, or unknown, only when it failed or was cancelled", () => {
  assert.equal(runStep({ step: 'check', stage: 'refine', column: 'todo' }), 'check');
  assert.equal(runReason({ outcome: 'failed', cause: 'no-account' }), 'no-account');
  assert.equal(runReason({ outcome: 'failed', cause: null }), 'unknown');
  assert.equal(runReason({ outcome: 'cancelled', cause: 'item-removed' }), 'item-removed');
  assert.equal(runReason({ outcome: 'passed', cause: null }), null);
  assert.equal(runReason({ outcome: null, cause: null }), null);
});
