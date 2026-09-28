import assert from 'node:assert/strict';
import test from 'node:test';
import en from '../src/i18n/locales/en/projects.json' with { type: 'json' };
import es from '../src/i18n/locales/es/projects.json' with { type: 'json' };
import { asProjectView, projectViews } from '../src/pages/dashboard/views.ts';
import { columnLimitsOf, deriveKeyPrefix, FOLDER_NAME, LIMIT_STATUSES, folderNameFor, limitedColumns, normalizePrefix, prefixProblem, sameModules, toggleModule } from '../src/pages/projects/model.ts';

// The wizard previews the prefix the server will derive, and the settings refuse what the API
// would refuse before sending it, so both have to agree with core's rules.

test('the previewed prefix follows core: initials of several words, consonants of one', () => {
  const none = new Set<string>();
  assert.equal(deriveKeyPrefix('claude wrapper', none), 'CW');
  assert.equal(deriveKeyPrefix('MyShop', none), 'MS');
  assert.equal(deriveKeyPrefix('Agentry', none), 'AGN');
  assert.equal(deriveKeyPrefix('pagos-api', none), 'PA');
  assert.equal(deriveKeyPrefix('Ñandú', none), 'NND');
  assert.equal(deriveKeyPrefix('x', none), 'PRJ');
  assert.equal(deriveKeyPrefix('Agentry', new Set(['AGN', 'AGN2'])), 'AGN3');
});

test('a prefix is refused empty, off the pattern or taken, and typed in upper case', () => {
  const taken = new Set(['AGN']);
  assert.equal(prefixProblem('', taken), 'empty');
  assert.equal(prefixProblem('A', taken), 'pattern');
  assert.equal(prefixProblem('1AB', taken), 'pattern');
  assert.equal(prefixProblem('AGN', taken), 'taken');
  assert.equal(prefixProblem('CW2', taken), null);
  assert.equal(normalizePrefix('cw-2 x'), 'CW2X');
  assert.equal(normalizePrefix('abcdefghijkl'), 'ABCDEFGHIJ');
});

test('modules keep their fixed order whatever order they were switched in', () => {
  assert.deepEqual(toggleModule(['memory'], 'board', true), ['board', 'memory']);
  assert.deepEqual(toggleModule(['board', 'memory'], 'board', false), ['memory']);
  assert.equal(sameModules(['memory', 'board'], ['board', 'memory']), true);
  assert.equal(sameModules(['board'], ['board', 'memory']), false);
});

test('the limits read in board order', () => {
  assert.deepEqual(limitedColumns({ columnLimits: { in_review: 3, in_progress: 2 } }), [
    { status: 'in_progress', limit: 2 },
    { status: 'in_review', limit: 3 },
  ]);
  assert.deepEqual(limitedColumns(undefined), []);
});

test('a tab exists only while its module is on', () => {
  assert.deepEqual(projectViews([]), ['resources', 'worktrees', 'settings']);
  assert.deepEqual(projectViews(['board', 'team', 'documents', 'memory']), ['board', 'team', 'documents', 'memory', 'resources', 'worktrees', 'settings']);
  assert.deepEqual(projectViews(['memory']), ['memory', 'resources', 'worktrees', 'settings']);
  assert.deepEqual(projectViews(['team']), ['team', 'resources', 'worktrees', 'settings']);
  assert.deepEqual(projectViews(['documents']), ['documents', 'resources', 'worktrees', 'settings']);
  assert.equal(asProjectView('documents'), 'documents');
  assert.equal(asProjectView('board'), 'board');
  assert.equal(asProjectView('team'), 'team');
});

test("the wizard's team line says the roles become agent files once accepted, now that the Team module writes them", () => {
  // Orchestration 2 wrote it while nothing created agents: "nothing is written to .claude/agents/ yet"
  for (const hint of [en.wizard.teamHint, es.wizard.teamHint]) {
    assert.match(hint, /\.claude\/agents\//);
    assert.doesNotMatch(hint, /\byet\b|todavía|nothing is written|no se escribe/i);
  }
});

test("a new project's folder takes what it can of the name, so a name with spaces or accents is not refused", () => {
  // The wizard sent the name as the folder, and core refused it after "Create project", in English
  assert.equal(folderNameFor('Mi proyecto'), 'Mi-proyecto');
  assert.equal(folderNameFor('Página de pagos'), 'Pagina-de-pagos');
  assert.equal(folderNameFor('  api.v2  '), 'api.v2');
  assert.equal(folderNameFor('-- ¿Qué? --'), 'Que');
  assert.equal(folderNameFor('¡¡!!'), '');
  assert.equal(folderNameFor('x'.repeat(80)).length, 64);
  for (const name of ['Mi proyecto', 'Página de pagos', 'api.v2', 'ñandú 2026', '.hidden', '_tmp', 'a/b\\c'])
    assert.match(folderNameFor(name), FOLDER_NAME, name);
});

test('Done takes no limit: it only grows, so a limit there would warn for good', () => {
  assert.deepEqual(LIMIT_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review']);
  assert.deepEqual(columnLimitsOf({ in_review: 3, done: 10 }), { in_review: 3 });
  assert.deepEqual(limitedColumns({ columnLimits: { done: 5, todo: 2 } }), [{ status: 'todo', limit: 2 }]);
});
