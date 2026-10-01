import type { CommandRule, PolicyTranslation, ToolPolicy } from '@agentry/shared';
import { carriable, HostParts, isPatternRule, prefixOf } from './policy-common.ts';

/**
 * `shell(<command>)` for one command, `shell(<command>:*)` for it and what follows. A pattern the
 * rule cannot say returns null: the caller leaves it to the judge.
 */
function shellRule(rule: CommandRule): string | null {
  if (isPatternRule(rule)) {
    const prefix = prefixOf(rule.pattern);
    return prefix && carriable(prefix) ? `shell(${prefix}:*)` : null;
  }
  if (!carriable(rule.command)) return null;
  return rule.args === 'none' ? `shell(${rule.command})` : `shell(${rule.command}:*)`;
}

const GIT_PUSH = ['shell(git push)', 'shell(git push:*)'];

/**
 * `ToolPolicy` as Copilot's own flags (`copilot --help`: `--allow-tool`, `--deny-tool`,
 * `--allow-all-urls`, `--deny-url`): "denial rules always take precedence over allow rules". What a
 * flag cannot say is left to the judge (`host`), and what neither can is listed. Pure.
 *
 * The settings keys are the flags without their dashes; `launchArgs` turns them back.
 */
export function translateCopilotPolicy(policy: ToolPolicy): PolicyTranslation {
  const allowed: string[] = [];
  const denied: string[] = [];
  const unsupported: string[] = [];
  const settings: NonNullable<PolicyTranslation['settings']> = [];
  const host = new HostParts();

  // Every Copilot session can read the project
  if (policy.read.allow) settings.push({ part: 'read', key: 'builtin', value: 'always' });
  if (policy.read.denyPaths?.length) unsupported.push('read.denyPaths');

  if (policy.edit.allow === 'any') allowed.push('write');
  else if (Array.isArray(policy.edit.allow)) host.add('edit');
  if (policy.edit.deny) denied.push('write');

  const { allow, deny } = policy.commands;
  if (allow === 'any') allowed.push('shell');
  else if (Array.isArray(allow)) {
    for (const rule of allow) {
      const text = shellRule(rule);
      if (text) allowed.push(text);
      else host.add('commands');
    }
  }
  if (deny === 'all') denied.push('shell');
  else if (Array.isArray(deny)) {
    for (const rule of deny) {
      const text = shellRule(rule);
      if (text) denied.push(text);
      else unsupported.push('commands.deny');
    }
  }

  if (policy.network === 'allow') settings.push({ part: 'network', key: 'allow-all-urls', value: true });
  else if (policy.network === 'deny') settings.push({ part: 'network', key: 'deny-url', value: '*' });
  if (policy.delegate === 'deny') unsupported.push('delegate');
  if (policy.workflow === 'allow') unsupported.push('workflow');
  if (policy.gitPush === 'deny') {
    denied.push(...GIT_PUSH);
    host.add('commands', 'gitPush');
  }
  // `--available-tools` needs the agent's own tool names, which no recording shows
  if (policy.exclusive) unsupported.push('exclusive');

  const hostParts = host.list();
  return {
    rules: { allowedTools: [...new Set(allowed)], disallowedTools: [...new Set(denied)] },
    ...(settings.length > 0 ? { settings } : {}),
    ...(hostParts ? { host: hostParts } : {}),
    unsupported: [...new Set(unsupported)],
  };
}

/** The flags a translation becomes on Copilot's command line; the `=` form, since the list options are variadic and would take the next argument too. */
export function copilotPolicyArgs(translation: PolicyTranslation): string[] {
  const args: string[] = [];
  for (const rule of translation.rules.allowedTools) args.push(`--allow-tool=${rule}`);
  for (const rule of translation.rules.disallowedTools) args.push(`--deny-tool=${rule}`);
  for (const setting of translation.settings ?? []) {
    if (setting.key === 'allow-all-urls' && setting.value === true) args.push('--allow-all-urls');
    else if (setting.key === 'deny-url' && typeof setting.value === 'string') args.push(`--deny-url=${setting.value}`);
  }
  return args;
}
