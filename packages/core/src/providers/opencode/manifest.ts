import type { ProviderManifest } from '../manifest.ts';

export const opencodeManifest: ProviderManifest = {
  id: 'opencode',
  label: 'OpenCode',
  vendor: 'Anomaly',
  homepage: 'https://opencode.ai/docs/',
  commands: {
    // Source: https://opencode.ai/docs/cli/ ("opencode" is the command; every subcommand hangs off it).
    names: ['opencode'],
    requires: [],
    unsupportedPlatforms: [],
  },
  configHomes: [
    // Source: packages/core/src/global.ts in github.com/anomalyco/opencode: config is
    // join(xdgConfig, 'opencode') and data join(xdgData, 'opencode'), so XDG_CONFIG_HOME and
    // XDG_DATA_HOME move them; https://opencode.ai/docs/config/ gives ~/.config/opencode/opencode.json.
    { default: '~/.config/opencode', env: 'XDG_CONFIG_HOME', insideEnv: 'opencode' },
    { default: '~/.local/share/opencode', env: 'XDG_DATA_HOME', insideEnv: 'opencode' },
  ],
  versions: {
    // Source: https://opencode.ai/docs/cli/, "--version / -v: print the version number".
    args: ['--version'],
    range: null,
  },
  // Source: https://opencode.ai/docs/ (install script, npm `opencode-ai`, Homebrew, pacman, choco, scoop).
  install: { url: 'https://opencode.ai/docs/' },
  auth: {
    // Source: https://opencode.ai/docs/cli/: `opencode auth login` stores provider credentials in
    // ~/.local/share/opencode/auth.json (the data directory above). `opencode auth list` prints a
    // table for people, with no status code or JSON to read, so the file is the probe.
    probe: { kind: 'file', file: { default: '~/.local/share/opencode/auth.json', env: 'XDG_DATA_HOME', insideEnv: 'opencode/auth.json' } },
    credentialEnv: [],
    signInUrl: 'https://opencode.ai/docs/cli/',
  },
  // Source: https://opencode.ai/docs/cli/: `opencode acp` starts an Agent Client Protocol server over
  // stdin/stdout (nd-JSON).
  transport: 'acp',
  capabilities: [],
};
