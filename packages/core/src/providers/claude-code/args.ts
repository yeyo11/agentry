import type { Launch } from '../../accounts.ts';
import type { AccountSupport, SessionLaunch } from '../driver.ts';

/** The flags `claude -p` is started with for a chat, in the order the CLI has always been given them */
export function buildArgs(spec: SessionLaunch): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', spec.permissionMode,
  ];
  // Makes bypassPermissions a mode the chat can be switched to later, without starting in it: the
  // CLI refuses the switch otherwise. Starting a chat in that mode is already open to the same caller.
  // A confined chat is never to be switched there, and `--restricted` refuses the flag outright.
  if (!spec.confine) args.push('--allow-dangerously-skip-permissions');
  if (spec.forkFrom) {
    // The copy is created under the id Agentry chose; until the CLI confirms it, a respawn forks again
    args.push('--resume', spec.forkFrom, '--fork-session', '--session-id', spec.id, '--name', spec.name);
  } else if (spec.created) {
    args.push('--resume', spec.id);
  } else {
    args.push('--session-id', spec.id, '--name', spec.name);
  }
  if (spec.agentsFile) args.push('--agents', spec.agentsFile);
  if (spec.agent) args.push('--agent', spec.agent);
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  if (spec.allowedTools?.length) args.push(`--allowedTools=${spec.allowedTools.join(',')}`);
  if (spec.disallowedTools?.length) args.push(`--disallowedTools=${spec.disallowedTools.join(',')}`);
  // Strict, because the point of choosing servers is that no other one loads. The `=` form keeps
  // the variadic flag from taking whatever follows it as another file.
  if (spec.mcpConfig) args.push(`--mcp-config=${spec.mcpConfig}`, '--strict-mcp-config');
  if (spec.confine) {
    // `--restricted` confines the file tools to the working directory, which is why no other
    // directory is added. The `=` forms keep an empty list a value of its flag.
    args.push('--restricted', `--tools=${spec.confine.tools.join(',')}`, `--setting-sources=${spec.confine.settingSources.join(',')}`);
  }
  // Attached files live outside every project; this is what lets Claude open them by path
  else if (spec.uploadsDir) args.push('--add-dir', spec.uploadsDir);
  // The CLI creates, names and locks the worktree itself, and works in it for the session
  if (spec.worktree) args.push('--worktree', spec.worktree);
  // The CLI stops the chat itself once the ceiling is reached, which no amount of watching from
  // out here could do reliably
  if (typeof spec.maxBudgetUsd === 'number' && spec.maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(spec.maxBudgetUsd));
  }
  // Prompts go to a host only when something is listening: a chat waiting on an answer that never
  // comes is worse than one told plainly that it was denied. `stdio` makes the CLI ask on its own
  // stdout as control requests, the same channel the Agent SDK uses, and read the answer on stdin.
  if (spec.permissionPrompts === 'host') {
    args.push('--permission-prompts', 'host', '--permission-prompt-tool', 'stdio');
  } else {
    args.push('--permission-prompts', 'none');
  }
  if (spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.systemPromptSnapshot === 'off') args.push('--system-prompt-snapshot', 'off');
  if (spec.internal) args.push('--no-session-persistence');
  return args;
}

/**
 * `cswap run <account> --share-history -- <claude args>` execs Claude Code against that
 * account's session profile; `--share-history` symlinks `projects/` back to the real config
 * dir, so the transcript still lands where the session store reads it. Pinning to the account
 * that is already active would create a second credential copy that can drift, so it is
 * spawned as a plain `claude` instead.
 */
export function command(claudeBin: string, accounts: AccountSupport | null, launch: Launch, args: string[]): [string, string[]] {
  const { account } = launch;
  // An account with a config directory of its own runs `claude` against it: `cswap run` would
  // replace CLAUDE_CONFIG_DIR with its session profile, and the directory would be ignored
  if (!account || launch.configDir || !accounts?.managed || accounts.isActive(account)) return [claudeBin, args];
  return [accounts.bin, ['run', account, '--share-history', '--', ...args]];
}
