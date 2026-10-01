import type { CommandRule, ToolPolicy } from '@agentry/shared';

/** What an agent asks to do, in Agentry's words; each driver maps its protocol's request onto it. */
export interface NeutralRequest {
  kind: 'command' | 'edit' | 'read' | 'fetch' | 'delegate' | 'other';
  /** The shell command line of a `command` */
  command?: string;
  /** The files an `edit` or a `read` touches, relative to the project */
  paths?: string[];
  url?: string;
}

export type Verdict = 'allow' | 'deny' | 'ask';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);
/** Git's global options that take their value as the next word */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
/** Commands that run another command: their own options are skipped to find it */
const WRAPPERS = new Set(['env', 'sudo', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Words of one simple command, quotes removed. A backslash escapes the next character. */
function words(segment: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length) current += segment.charAt(++i);
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current ??= '';
    } else if (ch === '\\' && i + 1 < segment.length) {
      current = (current ?? '') + segment.charAt(++i);
    } else if (/\s/.test(ch)) {
      if (current !== null) out.push(current);
      current = null;
    } else {
      current = (current ?? '') + ch;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/** A command line cut at `;`, `&&`, `||`, `|`, `&` and newlines, outside quotes. */
export function commandSegments(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\') i++;
    else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      out.push(line.slice(start, i));
      // `&&` and `||` are one separator
      if ((ch === '&' || ch === '|') && line.charAt(i + 1) === ch) i++;
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether a command line runs `git push` in any form: `git push`, `git -C x push`,
 * `git -c k=v --no-pager push`, behind variable assignments, `env`, `sudo`, `command`, `exec`, or
 * inside `sh -c '…'`. Over-detecting is the safe side; a quoted argument is never taken for a verb.
 */
export function runsGitPush(line: string, depth = 0): boolean {
  if (depth > 3) return true;
  for (const segment of commandSegments(line)) {
    // Subshells and groups: look inside them
    const inner = segment.replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
    const ws = words(inner);
    let i = 0;
    let wrapped = false;
    while (i < ws.length) {
      const w = ws[i] ?? '';
      const base = w.split('/').pop() ?? '';
      if (ENV_ASSIGNMENT.test(w)) i++;
      else if (WRAPPERS.has(w)) {
        wrapped = true;
        i++;
      } else if (wrapped && base !== 'git' && !SHELLS.has(base)) i++;
      else break;
    }
    const head = (ws[i] ?? '').split('/').pop() ?? '';
    if (SHELLS.has(head)) {
      const c = ws.indexOf('-c', i + 1);
      const script = c >= 0 ? ws[c + 1] : undefined;
      if (script !== undefined && runsGitPush(script, depth + 1)) return true;
      continue;
    }
    if (head !== 'git') continue;
    for (let j = i + 1; j < ws.length; j++) {
      const a = ws[j] ?? '';
      if (GIT_VALUE_OPTIONS.has(a)) j++;
      else if (a.startsWith('-')) continue;
      else {
        if (a === 'push') return true;
        break;
      }
    }
  }
  return false;
}

/** `*` matches anything; the rest is literal. */
function wildcard(pattern: string, text: string): boolean {
  const re = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`, 's').test(text);
}

/** One simple command against one rule; a `prefix` rule is `cmd:*`, a `some` rule is `cmd *`. */
function matchesRule(rule: CommandRule, segment: string): boolean {
  if ('pattern' in rule) return wildcard(rule.pattern.replace(/:\*$/, ' *'), segment) || wildcard(rule.pattern, segment);
  if (rule.args === 'none') return segment === rule.command;
  if (rule.args === 'some') return segment.startsWith(`${rule.command} `) && segment.length > rule.command.length + 1;
  return segment === rule.command || segment.startsWith(`${rule.command} `);
}

/** Path globs: `*` stays inside a directory, `**` crosses them, a bare directory covers what is under it. */
function globRegex(glob: string): RegExp {
  const body = glob
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('**')
    .map((part) => part.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${body}(/.*)?$`, 's');
}

/** A path inside the project, normalised; null for one that climbs out of it or is absolute. */
function projectPath(raw: string): string | null {
  if (raw.startsWith('/') || raw.includes('\u0000')) return null;
  const parts: string[] = [];
  for (const p of raw.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (parts.pop() === undefined) return null;
    } else parts.push(p);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

function judgeCommand(policy: ToolPolicy, line: string): Verdict {
  if (policy.gitPush === 'deny' && runsGitPush(line)) return 'deny';
  const { allow, deny } = policy.commands;
  const segments = commandSegments(line);
  if (deny === 'all') return 'deny';
  if (Array.isArray(deny) && segments.some((s) => deny.some((r) => matchesRule(r, s)))) return 'deny';
  if (allow === 'none') return 'deny';
  if (allow === 'any') return 'allow';
  // A list allows a line only when every command in it is on the list
  return segments.length > 0 && segments.every((s) => allow.some((r) => matchesRule(r, s))) ? 'allow' : 'ask';
}

function judgeEdit(policy: ToolPolicy, paths: readonly string[] | undefined): Verdict {
  const { allow, deny } = policy.edit;
  if (deny || allow === 'none') return 'deny';
  if (allow === 'any') return 'allow';
  if (!paths || paths.length === 0) return 'ask';
  const globs = allow.map(globRegex);
  for (const raw of paths) {
    const path = projectPath(raw);
    // Outside the project is never allowed by a list of project paths
    if (path === null) return 'deny';
    if (!globs.some((g) => g.test(path))) return 'deny';
  }
  return 'allow';
}

function judgeRead(policy: ToolPolicy, paths: readonly string[] | undefined): Verdict {
  if (!policy.read.allow) return 'deny';
  const globs = (policy.read.denyPaths ?? []).flatMap((g) => [globRegex(g), globRegex(`**/${g}`)]);
  for (const raw of paths ?? []) {
    const path = raw.replace(/^\.\//, '');
    if (globs.some((g) => g.test(path))) return 'deny';
  }
  return 'allow';
}

/**
 * Answers an agent's permission request from the run's policy, before anything reaches a person.
 * `deny` and `allow` are final; `ask` means the policy does not decide it. Pure.
 */
export function judge(policy: ToolPolicy, request: NeutralRequest): Verdict {
  switch (request.kind) {
    case 'command':
      return request.command === undefined ? 'ask' : judgeCommand(policy, request.command);
    case 'edit':
      return judgeEdit(policy, request.paths);
    case 'read':
      return judgeRead(policy, request.paths);
    case 'fetch':
      return policy.network === 'allow' ? 'allow' : policy.network === 'deny' ? 'deny' : 'ask';
    case 'delegate':
      return policy.delegate === 'deny' ? 'deny' : 'ask';
    default:
      return 'ask';
  }
}
