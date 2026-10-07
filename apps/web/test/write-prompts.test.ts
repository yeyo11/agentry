import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
// The helper reads the global i18next, which the app's instance sets up
const { default: i18n } = await import('i18next');
await import('../src/i18n/index.ts');
const { describeWrite } = await import('@agentry/chat-ui/lib/write-prompts');

const P = 'mcp__agentry__';
// packages/mcp/src/write-tools.ts
const WRITE_TOOLS = [
  'create_work_item',
  'update_work_item',
  'move_work_item',
  'comment_work_item',
  'retry_flow_run',
  'retry_orchestration_task',
  'start_chat',
  'accept_assistant_proposal',
  'discard_assistant_proposal',
];

test('every write tool has a title in the person’s words', async () => {
  for (const language of ['en', 'es']) {
    await i18n.changeLanguage(language);
    for (const name of WRITE_TOOLS) {
      const prompt = describeWrite(`${P}${name}`, {});
      assert.ok(prompt, name);
      assert.doesNotMatch(prompt.title, /_|mcp__|\{\{/, `${language} ${name}`);
    }
  }
  await i18n.changeLanguage('en');
});

test('titles and details come from the input', async () => {
  await i18n.changeLanguage('en');
  assert.equal(describeWrite(`${P}move_work_item`, { item: 'cw-12', status: 'in_review' })?.title, 'Move CW-12 to In review');
  const create = describeWrite(`${P}create_work_item`, { projectId: 'p1', title: 'Fix login', priority: 'high', description: 'Why it fails' });
  assert.equal(create?.title, 'Create task: Fix login');
  assert.equal(create?.detail, 'Why it fails\nPriority: high');
  assert.equal(describeWrite(`${P}comment_work_item`, { item: 'CW-3', body: 'Looks done' })?.detail, 'Looks done');
  assert.equal(describeWrite(`${P}update_work_item`, { item: 'abc123', title: 'New' })?.title, 'Change a work item');
});

test('Spanish says the same in Spanish, with no wire names', async () => {
  await i18n.changeLanguage('es');
  try {
    assert.equal(describeWrite(`${P}move_work_item`, { item: 'CW-12', status: 'in_review' })?.title, 'Mover CW-12 a En revisión');
    assert.equal(describeWrite(`${P}create_work_item`, { title: 'Arreglar', type: 'bug' })?.title, 'Crear bug: Arreglar');
    const shown = JSON.stringify(describeWrite(`${P}create_work_item`, { title: 'x', status: 'in_progress', priority: 'urgent' }));
    assert.doesNotMatch(shown, /in_progress|urgent\b|projectId/);
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('other tools keep their prompt', () => {
  assert.equal(describeWrite('Bash', { command: 'ls' }), null);
  assert.equal(describeWrite(`${P}list_projects`, {}), null);
});
