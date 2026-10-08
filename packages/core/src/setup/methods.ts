import type { SetupTool, SetupToolMethods } from '@agentry/shared';

/**
 * How each tool signs in, and only through what its vendor ships for programs (the one rule). The
 * table is docs/plans/in-app-setup.md's, "What each vendor allows"; docs/setup.md keeps it with its
 * sources. A device-code row runs the vendor's documented command with no terminal: the recordings
 * under packages/core/test/fixtures/logins/ show all four (Codex, Copilot, gh, glab) run that way.
 */
export interface ToolLogin {
  methods: SetupToolMethods;
  /**
   * The CLI's own key login, reading the key on stdin, or for a `file` tool the command the
   * `--auth-key=file:<path>` argument is added to; null for a tool whose key Agentry keeps
   */
  keyCommand: ((host: string) => string[]) | null;
  /** The documented device-code sign-in; null where there is none */
  deviceCommand: ((host: string) => string[]) | null;
  /** The documented sign-out command; null where the vault alone holds the credential or there is none */
  signOutCommand: ((host: string) => string[]) | null;
}

const row = (tool: SetupTool, methods: Partial<Omit<SetupToolMethods, 'tool'>>): SetupToolMethods => ({
  tool,
  key: 'env',
  variables: [],
  exclusive: false,
  device: false,
  needsHost: false,
  defaultHost: null,
  signOut: true,
  ...methods,
});

/**
 * OpenCode reads the key of the upstream provider a model belongs to from that provider's variable:
 * its provider docs (https://opencode.ai/docs/providers/) take a key through `opencode auth login` or
 * the environment, and the variable names are the ones models.dev lists for each provider, which
 * OpenCode loads its providers from. Four providers a person is most likely to hold a key for; a
 * variable outside this list is refused rather than written into every OpenCode process.
 */
export const OPENCODE_KEY_VARIABLES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'] as const;

export const TOOL_LOGINS: Readonly<Record<SetupTool, ToolLogin>> = {
  // `claude setup-token` makes the OAuth token on the person's own machine; `auth login` needs a
  // terminal, so there is no device row. Either variable signs the CLI in, never both at once.
  'claude-code': {
    methods: row('claude-code', { key: 'env', variables: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], exclusive: true }),
    keyCommand: null,
    deviceCommand: null,
    signOutCommand: () => ['auth', 'logout'],
  },
  // `codex login --with-api-key` reads the key on stdin; `--device-auth` is the documented device
  // sign-in (beta: the person may have to allow device login in ChatGPT first)
  codex: {
    methods: row('codex', { key: 'stdin', device: true }),
    keyCommand: () => ['login', '--with-api-key'],
    deviceCommand: () => ['login', '--device-auth'],
    signOutCommand: () => ['logout'],
  },
  // The README's "API Key" option; Google sign-in lives in the TUI
  gemini: {
    methods: row('gemini', { key: 'env', variables: ['GEMINI_API_KEY'] }),
    keyCommand: null,
    deviceCommand: null,
    signOutCommand: null,
  },
  // `copilot login --with-token` reads a fine-grained PAT on stdin, `--device-code` is the device
  // sign-in; `copilot --help` documents no sign-out
  copilot: {
    methods: row('copilot', { key: 'stdin', device: true, signOut: false }),
    keyCommand: () => ['login', '--with-token'],
    deviceCommand: () => ['login', '--device-code'],
    signOutCommand: null,
  },
  opencode: {
    methods: row('opencode', { key: 'env', variables: [...OPENCODE_KEY_VARIABLES] }),
    keyCommand: null,
    deviceCommand: null,
    signOutCommand: null,
  },
  gh: {
    methods: row('gh', { key: 'stdin', device: true, needsHost: true, defaultHost: 'github.com' }),
    keyCommand: (host) => ['auth', 'login', '--with-token', '--hostname', host],
    deviceCommand: (host) => ['auth', 'login', '--web', '--hostname', host],
    signOutCommand: (host) => ['auth', 'logout', '--hostname', host],
  },
  // `--device` needs GitLab 17.9 or later on the host
  glab: {
    methods: row('glab', { key: 'stdin', device: true, needsHost: true, defaultHost: 'gitlab.com' }),
    keyCommand: (host) => ['auth', 'login', '--hostname', host, '--stdin'],
    deviceCommand: (host) => ['auth', 'login', '--device', '--hostname', host],
    signOutCommand: (host) => ['auth', 'logout', '--hostname', host],
  },
  // `youtrack-app` reads the instance and a permanent token from its environment (recorded)
  youtrack: {
    methods: row('youtrack', { key: 'env', variables: ['YOUTRACK_TOKEN'], needsHost: true }),
    keyCommand: null,
    deviceCommand: null,
    signOutCommand: null,
  },
  // Only the tailscaled the image runs for Agentry (`CoreConfig.tailscaleManaged`); the argument is
  // the node's name. `up` with no terminal prints a login URL and waits until the node is Running
  // (recorded, fixtures/logins/tailscale-up.*). `--reset` because `up` refuses flags that differ
  // from what the daemon kept unless every one is named again, and Agentry is its only user.
  // `--auth-key` takes `file:<path>` (1.102 `up --help`), which keeps the key out of argv; the
  // daemon keeps the node key it gets, so the auth key is used once and never stored (decision 4).
  // `logout` expires the node key and takes the node off the tailnet.
  tailscale: {
    methods: row('tailscale', { key: 'file', device: true }),
    keyCommand: (name) => ['up', '--reset', `--hostname=${name}`],
    deviceCommand: (name) => ['up', '--reset', `--hostname=${name}`],
    signOutCommand: () => ['logout'],
  },
};

export function setupMethods(): SetupToolMethods[] {
  return Object.values(TOOL_LOGINS).map((login) => ({ ...login.methods, variables: [...login.methods.variables] }));
}

/** The variables of a tool that may not be set together; empty for every tool but Claude Code */
export function exclusiveVariables(tool: string): readonly string[] {
  const login = (TOOL_LOGINS as Readonly<Record<string, ToolLogin | undefined>>)[tool];
  return login?.methods.exclusive ? login.methods.variables : [];
}

export function isSetupTool(value: unknown): value is SetupTool {
  return typeof value === 'string' && Object.hasOwn(TOOL_LOGINS, value);
}
