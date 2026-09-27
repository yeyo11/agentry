import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentryEvent, ProjectSettings } from '@agentry/shared';
import { PROJECT_MODULES, PROJECT_TEMPLATE_IDS, WORK_ITEM_KEY_PREFIX_PATTERN } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { deriveKeyPrefix, parseProjectSettings, parseProjectSetup, settingsChanges } from '../src/project-settings.ts';
import { PROJECT_TEMPLATES, projectTemplate } from '../src/project-templates.ts';
import { tempConfig } from './helpers.ts';

const none = new Set<string>();
const dir = () => mkdtempSync(join(tmpdir(), 'agentry-proj-'));

/** A Core over scratch directories, closed however the test ends. */
async function withCore(fn: (core: Core, config: ReturnType<typeof tempConfig>) => Promise<void>, config = tempConfig()): Promise<void> {
  const core = new Core(config);
  try {
    await fn(core, config);
  } finally {
    core.db.close();
  }
}

const valid = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({
  modules: ['board'],
  template: 'software',
  keyPrefix: 'SHOP',
  board: { types: ['task', 'bug'], columnLimits: { in_progress: 3 } },
  ...over,
});

test('a key prefix is made from the initials of a name, or from a single word and its consonants', () => {
  assert.equal(deriveKeyPrefix('Agentry', none), 'AGN');
  assert.equal(deriveKeyPrefix('claude wrapper', none), 'CW');
  assert.equal(deriveKeyPrefix('my-online_shop', none), 'MOS');
  assert.equal(deriveKeyPrefix('MyShop', none), 'MS');
  // Accents are dropped rather than splitting a word
  assert.equal(deriveKeyPrefix('Gestión', none), 'GST');
  // Never more than five letters, never a digit from the name
  assert.equal(deriveKeyPrefix('a b c d e f g', none), 'ABCDE');
  assert.equal(deriveKeyPrefix('project 2', none), 'PRJ');
  // A word of vowels still has letters to give
  assert.equal(deriveKeyPrefix('Aeo', none), 'AEO');
  assert.equal(deriveKeyPrefix('io', none), 'IO');
  // Nothing to make one from
  assert.equal(deriveKeyPrefix('x', none), 'PRJ');
  assert.equal(deriveKeyPrefix('42', none), 'PRJ');
  assert.equal(deriveKeyPrefix('', none), 'PRJ');
  for (const name of ['Agentry', 'claude wrapper', 'x', 'a b c d e f g']) assert.match(deriveKeyPrefix(name, none), WORK_ITEM_KEY_PREFIX_PATTERN);
});

test('a key prefix already taken gets a digit, the lowest free one', () => {
  assert.equal(deriveKeyPrefix('Agentry', new Set(['AGN'])), 'AGN2');
  assert.equal(deriveKeyPrefix('Agentry', new Set(['AGN', 'AGN2', 'AGN3'])), 'AGN4');
  assert.equal(deriveKeyPrefix('Agentry', new Set(['AGN2'])), 'AGN');
});

test('the five templates are data: each has its modules, a board with types, and Simple and Custom switch nothing on', () => {
  assert.deepEqual(
    PROJECT_TEMPLATES.map((t) => t.id),
    [...PROJECT_TEMPLATE_IDS],
  );
  for (const t of PROJECT_TEMPLATES) {
    assert.ok(t.name && t.description, t.id);
    assert.ok(t.board.types.length > 0, t.id);
    for (const m of t.modules) assert.ok(PROJECT_MODULES.includes(m), `${t.id}: ${m}`);
  }
  assert.deepEqual(projectTemplate('simple').modules, []);
  assert.deepEqual(projectTemplate('custom').modules, []);
  assert.deepEqual(projectTemplate('software').modules, ['board', 'team', 'documents', 'memory']);
  // The plan's rule: Opus decides, Sonnet carries out
  const models = Object.fromEntries(projectTemplate('software').team.map((r) => [r.role, r.model]));
  assert.deepEqual(models, { 'product-owner': 'opus', architect: 'opus', developer: 'sonnet', qa: 'sonnet' });
  // A copy: editing what was handed out does not edit the template
  projectTemplate('software').modules.pop();
  assert.equal(projectTemplate('software').modules.length, 4);
});

test('a template and modules are checked before anything is created', () => {
  assert.deepEqual(parseProjectSetup({}), { template: null, modules: null });
  assert.deepEqual(parseProjectSetup({ template: 'library', modules: ['memory', 'board', 'board'] }), { template: 'library', modules: ['board', 'memory'] });
  assert.throws(() => parseProjectSetup({ template: 'enterprise' }), /unknown template enterprise/);
  assert.throws(() => parseProjectSetup({ modules: ['board', 'wiki'] }), /unknown module wiki/);
  assert.throws(() => parseProjectSetup({ modules: 'board' }), /modules must be an array/);
});

test('a settings document is validated whole: a bad value is refused, not replaced', () => {
  assert.deepEqual(parseProjectSettings(valid()), valid());
  // Lower case keys are raised; unknown fields dropped; a null limit is no limit
  const parsed = parseProjectSettings({ ...valid({ keyPrefix: 'shop' }), extra: true, board: { types: ['bug', 'bug'], columnLimits: { done: null } } });
  assert.equal(parsed.keyPrefix, 'SHOP');
  assert.equal('extra' in parsed, false);
  assert.deepEqual(parsed.board, { types: ['bug'], columnLimits: {} });

  const refused: Array<[unknown, RegExp]> = [
    [null, /must be a JSON object/],
    [[], /must be a JSON object/],
    [{ ...valid(), modules: ['wiki'] }, /unknown module/],
    [{ ...valid(), modules: undefined }, /modules must be an array/],
    [{ ...valid(), template: 'enterprise' }, /unknown template/],
    [{ ...valid(), keyPrefix: '1AB' }, /key must be/],
    [{ ...valid(), keyPrefix: 'A' }, /key must be/],
    [{ ...valid(), keyPrefix: 'ABCDEFGHIJK' }, /key must be/],
    [{ ...valid(), keyPrefix: 'AB-C' }, /key must be/],
    [{ ...valid(), board: undefined }, /board must be an object/],
    [{ ...valid(), board: { types: [], columnLimits: {} } }, /at least one type/],
    [{ ...valid(), board: { types: ['chore'], columnLimits: {} } }, /unknown work item type/],
    [{ ...valid(), board: { types: ['task'], columnLimits: { doing: 2 } } }, /unknown column doing/],
    [{ ...valid(), board: { types: ['task'], columnLimits: { todo: 0 } } }, /whole number from 1/],
    [{ ...valid(), board: { types: ['task'], columnLimits: { todo: 1.5 } } }, /whole number from 1/],
    [{ ...valid(), team: { members: [{ agent: '../evil', role: 'qa', model: 'sonnet', responsibility: 'x' }] } }, /agent file name/],
    [{ ...valid(), team: { members: [{ agent: 'qa', role: 'qa', model: 'sonnet', responsibility: 'x', writes: ['/etc'] }] } }, /inside the project/],
    [{ ...valid(), flow: { enabled: true, columns: {}, maxBounces: 99 } }, /maxBounces/],
    [{ ...valid(), flow: { enabled: 'yes', columns: {}, maxBounces: 2 } }, /flow.enabled/],
    [{ ...valid(), documents: { path: '../outside' } }, /inside the project/],
  ];
  for (const [input, error] of refused) assert.throws(() => parseProjectSettings(input), error, JSON.stringify(input));

  // What orchestration 3 will read is already well formed when it is stored
  const full = parseProjectSettings({
    ...valid(),
    team: { members: [{ agent: 'qa', role: 'qa', model: 'sonnet', responsibility: 'Verifies', writes: ['tests'] }] },
    flow: { enabled: false, columns: { in_review: 'qa' }, maxBounces: 3 },
    documents: { path: 'docs' },
  });
  assert.deepEqual(full.flow, { enabled: false, columns: { in_review: 'qa' }, maxBounces: 3 });
  assert.equal(full.team?.members[0]?.writes?.[0], 'tests');
});

test('what changed between two documents is named for the event', () => {
  const before = valid();
  assert.deepEqual(settingsChanges(before, valid()), []);
  assert.deepEqual(settingsChanges(before, valid({ keyPrefix: 'SH' })), ['key']);
  assert.deepEqual(settingsChanges(before, valid({ modules: [] })), ['modules']);
  assert.deepEqual(settingsChanges(before, valid({ board: { types: ['task'], columnLimits: {} } })), ['settings']);
});

test('a project imported without a template, or before modules existed, reads as every module off with a derived key', async () => {
  await withCore(async (core, config) => {
    const imported = await core.importProject({ path: dir(), name: 'Agentry' });
    assert.equal(imported.key, 'AGN');
    assert.deepEqual(imported.modules, []);
    const settings = await core.projectSettings(imported.id);
    assert.deepEqual(settings.modules, []);
    assert.equal(settings.template, null);
    assert.deepEqual(settings.board.columnLimits, {});

    // A project from before this existed has no document at all
    const file = join(config.dataDir, 'project-settings', `${imported.id}.json`);
    rmSync(file);
    const [project] = await core.projects();
    assert.deepEqual([project?.key, project?.modules], ['AGN', []]);
    // ...and gets one on that first read, so the prefix stays put from then on
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).settings.keyPrefix, 'AGN');
  });
});

test('two projects with the same name get different keys, even when read for the first time together', async () => {
  await withCore(async (core, config) => {
    const a = await core.importProject({ path: dir(), name: 'Shop' });
    const b = await core.importProject({ path: dir(), name: 'Shop' });
    assert.deepEqual([a.key, b.key], ['SHP', 'SHP2']);

    // Both documents gone: listing derives both at once and must not hand out the same prefix twice
    for (const p of [a, b]) rmSync(join(config.dataDir, 'project-settings', `${p.id}.json`));
    const keys = (await core.projects()).map((p) => p.key).sort();
    assert.deepEqual(keys, ['SHP', 'SHP2']);
  });
});

test('a template configures a new project, and modules replace its choice', async () => {
  await withCore(async (core) => {
    const software = await core.importProject({ path: dir(), name: 'App', template: 'software' });
    assert.deepEqual(software.modules, ['board', 'team', 'documents', 'memory']);
    const settings = await core.projectSettings(software.id);
    assert.equal(settings.template, 'software');
    assert.deepEqual(settings.board.columnLimits, { in_progress: 3, in_review: 2 });

    const library = await core.importProject({ path: dir(), name: 'Lib', template: 'library', modules: ['board'] });
    assert.deepEqual(library.modules, ['board']);
    assert.deepEqual((await core.projectSettings(library.id)).board.types, ['epic', 'task', 'bug']);

    const onlyModules = await core.importProject({ path: dir(), name: 'Notes', modules: ['memory', 'documents'] });
    assert.deepEqual(onlyModules.modules, ['documents', 'memory']);

    await assert.rejects(core.importProject({ path: dir(), template: 'enterprise' as never }), /unknown template/);
    assert.equal((await core.projects()).length, 3);
  });
});

test('creating a project with a bad template leaves no directory behind in the workspace', async () => {
  await withCore(async (core, config) => {
    await assert.rejects(core.createProject({ name: 'ghost', modules: ['wiki' as never] }), /unknown module/);
    assert.equal(existsSync(join(config.workspaceDir, 'ghost')), false);
    const created = await core.createProject({ name: 'real', template: 'research' });
    assert.deepEqual(created.modules, ['board', 'documents', 'memory']);
  });
});

test('a module switched off and on again finds its configuration intact', async () => {
  await withCore(async (core) => {
    const { id } = await core.importProject({ path: dir(), name: 'App', template: 'software' });
    const custom = { ...(await core.projectSettings(id)), board: { types: ['task' as const], columnLimits: { todo: 7 } } };
    await core.saveProjectSettings(id, custom);

    const off = await core.updateProject(id, { modules: ['team'] });
    assert.deepEqual(off.modules, ['team']);
    assert.deepEqual((await core.projectSettings(id)).board, { types: ['task'], columnLimits: { todo: 7 } });

    const on = await core.updateProject(id, { modules: ['board', 'team'] });
    assert.deepEqual(on.modules, ['board', 'team']);
    assert.deepEqual((await core.projectSettings(id)).board, { types: ['task'], columnLimits: { todo: 7 } });
  });
});

test('updating a project renames it, changes its key or modules, and emits what changed', async () => {
  await withCore(async (core) => {
    const events: AgentryEvent[] = [];
    core.events.subscribe((e) => events.push(e));
    const a = await core.importProject({ path: dir(), name: 'Alpha' });
    const b = await core.importProject({ path: dir(), name: 'Beta' });

    // A rename alone keeps working as it always has
    assert.equal((await core.updateProject(a.id, { name: '  Shop  ' })).name, 'Shop');
    const renamed = await core.updateProject(a.id, { key: 'shop', modules: ['board'] });
    assert.deepEqual([renamed.key, renamed.modules], ['SHOP', ['board']]);

    const updates = events.filter((e) => e.type === 'project.updated');
    assert.deepEqual(
      updates.map((e) => (e.type === 'project.updated' ? [e.projectId, e.projectName, e.changes, e.modules] : null)),
      [
        [a.id, 'Shop', ['name'], []],
        [a.id, 'Shop', ['key', 'modules'], ['board']],
      ],
    );

    // Nothing changed, nothing emitted
    await core.updateProject(a.id, { name: 'Shop', key: 'SHOP' });
    assert.equal(events.filter((e) => e.type === 'project.updated').length, 2);

    // A key another project holds is refused, and the rename beside it is not half applied
    await assert.rejects(core.updateProject(b.id, { name: 'Other', key: 'SHOP' }), /already used by another project/);
    assert.equal((await core.projects()).find((p) => p.id === b.id)?.name, 'Beta');

    await assert.rejects(core.updateProject(a.id, {}), /name, key or modules is required/);
    await assert.rejects(core.updateProject(a.id, { name: '  ' }), /name is required/);
    await assert.rejects(core.updateProject(a.id, { key: 'a' }), /key must be/);
    await assert.rejects(core.updateProject(a.id, { modules: ['wiki' as never] }), /unknown module/);
    await assert.rejects(core.updateProject('nope', { name: 'x' }), /project not found/);
  });
});

test('replacing the settings validates the document and emits project.updated', async () => {
  await withCore(async (core) => {
    const events: AgentryEvent[] = [];
    core.events.subscribe((e) => events.push(e));
    const { id } = await core.importProject({ path: dir(), name: 'Alpha' });
    const other = await core.importProject({ path: dir(), name: 'Beta' });

    const saved = await core.saveProjectSettings(id, valid());
    assert.deepEqual(saved, valid());
    assert.deepEqual(await core.projectSettings(id), valid());
    const event = events.find((e) => e.type === 'project.updated');
    assert.ok(event?.type === 'project.updated');
    assert.deepEqual(event.changes, ['key', 'modules', 'settings']);

    await assert.rejects(core.saveProjectSettings(id, { ...valid(), board: { types: [] } }), /at least one type/);
    await assert.rejects(core.saveProjectSettings(other.id, valid()), /already used by another project/);
    await assert.rejects(core.projectSettings('nope'), /project not found/);
    assert.deepEqual(await core.projectSettings(id), valid());
  });
});

test('a hand-edited document that does not validate falls back part by part instead of failing the list', async () => {
  await withCore(async (core, config) => {
    const { id } = await core.importProject({ path: dir(), name: 'Alpha', template: 'software' });
    const file = join(config.dataDir, 'project-settings', `${id}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.settings.board = { types: 'all' };
    writeFileSync(file, JSON.stringify(doc));
    const settings = await core.projectSettings(id);
    // The bad board is replaced; the modules beside it stay on
    assert.deepEqual(settings.modules, ['board', 'team', 'documents', 'memory']);
    assert.equal(settings.board.types.length, 4);

    writeFileSync(file, '{ not json');
    const [project] = await core.projects();
    assert.deepEqual(project?.modules, []);
  });
});

test('a project removed and imported again gets its id, settings and key back', async () => {
  const config = tempConfig();
  const path = dir();
  let id = '';
  await withCore(async (core) => {
    const first = await core.importProject({ path, name: 'Agentry', template: 'software' });
    id = first.id;
    await core.updateProject(id, { key: 'AGX' });
    await core.removeProject(id);
    assert.deepEqual(await core.projects(), []);
    // The document stays for when the directory comes back
    assert.ok(existsSync(join(config.dataDir, 'project-settings', `${id}.json`)));
    // A new project does not take the prefix the removed one still holds
    const other = await core.importProject({ path: dir(), name: 'AGX' });
    assert.equal(other.key, 'AGX2');
  }, config);

  // Also across a restart
  await withCore(async (core) => {
    const again = await core.importProject({ path });
    assert.equal(again.id, id);
    assert.equal(again.key, 'AGX');
    assert.deepEqual(again.modules, ['board', 'team', 'documents', 'memory']);
    assert.deepEqual((await core.projectSettings(id)).board.columnLimits, { in_progress: 3, in_review: 2 });
  }, config);
});

test('a project imported again whose key was taken meanwhile gets a new one, and modules asked for apply', async () => {
  await withCore(async (core) => {
    const path = dir();
    const first = await core.importProject({ path, name: 'Agentry', template: 'software' });
    await core.removeProject(first.id);
    const newcomer = await core.importProject({ path: dir(), name: 'Other' });
    // The person may reuse the prefix of a removed project explicitly
    await core.updateProject(newcomer.id, { key: 'AGN' });

    const again = await core.importProject({ path, name: 'Agentry', modules: ['memory'] });
    assert.equal(again.id, first.id);
    assert.equal(again.key, 'AGN2');
    assert.deepEqual(again.modules, ['memory']);
  });
});
