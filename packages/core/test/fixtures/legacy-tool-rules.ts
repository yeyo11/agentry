// A verbatim copy of the tool rules Agentry built before `ToolPolicy`, taken at commit 2313937d from
// flow.ts, assistant.ts, chat-tools.ts and orchestrator.ts. It is frozen on purpose: the policy
// golden test compares the translation against it, so it is never edited to follow the code.
import { isTeamCommandPattern } from '@agentry/shared';

export type LegacyStage = 'refine' | 'work' | 'verify';

export interface LegacyCheckCommand {
  command: string;
  alone: boolean;
  withArgs: boolean;
}

export interface LegacyFlowRules {
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
}

// ---- flow.ts ----

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
const DENIED_TOOLS = ['Bash(git push)', 'Bash(git push *)'];
const GIT_READS = ['status', 'diff', 'log', 'show'].flatMap((c) => [`Bash(git ${c})`, `Bash(git ${c} *)`]);
const GIT_OUTPUT_DENIED = ['diff', 'log', 'show'].map((c) => `Bash(git ${c} *--output*)`);

function editRules(paths: readonly string[]): string[] {
  const rules: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!path || /[,()\s]/.test(path) || path.startsWith('/') || path.split('/').includes('..')) continue;
    const patterns = /[*?[]/.test(path) ? [path] : [path, `${path}/**`];
    for (const p of patterns) for (const tool of WRITE_TOOLS) rules.push(`${tool}(${p})`);
  }
  return [...new Set(rules)];
}

export function legacyStageRules(
  stage: LegacyStage,
  writes: readonly string[] | undefined,
  extra: { documentsPath: string; testCommands: readonly string[]; commands?: readonly string[] | undefined },
): LegacyFlowRules {
  const documents = editRules([extra.documentsPath]);
  if (stage === 'refine') return { permissionMode: 'dontAsk', allowedTools: [...READ_TOOLS, ...documents], disallowedTools: [...DENIED_TOOLS] };
  if (stage === 'verify') {
    return {
      permissionMode: 'dontAsk',
      allowedTools: [...READ_TOOLS, ...GIT_READS, ...extra.testCommands, ...documents],
      disallowedTools: [...DENIED_TOOLS, ...GIT_OUTPUT_DENIED],
    };
  }
  const commands = extra.commands;
  const tools = [...READ_TOOLS, ...(commands ? commandRules(commands) : ['Bash']), ...WEB_TOOLS];
  if (!writes && !commands) return { permissionMode: 'acceptEdits', allowedTools: [...tools, ...WRITE_TOOLS], disallowedTools: [...DENIED_TOOLS] };
  const edits = writes ? editRules([...writes, extra.documentsPath]) : WRITE_TOOLS;
  return { permissionMode: 'dontAsk', allowedTools: [...tools, ...edits], disallowedTools: [...DENIED_TOOLS] };
}

function commandRules(commands: readonly string[]): string[] {
  return [...new Set(commands.filter(isTeamCommandPattern).map((c) => `Bash(${c})`))];
}

export function legacyCheckCommandRules(commands: readonly LegacyCheckCommand[]): string[] {
  const rules: string[] = [];
  for (const c of commands) {
    if (c.alone) rules.push(`Bash(${c.command})`);
    if (c.withArgs) rules.push(`Bash(${c.command} *)`);
  }
  return [...new Set(rules)];
}

// ---- assistant.ts ----

export const LEGACY_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
export const LEGACY_DENIED_READS = [
  'Read(./**/.env)',
  'Read(./**/.env.*)',
  'Read(./**/*.env)',
  'Read(./**/.envrc)',
  'Read(./**/*.pem)',
  'Read(./**/*.key)',
  'Read(./**/*.p12)',
  'Read(./**/*.pfx)',
  'Read(./**/*.jks)',
  'Read(./**/*.keystore)',
  'Read(./**/id_rsa*)',
  'Read(./**/id_ecdsa*)',
  'Read(./**/id_ed25519*)',
  'Read(./**/.ssh/**)',
  'Read(./**/.aws/**)',
  'Read(./**/.npmrc)',
  'Read(./**/.pypirc)',
  'Read(./**/.netrc)',
  'Read(./**/.git-credentials)',
  'Read(./**/credentials*)',
  'Read(./**/secrets/**)',
  'Read(./**/settings.local.json)',
  'Read(./.git/**)',
];
export const LEGACY_ASSISTANT_DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'WebFetch', 'WebSearch', ...LEGACY_DENIED_READS];

/** The assistant's launch: `tools`, `allowedTools` and `disallowedTools`, in a `dontAsk` session */
export const LEGACY_ASSISTANT_RULES = {
  permissionMode: 'dontAsk',
  tools: [...LEGACY_READ_ONLY_TOOLS],
  allowedTools: [...LEGACY_READ_ONLY_TOOLS],
  disallowedTools: [...LEGACY_ASSISTANT_DENIED_TOOLS],
};

// ---- orchestrator.ts ----

/** The planner's run */
export const LEGACY_PLANNER_ALLOWED = ['Read', 'Glob', 'Grep'];

export function legacyIntegrationAllowed(native: readonly string[] = []): string[] {
  return [...new Set([...native, 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)'])];
}

export function legacyVerificationAllowed(native: readonly string[] = []): string[] {
  return [...new Set([...native, 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'])];
}

export function legacyWorkflowAllowed(native: readonly string[] = []): string[] {
  return [...new Set([...native, 'Workflow'])];
}

// ---- chat-tools.ts: DEFAULT_TOOL_PRESETS (rules only) ----

export const LEGACY_TOOL_PRESETS: readonly { id: string; allowedTools: string[]; disallowedTools: string[] }[] = [
  {
    id: 'read-only',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  },
  {
    id: 'no-network',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash'],
    disallowedTools: ['WebFetch', 'WebSearch', 'Bash(curl:*)', 'Bash(wget:*)'],
  },
  {
    id: 'everything',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'],
    disallowedTools: [],
  },
];
