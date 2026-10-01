import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolPolicy } from '@agentry/shared';
import { launchSettings, translateCodexPolicy } from '../src/providers/codex/policy.ts';
import { effectiveSandbox, modeSettings } from '../src/providers/codex/session.ts';

const BASE: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'omit', gitPush: 'omit' };

test('nothing writable is a read-only sandbox, and edits to chosen paths are judged one by one', () => {
  assert.equal(launchSettings(translateCodexPolicy(BASE)).sandbox, 'read-only');
  const paths = translateCodexPolicy({ ...BASE, edit: { allow: ['docs'] } });
  assert.equal(launchSettings(paths).sandbox, 'workspace-write');
  assert.deepEqual(paths.host, ['edit']);
});

test('a list of commands is enforceable only where nothing can be written', () => {
  const list = { allow: [{ command: 'git status', args: 'none' as const }] };
  assert.deepEqual(translateCodexPolicy({ ...BASE, commands: list }).unsupported, []);
  assert.deepEqual(translateCodexPolicy({ ...BASE, edit: { allow: 'any' }, commands: list }).unsupported, ['commands.allow']);
  assert.deepEqual(translateCodexPolicy({ ...BASE, edit: { allow: 'any' }, commands: { allow: 'any' } }).unsupported, []);
});

test('a policy that denies a push has no network in the sandbox and leaves commands to the judge', () => {
  const translation = translateCodexPolicy({ ...BASE, commands: { allow: 'any' }, gitPush: 'deny' });
  assert.ok(translation.settings?.some((s) => s.part === 'gitPush'));
  assert.deepEqual(translation.host?.sort(), ['commands', 'gitPush']);
});

test('web search and an exclusive session become inline config for thread/start', () => {
  const live = launchSettings(translateCodexPolicy({ ...BASE, network: 'allow' }));
  assert.deepEqual(live.config, { web_search: 'live' });
  const off = launchSettings(translateCodexPolicy({ ...BASE, network: 'deny', exclusive: true }));
  assert.deepEqual(off.config, { web_search: 'disabled', mcp_servers: {} });
});

test('what Codex cannot do is listed, never silently dropped', () => {
  const translation = translateCodexPolicy({ ...BASE, read: { allow: true, denyPaths: ['.env'] }, delegate: 'deny', workflow: 'allow' });
  assert.deepEqual(translation.unsupported.sort(), ['delegate', 'read.denyPaths', 'workflow']);
});

test('the policy narrows the mode and never widens it', () => {
  const readOnly = translateCodexPolicy(BASE);
  const writable = translateCodexPolicy({ ...BASE, edit: { allow: 'any' } });
  assert.equal(effectiveSandbox('manual', readOnly).sandbox, 'read-only');
  assert.equal(effectiveSandbox('plan', writable).sandbox, 'read-only');
  assert.equal(effectiveSandbox('manual', writable).sandbox, 'workspace-write');
  assert.deepEqual(effectiveSandbox('bypassPermissions', readOnly), { approvalPolicy: 'never', sandbox: 'danger-full-access' });
  assert.equal(modeSettings('auto'), null);
});
