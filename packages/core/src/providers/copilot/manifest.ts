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
    range: null,
  },
  install: { url: 'https://docs.github.com/copilot/how-tos/copilot-cli' },
  auth: {
    // `copilot login` exists, but `--help` shows no subcommand that reports the state, so nothing is
    // probed and readiness says `no-probe`.
    probe: { kind: 'none' },
    // Source: `copilot login --help`, in order of precedence.
    credentialEnv: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    signInUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  },
  // Source: `copilot --help` lists `--acp` ("Start as Agent Client Protocol server").
  transport: 'acp',
  capabilities: [],
};
