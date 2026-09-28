import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSISTANT_PROPOSAL_KINDS,
  ASSISTANT_PROPOSAL_KINDS_OF_RUN,
  ASSISTANT_RUN_KINDS,
  assistantOnCreateByDefault,
  assistantResourcePath,
  PROJECT_TEMPLATE_IDS,
} from '../src/index.ts';

test('the wizard proposes a team, resources and tasks for every template but Simple', () => {
  const on = PROJECT_TEMPLATE_IDS.filter(assistantOnCreateByDefault);
  assert.deepEqual(on, ['software', 'library', 'research', 'custom']);
});

test('a resource is saved where /config/resources keeps its kind, in either scope', () => {
  assert.equal(assistantResourcePath('agents', 'migration-reviewer', 'project'), '.claude/agents/migration-reviewer.md');
  assert.equal(assistantResourcePath('commands', 'openapi', 'project'), '.claude/commands/openapi.md');
  // A skill is its directory, with SKILL.md inside
  assert.equal(assistantResourcePath('skills', 'design-tokens', 'project'), '.claude/skills/design-tokens/');
  assert.equal(assistantResourcePath('agents', 'glossary-reviewer', 'user'), 'agents/glossary-reviewer.md');
});

test('every run kind proposes something, and a project run proposes every kind', () => {
  for (const kind of ASSISTANT_RUN_KINDS) assert.ok(ASSISTANT_PROPOSAL_KINDS_OF_RUN[kind].length > 0, kind);
  assert.deepEqual([...ASSISTANT_PROPOSAL_KINDS_OF_RUN.project], [...ASSISTANT_PROPOSAL_KINDS]);
});
