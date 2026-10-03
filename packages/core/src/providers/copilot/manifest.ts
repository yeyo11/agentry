import type { ProviderManifest } from '../manifest.ts';

export const copilotManifest: ProviderManifest = {
  id: 'copilot',
  label: 'GitHub Copilot',
  vendor: 'GitHub',
  // Source: `copilot --help` ends with "Read the documentation at
  // https://docs.github.com/copilot/how-tos/copilot-cli" (installed 1.0.65; the page answers 200).
  homepage: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  commands: {
    // Source: `copilot --help`.
    names: ['copilot'],
    requires: [],
    unsupportedPlatforms: [],
  },
  configHomes: [
    // Source: `copilot help environment`: COPILOT_HOME "defaults to $HOME/.copilot".
    { default: '~/.copilot', env: 'COPILOT_HOME' },
  ],
  versions: {
    // Source: `copilot --help` lists `-v, --version`.
    args: ['--version'],
    // Recorded on 1.0.65 and 1.0.90; the capability set changed between them, so `initialize` confirms it.
    range: '>=1.0.65 <1.1.0',
  },
  install: { url: 'https://docs.github.com/copilot/how-tos/copilot-cli' },
  auth: {
    // `copilot login` exists, but `--help` shows no subcommand that reports the state. The CLI keeps
    // who signed in in its own state file: `copilot help config` calls it the "global config.json",
    // in COPILOT_HOME, and on 1.0.91 it lists `loggedInUsers` and `lastLoggedInUser` ({ host, login }).
    // The token itself is in the system's credential store, so a listed account whose token was
    // revoked still reads as signed in until a chat fails on it.
    probe: {
      kind: 'file',
      file: { default: '~/.copilot/config.json', env: 'COPILOT_HOME', insideEnv: 'config.json' },
      users: { list: 'loggedInUsers', current: 'lastLoggedInUser', defaultHost: 'https://github.com' },
    },
    // Source: `copilot login --help`, in order of precedence.
    credentialEnv: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    signInUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  },
  // Source: `copilot --help` lists `--acp` ("Start as Agent Client Protocol server").
  transport: 'acp',
  // `--no-auto-update` and COPILOT_AUTO_UPDATE=false: a recording session saw Copilot replace the
  // binary in place. `--no-remote` keeps the session from being controlled from elsewhere.
  launch: { args: ['--acp', '--no-auto-update', '--no-remote'], env: { COPILOT_AUTO_UPDATE: 'false' }, unsetEnv: [] },
  // `setModel` is not declared: `session/new` offers no model option (the model is a launch flag).
  capabilities: ['interactivePermissions', 'resume', 'interrupt', 'mcp'],
};
