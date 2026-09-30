import type { ProviderManifest } from '../manifest.ts';

export const claudeCodeManifest: ProviderManifest = {
  id: 'claude-code',
  label: 'Claude Code',
  vendor: 'Anthropic',
  // Source for the pages below: https://code.claude.com/docs/en/setup (HTTP 200, 2026-09-30).
  homepage: 'https://code.claude.com/docs',
  commands: {
    // `claude --version` on the installed binary prints "2.1.285 (Claude Code)".
    names: ['claude'],
    requires: [],
    unsupportedPlatforms: [],
  },
  configHomes: [
    // CLAUDE_CONFIG_DIR is what packages/core/src/account-config.ts already sets per account.
    { default: '~/.claude', env: 'CLAUDE_CONFIG_DIR' },
  ],
  versions: {
    args: ['--version'],
    // The range the plan gives for the driver Agentry runs today (docs/plans/multi-provider.md, section 1).
    range: '>=2.1 <3',
  },
  install: { url: 'https://code.claude.com/docs/en/setup' },
  auth: {
    // `claude auth status --json` prints { "loggedIn": true, ... } (checked on the installed binary
    // and used by getAuthStatus in cli.ts).
    probe: { kind: 'command', args: ['auth', 'status', '--json'], result: 'json' },
    // CLAUDE_CODE_OAUTH_TOKEN is read by envAuthSource in cli.ts.
    credentialEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
    signInUrl: 'https://code.claude.com/docs/en/authentication',
  },
  // chats.ts runs `claude -p --input-format stream-json --output-format stream-json`.
  transport: 'stream-json',
  // Every one of these is exercised by chats.ts, flow.ts or accounts today (plan, section 3).
  capabilities: [
    'interactivePermissions',
    'structuredOutput',
    'resume',
    'fork',
    'interrupt',
    'setModel',
    'subagents',
    'mcp',
    'worktreeFlag',
    'budgetLimit',
    'effort',
    'costReport',
    'rateLimitWindows',
    'multiAccount',
    'transcriptFiles',
    'workflowTool',
  ],
};
