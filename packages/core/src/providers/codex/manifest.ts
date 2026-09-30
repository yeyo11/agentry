import type { ProviderManifest } from '../manifest.ts';

export const codexManifest: ProviderManifest = {
  id: 'codex',
  label: 'Codex',
  vendor: 'OpenAI',
  homepage: 'https://github.com/openai/codex',
  commands: {
    // Source: https://github.com/openai/codex README (the install commands provide `codex`).
    names: ['codex'],
    requires: [],
    unsupportedPlatforms: [],
  },
  configHomes: [
    // Source: codex-rs/utils/home-dir/src/lib.rs reads CODEX_HOME; the docs give ~/.codex as the
    // default (https://learn.chatgpt.com/docs/developer-commands?surface=cli).
    { default: '~/.codex', env: 'CODEX_HOME' },
  ],
  versions: {
    // Source: codex-rs/cli/src/main.rs declares clap's `version`, which gives `--version`.
    args: ['--version'],
    range: null,
  },
  // Source: https://github.com/openai/codex README, install section.
  install: { url: 'https://github.com/openai/codex' },
  auth: {
    // Source: the CLI reference: `codex login status` "exit with 0 when logged in".
    probe: { kind: 'command', args: ['login', 'status'], result: 'exit-code' },
    credentialEnv: [],
    signInUrl: 'https://github.com/openai/codex',
  },
  // Source: the CLI reference lists `codex app-server` (experimental, stdio JSON-RPC).
  transport: 'json-rpc',
  capabilities: [],
};
