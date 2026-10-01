import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantPolicy, DENIED_TOOLS, READ_ONLY_TOOLS } from '../src/assistant.ts';
import { DEFAULT_TOOL_PRESETS } from '../src/chat-tools.ts';
import { stagePolicy, stageRules } from '../src/flow.ts';
import { PolicyUnsupportedError, rulesFor } from '../src/tool-policy.ts';
import {
  LEGACY_ASSISTANT_RULES,
  LEGACY_TOOL_PRESETS,
  legacyStageRules,
  type LegacyStage,
} from './fixtures/legacy-tool-rules.ts';

const sorted = (list: readonly string[] | undefined): string[] => [...new Set(list ?? [])].sort();

test('rulesFor appends the native rules after the translation, without repeats', () => {
  const rules = rulesFor('claude-code', { read: { allow: true }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'omit', gitPush: 'deny' }, { allowedTools: ['Bash(ls)', 'Read'], disallowedTools: ['Edit'] });
  assert.deepEqual(rules.allowedTools, ['Read', 'Glob', 'Grep', 'Bash(ls)']);
  assert.deepEqual(rules.disallowedTools, ['Bash(git push)', 'Bash(git push *)', 'Edit']);
  assert.equal(rules.tools, undefined);
});

test('rulesFor refuses a provider with no translation, and a part the driver cannot carry', () => {
  const policy = { read: { allow: true }, edit: { allow: 'none' as const }, commands: { allow: 'none' as const }, network: 'omit' as const, gitPush: 'omit' as const };
  assert.throws(() => rulesFor('codex', policy), PolicyUnsupportedError);
  assert.throws(() => rulesFor('claude-code', { ...policy, read: { allow: true, denyPaths: ['a,b'] } }), (err: unknown) => err instanceof PolicyUnsupportedError && err.unsupported.includes('read.denyPaths'));
});

test('stageRules, now built from stagePolicy, gives the rules the flow always gave', () => {
  const stages: LegacyStage[] = ['refine', 'work', 'verify'];
  for (const stage of stages) {
    for (const writes of [undefined, [], ['src', 'a/*']]) {
      for (const commands of [undefined, [], ['npm test', 'pnpm *']]) {
        const extra = { documentsPath: 'docs', testCommands: ['Bash(pnpm test)', 'Bash(pnpm test *)'], commands };
        const now = stageRules(stage, writes, extra);
        const was = legacyStageRules(stage, writes, extra);
        assert.equal(now.permissionMode, was.permissionMode);
        assert.deepEqual(sorted(now.allowedTools), sorted(was.allowedTools));
        assert.deepEqual(sorted(now.disallowedTools), sorted(was.disallowedTools));
      }
    }
  }
  assert.equal(stagePolicy('work', undefined, { documentsPath: 'docs', checks: [] }).permissionMode, 'acceptEdits');
});

test('the assistant keeps its lists, derived from its policy', () => {
  assert.deepEqual(sorted(READ_ONLY_TOOLS), sorted(LEGACY_ASSISTANT_RULES.allowedTools));
  assert.deepEqual(sorted(DENIED_TOOLS), sorted(LEGACY_ASSISTANT_RULES.disallowedTools));
  assert.deepEqual(sorted(rulesFor('claude-code', assistantPolicy()).tools), sorted(LEGACY_ASSISTANT_RULES.tools));
});

test('the shipped presets carry their policy and its rules, read-only denying MultiEdit too', () => {
  for (const legacy of LEGACY_TOOL_PRESETS) {
    const preset = DEFAULT_TOOL_PRESETS.find((p) => p.id === legacy.id);
    assert.ok(preset?.policy, legacy.id);
    assert.deepEqual(sorted(preset.allowedTools), sorted(legacy.allowedTools));
    const denied = legacy.id === 'read-only' ? [...legacy.disallowedTools, 'MultiEdit'] : legacy.disallowedTools;
    assert.deepEqual(sorted(preset.disallowedTools), sorted(denied));
  }
});
