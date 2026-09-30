import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandRule, ToolPolicy } from '@agentry/shared';
import { commandRules, editRules, translateClaudePolicy } from '../src/providers/claude-code/policy.ts';
import {
  LEGACY_ASSISTANT_RULES,
  LEGACY_DENIED_READS,
  LEGACY_PLANNER_ALLOWED,
  LEGACY_TOOL_PRESETS,
  legacyCheckCommandRules,
  legacyIntegrationAllowed,
  legacyStageRules,
  legacyVerificationAllowed,
  legacyWorkflowAllowed,
  type LegacyCheckCommand,
  type LegacyStage,
} from './fixtures/legacy-tool-rules.ts';

// The policy table of docs/plans/multi-provider.md ("old rule → policy"), each row translated by the
// Claude driver and compared with a frozen copy of the rules Agentry built before policies. Order
// inside a flag's list carries no meaning to the CLI, so the sets are compared.

const sorted = (list: readonly string[] | undefined): string[] => [...new Set(list ?? [])].sort();
const GIT_READS = ['status', 'diff', 'log', 'show'];

const CHECKS: readonly (readonly LegacyCheckCommand[])[] = [
  [],
  [{ command: 'pnpm test', alone: true, withArgs: true }],
  [
    { command: 'make test', alone: true, withArgs: false },
    { command: 'go test', alone: false, withArgs: true },
    { command: 'cargo test', alone: true, withArgs: true },
  ],
];
const DOCUMENTS = ['docs', './specs/', 'a b', 'docs/*', '../up', '/abs', 'x,y', 'x(y)', ''];
const WRITES: readonly (readonly string[] | undefined)[] = [undefined, [], ['src'], ['src', 'packages/*/lib', '../out', '/etc', 'a,b'], ['./src/', ' web ']];
const COMMANDS: readonly (readonly string[] | undefined)[] = [undefined, [], ['npm test'], ['pnpm *', 'git status', '*', 'x()', ''], ['make']];

interface Stage {
  permissionMode: string;
  policy: ToolPolicy;
}

/** The flow's stages as policies, with the mode each keeps choosing beside its policy */
function stagePolicy(stage: LegacyStage, writes: readonly string[] | undefined, extra: { documentsPath: string; checks: readonly LegacyCheckCommand[]; commands?: readonly string[] | undefined }): Stage {
  if (stage === 'refine') {
    return { permissionMode: 'dontAsk', policy: { read: { allow: true }, edit: { allow: [extra.documentsPath] }, commands: { allow: 'none' }, network: 'omit', gitPush: 'deny' } };
  }
  if (stage === 'verify') {
    const git: CommandRule[] = GIT_READS.flatMap((c): CommandRule[] => [
      { command: `git ${c}`, args: 'none' },
      { command: `git ${c}`, args: 'some' },
    ]);
    const checks: CommandRule[] = extra.checks.flatMap((c): CommandRule[] => [
      ...(c.alone ? [{ command: c.command, args: 'none' as const }] : []),
      ...(c.withArgs ? [{ command: c.command, args: 'some' as const }] : []),
    ]);
    return {
      permissionMode: 'dontAsk',
      policy: {
        read: { allow: true },
        edit: { allow: [extra.documentsPath] },
        commands: { allow: [...git, ...checks], deny: ['diff', 'log', 'show'].map((c) => ({ pattern: `git ${c} *--output*` })) },
        network: 'omit',
        gitPush: 'deny',
      },
    };
  }
  const commands = extra.commands;
  const shell: ToolPolicy['commands'] = { allow: commands ? commands.map((pattern) => ({ pattern })) : 'any' };
  const policy: ToolPolicy = {
    read: { allow: true },
    edit: { allow: writes ? [...writes, extra.documentsPath] : 'any' },
    commands: shell,
    network: 'allow',
    gitPush: 'deny',
  };
  return { permissionMode: !writes && !commands ? 'acceptEdits' : 'dontAsk', policy };
}

test('every flow stage translates to the rules stageRules built', () => {
  let rows = 0;
  for (const stage of ['refine', 'work', 'verify'] as const) {
    for (const documentsPath of DOCUMENTS) {
      for (const checks of CHECKS) {
        for (const writes of WRITES) {
          for (const commands of COMMANDS) {
            const legacy = legacyStageRules(stage, writes, { documentsPath, testCommands: legacyCheckCommandRules(checks), commands });
            const now = stagePolicy(stage, writes, { documentsPath, checks, commands });
            const { rules, unsupported } = translateClaudePolicy(now.policy);
            const at = JSON.stringify({ stage, documentsPath, checks, writes, commands });
            assert.equal(now.permissionMode, legacy.permissionMode, at);
            assert.deepEqual(sorted(rules.allowedTools), sorted(legacy.allowedTools), `allowed: ${at}`);
            assert.deepEqual(sorted(rules.disallowedTools), sorted(legacy.disallowedTools), `denied: ${at}`);
            assert.equal(rules.tools, undefined, at);
            assert.deepEqual(unsupported, [], at);
            rows += 1;
          }
        }
      }
    }
  }
  assert.ok(rows > 500);
});

test('the assistant translates to its confined, read-only rules', () => {
  const policy: ToolPolicy = {
    read: { allow: true, denyPaths: LEGACY_DENIED_READS.map((r) => r.slice('Read('.length, -1)) },
    edit: { allow: 'none', deny: true },
    commands: { allow: 'none', deny: 'all' },
    network: 'deny',
    delegate: 'deny',
    gitPush: 'omit',
    exclusive: true,
  };
  const { rules, unsupported } = translateClaudePolicy(policy);
  assert.deepEqual(sorted(rules.allowedTools), sorted(LEGACY_ASSISTANT_RULES.allowedTools));
  assert.deepEqual(sorted(rules.disallowedTools), sorted(LEGACY_ASSISTANT_RULES.disallowedTools));
  assert.deepEqual(sorted(rules.tools), sorted(LEGACY_ASSISTANT_RULES.tools));
  assert.deepEqual(unsupported, []);
});

test('the orchestrator runs translate to their rules, the integration and verification ones plus NotebookEdit', () => {
  const noPush = { network: 'omit', gitPush: 'omit' } as const;
  const planner = translateClaudePolicy({ read: { allow: true }, edit: { allow: 'none' }, commands: { allow: 'none' }, ...noPush });
  assert.deepEqual(sorted(planner.rules.allowedTools), sorted(LEGACY_PLANNER_ALLOWED));
  assert.deepEqual(planner.rules.disallowedTools, []);

  for (const native of [[], ['Bash(npm:*)', 'Read']]) {
    const integration = translateClaudePolicy({ read: { allow: true }, edit: { allow: 'any' }, commands: { allow: [{ command: 'git', args: 'prefix' }] }, ...noPush });
    assert.deepEqual(sorted([...native, ...integration.rules.allowedTools]), sorted([...legacyIntegrationAllowed(native), 'NotebookEdit']));

    const verification = translateClaudePolicy({ read: { allow: true }, edit: { allow: 'any' }, commands: { allow: 'any' }, ...noPush });
    assert.deepEqual(sorted([...native, ...verification.rules.allowedTools]), sorted([...legacyVerificationAllowed(native), 'NotebookEdit']));

    const workflow = translateClaudePolicy({ read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, workflow: 'allow', ...noPush });
    assert.deepEqual(sorted([...native, ...workflow.rules.allowedTools]), sorted(legacyWorkflowAllowed(native)));
    assert.deepEqual(workflow.rules.disallowedTools, []);
  }
});

test('the shipped presets translate to their rules, read-only also denying MultiEdit', () => {
  const git = (c: string): CommandRule => ({ command: `git ${c}`, args: 'prefix' });
  const policies: Record<string, ToolPolicy> = {
    'read-only': { read: { allow: true }, edit: { allow: 'none', deny: true }, commands: { allow: ['status', 'diff', 'log', 'show'].map(git) }, network: 'omit', gitPush: 'omit' },
    'no-network': {
      read: { allow: true },
      edit: { allow: 'any' },
      commands: { allow: 'any', deny: [{ command: 'curl', args: 'prefix' }, { command: 'wget', args: 'prefix' }] },
      network: 'deny',
      gitPush: 'omit',
    },
    everything: { read: { allow: true }, edit: { allow: 'any' }, commands: { allow: 'any' }, network: 'allow', gitPush: 'omit' },
  };
  for (const preset of LEGACY_TOOL_PRESETS) {
    const policy = policies[preset.id];
    assert.ok(policy, preset.id);
    const { rules, unsupported } = translateClaudePolicy(policy);
    assert.deepEqual(sorted(rules.allowedTools), sorted(preset.allowedTools), preset.id);
    const denied = preset.id === 'read-only' ? [...preset.disallowedTools, 'MultiEdit'] : preset.disallowedTools;
    assert.deepEqual(sorted(rules.disallowedTools), sorted(denied), preset.id);
    assert.deepEqual(unsupported, [], preset.id);
  }
});

test('each policy part gives its rules and nothing else', () => {
  const base: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'omit', gitPush: 'omit' };
  assert.deepEqual(translateClaudePolicy(base), { rules: { allowedTools: [], disallowedTools: [] }, unsupported: [] });
  const rulesOf = (change: Partial<ToolPolicy>) => translateClaudePolicy({ ...base, ...change }).rules;
  assert.deepEqual(rulesOf({ commands: { allow: [{ command: 'ls', args: 'none' }, { command: 'ls', args: 'some' }, { command: 'ls', args: 'prefix' }] } }).allowedTools, ['Bash(ls)', 'Bash(ls *)', 'Bash(ls:*)']);
  assert.deepEqual(rulesOf({ network: 'allow' }).allowedTools, ['WebFetch', 'WebSearch']);
  assert.deepEqual(rulesOf({ delegate: 'deny' }).disallowedTools, ['Task', 'Agent']);
  assert.deepEqual(rulesOf({ gitPush: 'deny' }).disallowedTools, ['Bash(git push)', 'Bash(git push *)']);
  assert.equal(rulesOf({ exclusive: true }).tools?.length, 0);
});

test('a pattern the rule cannot carry is left out of an allow and reported for a denial', () => {
  const allow = translateClaudePolicy({
    read: { allow: false },
    edit: { allow: ['ok', '../out', 'a,b'] },
    commands: { allow: [{ pattern: 'npm test' }, { pattern: 'x()' }, { pattern: '***' }] },
    network: 'omit',
    gitPush: 'omit',
  });
  assert.deepEqual(sorted(allow.rules.allowedTools), sorted(['Edit(ok)', 'Edit(ok/**)', 'Write(ok)', 'Write(ok/**)', 'NotebookEdit(ok)', 'NotebookEdit(ok/**)', 'Bash(npm test)']));
  assert.deepEqual(allow.unsupported, []);

  const deny = translateClaudePolicy({ read: { allow: true, denyPaths: ['a,b'] }, edit: { allow: 'none' }, commands: { allow: 'none', deny: [{ pattern: 'a)b' }, { pattern: 'ok *' }] }, network: 'omit', gitPush: 'omit' });
  assert.deepEqual(deny.rules.disallowedTools, ['Bash(ok *)']);
  assert.deepEqual(deny.unsupported, ['read.denyPaths', 'commands.deny']);
});

test('editRules and commandRules keep the rules flow.ts built', () => {
  assert.deepEqual(editRules(['docs', 'src/*']), ['Edit(docs)', 'Write(docs)', 'NotebookEdit(docs)', 'Edit(docs/**)', 'Write(docs/**)', 'NotebookEdit(docs/**)', 'Edit(src/*)', 'Write(src/*)', 'NotebookEdit(src/*)']);
  assert.deepEqual(commandRules(['npm test', 'x()', 'npm test']), ['Bash(npm test)']);
});
