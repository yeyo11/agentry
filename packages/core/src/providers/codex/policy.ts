import type { PolicyPart, PolicyTranslation, ToolPolicy } from '@agentry/shared';
import type { SandboxMode } from './protocol/types.ts';

/**
 * `ToolPolicy` in Codex's terms. Codex has no allow/deny rule strings: it has a sandbox, an approval
 * policy and inline config, and everything a sandbox cannot decide reaches the client as an approval
 * request, which Agentry answers through the judge (the `host` parts). Pure, like Claude's.
 *
 * What a sandbox lets run unasked cannot be narrowed to a list of commands, so a list of allowed
 * commands is only enforceable when nothing can be written (`read-only`), and is listed as
 * unsupported otherwise: a run that needs it is refused here, never run looser than asked.
 */
export function translateCodexPolicy(policy: ToolPolicy): PolicyTranslation {
  const settings: NonNullable<PolicyTranslation['settings']> = [];
  const host = new Set<PolicyPart>();
  const unsupported = new Set<string>();

  const readOnly = policy.edit.allow === 'none' || policy.edit.deny === true;
  const sandbox: SandboxMode = readOnly ? 'read-only' : 'workspace-write';
  settings.push({ part: 'edit', key: 'sandbox', value: sandbox });
  // Changes confined to some paths are judged one by one when Codex asks to apply them
  if (Array.isArray(policy.edit.allow) && !policy.edit.deny) host.add('edit');

  // Every sandbox reads; there is no way to hide a path from it
  if (policy.read.allow) settings.push({ part: 'read', key: 'sandbox', value: sandbox });
  if (policy.read.denyPaths?.length) unsupported.add('read.denyPaths');

  const { allow, deny } = policy.commands;
  if (allow === 'any') settings.push({ part: 'commands', key: 'approvalPolicy', value: 'on-request' });
  else if (!readOnly) unsupported.add('commands.allow');
  if (Array.isArray(allow) || deny === 'all' || Array.isArray(deny)) host.add('commands');

  if (policy.network === 'allow') settings.push({ part: 'network', key: 'config.web_search', value: 'live' });
  else if (policy.network === 'deny') settings.push({ part: 'network', key: 'config.web_search', value: 'disabled' });

  if (policy.delegate === 'deny') unsupported.add('delegate');
  if (policy.workflow === 'allow') unsupported.add('workflow');

  if (policy.gitPush === 'deny') {
    // The sandbox Agentry asks for never has a network, so a push cannot connect; an escalation to
    // the network for `git push` is declined by the judge as well
    settings.push({ part: 'gitPush', key: 'sandbox.networkAccess', value: false });
    host.add('commands');
    host.add('gitPush');
  }

  if (policy.exclusive) {
    // The person's MCP servers and instructions do not exist for this session
    settings.push({ part: 'exclusive', key: 'config.mcp_servers', value: {} });
  }

  return {
    rules: { allowedTools: [], disallowedTools: [] },
    settings,
    ...(host.size ? { host: [...host] } : {}),
    unsupported: [...unsupported],
  };
}

/** What `thread/start` takes from a translation: the sandbox, and the inline config. */
export function launchSettings(translation: PolicyTranslation | null): { sandbox?: SandboxMode; config: Record<string, unknown> } {
  const config: Record<string, unknown> = {};
  let sandbox: SandboxMode | undefined;
  for (const { key, value } of translation?.settings ?? []) {
    if (key === 'sandbox') sandbox = value as SandboxMode;
    else if (key.startsWith('config.')) config[key.slice('config.'.length)] = value;
  }
  return { ...(sandbox ? { sandbox } : {}), config };
}
