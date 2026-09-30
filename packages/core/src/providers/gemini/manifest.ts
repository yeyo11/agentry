import type { ProviderManifest } from '../manifest.ts';

export const geminiManifest: ProviderManifest = {
  id: 'gemini',
  label: 'Gemini CLI',
  vendor: 'Google',
  homepage: 'https://github.com/google-gemini/gemini-cli',
  commands: {
    // Source: https://github.com/google-gemini/gemini-cli README ("Start the CLI with `gemini`").
    names: ['gemini'],
    requires: [],
    unsupportedPlatforms: [],
  },
  configHomes: [
    // Source: packages/core/src/utils/paths.ts: GEMINI_CLI_HOME replaces the home directory and the
    // state lives in `.gemini` inside it; the README gives ~/.gemini for settings.json.
    { default: '~/.gemini', env: 'GEMINI_CLI_HOME', insideEnv: '.gemini' },
  ],
  versions: {
    // Source: docs/cli/cli-reference.md, `--version` / `-v`.
    args: ['--version'],
    range: null,
  },
  // Source: the README's install section (npm, Homebrew, MacPorts).
  install: { url: 'https://github.com/google-gemini/gemini-cli' },
  auth: {
    // The docs list sign-in choices (Google login, GEMINI_API_KEY, Vertex AI) but no command that
    // reports whether one is in place, so nothing is probed and readiness says `no-probe`.
    probe: { kind: 'none' },
    // Source: the README, "API Key" and "Vertex AI" options.
    credentialEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    signInUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  // Source: packages/cli/src/config/config.ts defines `--acp` (and the deprecated `--experimental-acp`).
  transport: 'acp',
  capabilities: [],
};
