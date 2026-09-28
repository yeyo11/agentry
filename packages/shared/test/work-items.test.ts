import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkItemLinkRole } from '../src/index.ts';
import {
  AGENTRY_LANGUAGES,
  agentryLanguage,
  BOARD_DONE_PAGE,
  DEFAULT_FLOW_MAX_PARALLEL,
  FLOW_RUN_OUTCOMES,
  FLOW_RUN_STATUSES,
  FLOW_RUNS_PAGE,
  FLOW_RUNS_PAGE_MAX,
  flowRunStatus,
  isTeamCommandPattern,
  MAX_FLOW_PARALLEL,
  parseWorkItemKey,
  TEAM_COMMAND_MAX,
  teamCommandProblem,
  WORK_ITEMS_PAGE,
  WORK_ITEMS_PAGE_MAX,
  valuesOf,
  WORK_ITEM_KEY_PREFIX_PATTERN,
  WORK_ITEM_LINK_KINDS,
  WORK_ITEM_LINK_ROLES,
  WORK_ITEM_SOURCE_KINDS,
  WORK_ITEM_STATUSES,
  workItemBranch,
  workItemKey,
} from '../src/index.ts';

test('the board has five columns, backlog first and done last', () => {
  assert.deepEqual(WORK_ITEM_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review', 'done']);
});

test('a key round-trips through its prefix and number', () => {
  const key = workItemKey('AGN', 12);
  assert.equal(key, 'AGN-12');
  assert.deepEqual(parseWorkItemKey(key), { prefix: 'AGN', number: 12 });
  // Typed by hand in a search box
  assert.deepEqual(parseWorkItemKey('agn-12'), { prefix: 'AGN', number: 12 });
});

test('what is not a key parses to null instead of a half-read one', () => {
  for (const text of ['AGN', 'AGN-', 'AGN-0', 'AGN-012', '1AB-3', 'A-3', 'AGN-12-3', 'fix the build']) {
    assert.equal(parseWorkItemKey(text), null, text);
  }
});

test('a prefix a clash left with a digit is still a valid prefix', () => {
  assert.ok(WORK_ITEM_KEY_PREFIX_PATTERN.test('AGN'));
  assert.ok(WORK_ITEM_KEY_PREFIX_PATTERN.test('AGN2'));
  assert.ok(!WORK_ITEM_KEY_PREFIX_PATTERN.test('agn'));
  assert.ok(!WORK_ITEM_KEY_PREFIX_PATTERN.test('A'));
  assert.ok(!WORK_ITEM_KEY_PREFIX_PATTERN.test('2AG'));
});

test('an item is worked on a lower case task branch', () => {
  assert.equal(workItemBranch('AGN-12'), 'task/agn-12');
});

test('a value list cannot drift from its union, in either direction', () => {
  type Column = 'todo' | 'done';
  const columns = valuesOf<Column>()(['todo', 'done']);
  assert.deepEqual(columns, ['todo', 'done']);
  // Checked by the type check of this file: each line below must fail to compile
  // @ts-expect-error a member of the union left out of the list
  valuesOf<Column>()(['todo']);
  // @ts-expect-error a value the union does not have
  valuesOf<Column>()(['todo', 'done', 'doing']);
});

test('what can act on an item is a subset of what can be linked to it, and roles follow the columns', () => {
  for (const kind of WORK_ITEM_SOURCE_KINDS) assert.ok((WORK_ITEM_LINK_KINDS as readonly string[]).includes(kind));
  const byColumn: Record<'backlog' | 'todo' | 'in_progress' | 'in_review', WorkItemLinkRole> = {
    backlog: 'refine',
    todo: 'refine',
    in_progress: 'work',
    in_review: 'verify',
  };
  for (const role of Object.values(byColumn)) assert.ok(WORK_ITEM_LINK_ROLES.includes(role));
});

test('a run reads as one status: queued or running until it ends, then its outcome', () => {
  assert.equal(flowRunStatus({ state: 'queued', outcome: null }), 'queued');
  assert.equal(flowRunStatus({ state: 'running', outcome: null }), 'running');
  for (const outcome of FLOW_RUN_OUTCOMES) assert.equal(flowRunStatus({ state: 'ended', outcome }), outcome);
  // Every status the activity filters by is one a run can read as, and the other way round
  assert.deepEqual([...FLOW_RUN_STATUSES].sort(), ['cancelled', 'failed', 'passed', 'queued', 'rejected', 'running']);
});

test('a member command pattern is one printable line that cannot break out of its Bash rule', () => {
  for (const pattern of ['npm test', 'pnpm *', 'pnpm --filter web test', 'make check', 'npx tsc:*']) {
    assert.ok(isTeamCommandPattern(pattern), pattern);
  }
  const refused = ['', '   ', '*', ' * ', ':*', 'npm test\nnpm publish', 'npm test)', 'Bash(npm *)', ' npm test', 'x'.repeat(TEAM_COMMAND_MAX + 1), 12, null];
  for (const pattern of refused) assert.equal(isTeamCommandPattern(pattern), false, JSON.stringify(pattern));
  assert.ok(isTeamCommandPattern('x'.repeat(TEAM_COMMAND_MAX)));
});

test('a comma is refused in a member command pattern, with its own reason: the CLI gets the rules as one comma-joined list', () => {
  // `Bash(npm test, rm -rf /)` joined into `--allowedTools=` would reach the CLI as two rules
  for (const pattern of ['npm test, rm -rf /', 'a,b', ',', 'echo "1,2"']) {
    assert.equal(teamCommandProblem(pattern), 'comma', pattern);
    assert.equal(isTeamCommandPattern(pattern), false, pattern);
  }
  assert.equal(teamCommandProblem('pnpm *'), null);
  assert.equal(teamCommandProblem('npm test)'), 'invalid');
  assert.equal(teamCommandProblem('*'), 'invalid');
  assert.equal(teamCommandProblem(12), 'invalid');
  // A pattern that is wrong twice over names the comma, which says what to change
  assert.equal(teamCommandProblem('a,(b)'), 'comma');
});

test('the language of a request is the first of ours it names, English otherwise', () => {
  assert.equal(agentryLanguage('es-ES,es;q=0.9,en;q=0.8'), 'es');
  assert.equal(agentryLanguage('fr-FR,es;q=0.8,en;q=0.5'), 'es');
  assert.equal(agentryLanguage('en-GB,es;q=0.9'), 'en');
  assert.equal(agentryLanguage('es'), 'es');
  assert.equal(agentryLanguage('de-DE'), 'en');
  assert.equal(agentryLanguage(undefined), 'en');
  assert.equal(agentryLanguage(['es']), 'en');
  assert.deepEqual([...AGENTRY_LANGUAGES], ['en', 'es']);
});

test('pages are bounded, and the Done column starts smaller than a list page', () => {
  assert.ok(WORK_ITEMS_PAGE <= WORK_ITEMS_PAGE_MAX);
  assert.ok(BOARD_DONE_PAGE <= WORK_ITEMS_PAGE);
  assert.ok(FLOW_RUNS_PAGE <= FLOW_RUNS_PAGE_MAX);
  assert.ok(DEFAULT_FLOW_MAX_PARALLEL <= MAX_FLOW_PARALLEL);
});
