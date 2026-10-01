import type { CommandRule, PolicyTranslation, ToolPolicy } from '@agentry/shared';
import { HostParts, isPatternRule, prefixOf } from './policy-common.ts';

/** One rule of Gemini's policy engine (geminicli.com/docs/reference/policy-engine). */
export interface GeminiRule {
  toolName: string;
  commandPrefix?: string;
  commandRegex?: string;
  argsPattern?: string;
  decision: 'allow' | 'deny';
  priority: number;
}

const SHELL = 'run_shell_command';
const EDIT_TOOLS = ['write_file', 'replace'];
const WEB_TOOLS = ['web_fetch', 'google_web_search'];
/** Within a tier the higher priority wins, so a denial always outranks an allow */
const ALLOW = 100;
const DENY = 900;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A path glob as a regex: `**` crosses folders, `*` and `?` stay inside one. */
function globRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === '*' && glob.charAt(i + 1) === '*') {
      out += '.*';
      i++;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeRegex(ch);
  }
  return out;
}

function shellRule(rule: CommandRule, decision: GeminiRule['decision']): GeminiRule | null {
  const priority = decision === 'allow' ? ALLOW : DENY;
  if (isPatternRule(rule)) {
    const prefix = prefixOf(rule.pattern);
    return prefix ? { toolName: SHELL, commandPrefix: prefix, decision, priority } : null;
  }
  if (rule.args === 'none') return { toolName: SHELL, commandRegex: `^${escapeRegex(rule.command)}$`, decision, priority };
  return { toolName: SHELL, commandPrefix: rule.command, decision, priority };
}

/**
 * `ToolPolicy` as rules of Gemini's policy engine, written to a TOML file the launch passes with
 * `--policy`. Each rule is a settings entry (`key: 'rule'`); what a rule cannot say is left to the
 * judge, and what neither can is listed. Pure.
 */
export function translateGeminiPolicy(policy: ToolPolicy): PolicyTranslation {
  const rules: Array<{ part: 'read' | 'edit' | 'commands' | 'network' | 'gitPush'; rule: GeminiRule }> = [];
  const unsupported: string[] = [];
  const host = new HostParts();

  // Every Gemini session can read the project; a denied path is a rule on its read tool
  const settings: NonNullable<PolicyTranslation['settings']> = [];
  if (policy.read.allow) settings.push({ part: 'read', key: 'builtin', value: 'always' });
  for (const path of policy.read.denyPaths ?? []) {
    rules.push({ part: 'read', rule: { toolName: 'read_file', argsPattern: `"file_path":"(.*/)?${globRegex(path)}"`, decision: 'deny', priority: DENY } });
  }

  if (policy.edit.allow === 'any') for (const toolName of EDIT_TOOLS) rules.push({ part: 'edit', rule: { toolName, decision: 'allow', priority: ALLOW } });
  else if (Array.isArray(policy.edit.allow)) host.add('edit');
  if (policy.edit.deny) for (const toolName of EDIT_TOOLS) rules.push({ part: 'edit', rule: { toolName, decision: 'deny', priority: DENY } });

  const { allow, deny } = policy.commands;
  if (allow === 'any') rules.push({ part: 'commands', rule: { toolName: SHELL, decision: 'allow', priority: ALLOW } });
  else if (Array.isArray(allow)) {
    for (const entry of allow) {
      const rule = shellRule(entry, 'allow');
      if (rule) rules.push({ part: 'commands', rule });
      else host.add('commands');
    }
  }
  if (deny === 'all') rules.push({ part: 'commands', rule: { toolName: SHELL, decision: 'deny', priority: DENY } });
  else if (Array.isArray(deny)) {
    for (const entry of deny) {
      const rule = shellRule(entry, 'deny');
      if (rule) rules.push({ part: 'commands', rule });
      else unsupported.push('commands.deny');
    }
  }

  if (policy.network === 'allow' || policy.network === 'deny') {
    const decision = policy.network;
    for (const toolName of WEB_TOOLS) rules.push({ part: 'network', rule: { toolName, decision, priority: decision === 'allow' ? ALLOW : DENY } });
  }
  if (policy.delegate === 'deny') unsupported.push('delegate');
  if (policy.workflow === 'allow') unsupported.push('workflow');
  if (policy.gitPush === 'deny') {
    rules.push({ part: 'gitPush', rule: { toolName: SHELL, commandPrefix: 'git push', decision: 'deny', priority: DENY } });
    host.add('commands', 'gitPush');
  }
  // `--allowed-mcp-server-names` takes names, and an empty list is not a recorded form
  if (policy.exclusive) unsupported.push('exclusive');

  const hostParts = host.list();
  return {
    rules: { allowedTools: [], disallowedTools: [] },
    settings: [...settings, ...rules.map(({ part, rule }) => ({ part, key: 'rule', value: rule }))],
    ...(hostParts ? { host: hostParts } : {}),
    unsupported: [...new Set(unsupported)],
  };
}

/** The policy file's text for a translation, or null when it has no rule to write. */
export function geminiPolicyToml(translation: PolicyTranslation): string | null {
  const rules = (translation.settings ?? []).filter((s) => s.key === 'rule').map((s) => s.value as GeminiRule);
  if (rules.length === 0) return null;
  const lines: string[] = [];
  for (const rule of rules) {
    lines.push('[[rule]]', `toolName = ${JSON.stringify(rule.toolName)}`);
    if (rule.commandPrefix !== undefined) lines.push(`commandPrefix = ${JSON.stringify(rule.commandPrefix)}`);
    if (rule.commandRegex !== undefined) lines.push(`commandRegex = ${JSON.stringify(rule.commandRegex)}`);
    if (rule.argsPattern !== undefined) lines.push(`argsPattern = ${JSON.stringify(rule.argsPattern)}`);
    lines.push(`decision = ${JSON.stringify(rule.decision)}`, `priority = ${rule.priority}`, '');
  }
  return lines.join('\n');
}
