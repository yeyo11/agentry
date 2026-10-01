import { isTeamCommandPattern, type CommandRule, type PolicyTranslation, type ToolPolicy } from '@agentry/shared';

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/** Denying edits outright names `MultiEdit` too, which no allow rule ever grants */
const EDIT_DENIED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
const DELEGATE_TOOLS = ['Task', 'Agent'];
const GIT_PUSH = ['Bash(git push)', 'Bash(git push *)'];

/**
 * The edit rules for paths relative to the project. A comma splits the flag's list and a
 * parenthesis closes the rule, so a path either cannot carry is left out, as is one that climbs out
 * of the project: leaving it out allows less, never more.
 */
export function editRules(paths: readonly string[]): string[] {
  const rules: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!path || /[,()\s]/.test(path) || path.startsWith('/') || path.split('/').includes('..')) continue;
    const patterns = /[*?[]/.test(path) ? [path] : [path, `${path}/**`];
    for (const p of patterns) for (const tool of WRITE_TOOLS) rules.push(`${tool}(${p})`);
  }
  return [...new Set(rules)];
}

/**
 * A member's shell commands as the CLI's rules: `Bash(<pattern>)` each. The settings never hold a
 * pattern the rule could not carry (`isTeamCommandPattern`), but one that got there anyway is left
 * out, which allows less, never more.
 */
export function commandRules(commands: readonly string[]): string[] {
  return [...new Set(commands.filter(isTeamCommandPattern).map((c) => `Bash(${c})`))];
}

/** Whether the flag's list can carry a pattern: a comma splits it and a parenthesis closes the rule */
function carriable(pattern: string): boolean {
  return pattern.length > 0 && !/[,()\u0000-\u001f\u007f]/.test(pattern);
}

function commandRule(rule: CommandRule): string | null {
  if ('pattern' in rule) return carriable(rule.pattern) ? `Bash(${rule.pattern})` : null;
  if (!carriable(rule.command)) return null;
  if (rule.args === 'none') return `Bash(${rule.command})`;
  return rule.args === 'some' ? `Bash(${rule.command} *)` : `Bash(${rule.command}:*)`;
}

/** The built-in tool names in a list of rules: `Edit(docs/**)` is `Edit` */
function toolNames(rules: readonly string[]): string[] {
  return [...new Set(rules.map((r) => r.replace(/\(.*$/s, '')))];
}

/**
 * `ToolPolicy` in Claude Code's terms: `--allowedTools` / `--disallowedTools`, and for an
 * `exclusive` policy the `--tools` list a confined run passes. Pure: the same policy always gives
 * the same sets. What a rule cannot carry is left out of an allow (less, never more); a denial that
 * cannot be carried is listed as unsupported instead, since dropping it would let more through.
 */
export function translateClaudePolicy(policy: ToolPolicy): PolicyTranslation {
  const allowed: string[] = [];
  const denied: string[] = [];
  const unsupported: string[] = [];

  // First, where the flow's rules always had it
  if (policy.gitPush === 'deny') denied.push(...GIT_PUSH);
  if (policy.read.allow) allowed.push(...READ_TOOLS);
  for (const path of policy.read.denyPaths ?? []) {
    if (carriable(path)) denied.push(`Read(${path})`);
    else unsupported.push('read.denyPaths');
  }

  if (policy.edit.allow === 'any') allowed.push(...WRITE_TOOLS);
  else if (Array.isArray(policy.edit.allow)) allowed.push(...editRules(policy.edit.allow));
  if (policy.edit.deny) denied.push(...EDIT_DENIED);

  const { allow, deny } = policy.commands;
  if (allow === 'any') allowed.push('Bash');
  else if (Array.isArray(allow)) {
    for (const rule of allow) {
      // A member's `commands` are checked before they get here; a pattern that was not is left out
      if ('pattern' in rule && !isTeamCommandPattern(rule.pattern)) continue;
      const text = commandRule(rule);
      if (text) allowed.push(text);
    }
  }
  if (deny === 'all') denied.push('Bash');
  else if (Array.isArray(deny)) {
    for (const rule of deny) {
      const text = commandRule(rule);
      if (text) denied.push(text);
      else unsupported.push('commands.deny');
    }
  }

  if (policy.network === 'allow') allowed.push(...WEB_TOOLS);
  else if (policy.network === 'deny') denied.push(...WEB_TOOLS);
  if (policy.delegate === 'deny') denied.push(...DELEGATE_TOOLS);
  if (policy.workflow === 'allow') allowed.push('Workflow');

  const rules: PolicyTranslation['rules'] = { allowedTools: [...new Set(allowed)], disallowedTools: [...new Set(denied)] };
  if (policy.exclusive) rules.tools = toolNames(rules.allowedTools);
  return { rules, unsupported: [...new Set(unsupported)] };
}
