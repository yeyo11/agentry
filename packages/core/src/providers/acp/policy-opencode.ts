import type { CommandRule, PolicyTranslation, ToolPolicy } from '@agentry/shared';
import { HostParts, isPatternRule } from './policy-common.ts';

type Action = 'allow' | 'ask' | 'deny';

/** OpenCode's patterns for one rule: it matches the whole command line and `*` is the wildcard. */
function bashPatterns(rule: CommandRule): string[] {
  if (isPatternRule(rule)) return [rule.pattern];
  if (rule.args === 'none') return [rule.command];
  if (rule.args === 'some') return [`${rule.command} *`];
  return [rule.command, `${rule.command} *`];
}

/**
 * `ToolPolicy` as OpenCode's `permission` config (opencode.ai/docs/permissions), which the launch
 * passes inline in `OPENCODE_CONFIG_CONTENT`. "The last matching rule wins", so the bash map lists
 * allows first, then denials, and a `git push` denial last of all. Settings keys are
 * `permission.<name>`; two entries for one key merge in order. Pure.
 */
export function translateOpenCodePolicy(policy: ToolPolicy): PolicyTranslation {
  const settings: NonNullable<PolicyTranslation['settings']> = [];
  const unsupported: string[] = [];
  const host = new HostParts();
  const set = (part: NonNullable<PolicyTranslation['settings']>[number]['part'], name: string, value: Action | Record<string, Action>): void => {
    settings.push({ part, key: `permission.${name}`, value });
  };

  if (policy.read.allow) {
    const denied = policy.read.denyPaths ?? [];
    set('read', 'read', denied.length > 0 ? { '*': 'allow', ...Object.fromEntries(denied.map((p): [string, Action] => [p, 'deny'])) } : 'allow');
  } else if (policy.read.denyPaths?.length) {
    set('read', 'read', Object.fromEntries(policy.read.denyPaths.map((p): [string, Action] => [p, 'deny'])));
  }

  if (policy.edit.deny) set('edit', 'edit', 'deny');
  else if (policy.edit.allow === 'any') set('edit', 'edit', 'allow');
  else if (Array.isArray(policy.edit.allow)) {
    // OpenCode's edit patterns are not the policy's path rules, so each request is judged by path
    set('edit', 'edit', 'ask');
    host.add('edit');
  }

  const { allow, deny } = policy.commands;
  const bash: Record<string, Action> = {};
  if (allow === 'any') bash['*'] = 'allow';
  else if (Array.isArray(allow)) for (const rule of allow) for (const pattern of bashPatterns(rule)) bash[pattern] = 'allow';
  if (deny === 'all') bash['*'] = 'deny';
  else if (Array.isArray(deny)) for (const rule of deny) for (const pattern of bashPatterns(rule)) bash[pattern] = 'deny';
  if (Object.keys(bash).length > 0) set('commands', 'bash', bash);

  if (policy.network === 'allow' || policy.network === 'deny') {
    const action: Action = policy.network;
    set('network', 'webfetch', action);
    set('network', 'websearch', action);
  }
  if (policy.delegate === 'deny') set('delegate', 'task', 'deny');
  if (policy.workflow === 'allow') unsupported.push('workflow');
  if (policy.gitPush === 'deny') {
    set('gitPush', 'bash', { 'git push*': 'deny' });
    host.add('commands', 'gitPush');
  }
  // The person's global config merges in, so `mcp: {}` would not remove their servers
  if (policy.exclusive) unsupported.push('exclusive');

  const hostParts = host.list();
  return {
    rules: { allowedTools: [], disallowedTools: [] },
    ...(settings.length > 0 ? { settings } : {}),
    ...(hostParts ? { host: hostParts } : {}),
    unsupported,
  };
}

/** The `permission` object a translation's settings make, merged in order. */
export function openCodePermission(translation: PolicyTranslation): Record<string, unknown> {
  const permission: Record<string, unknown> = {};
  for (const setting of translation.settings ?? []) {
    if (!setting.key.startsWith('permission.')) continue;
    const name = setting.key.slice('permission.'.length);
    const before = permission[name];
    permission[name] =
      before && typeof before === 'object' && setting.value && typeof setting.value === 'object' ? { ...(before as object), ...(setting.value as object) } : setting.value;
  }
  return permission;
}
