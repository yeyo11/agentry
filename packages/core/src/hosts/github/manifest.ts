import type { CodeHostManifest } from '../manifest.ts';

export const githubManifest: CodeHostManifest = {
  id: 'github',
  label: 'GitHub',
  // Recorded: `gh --version` prints "gh version 2.92.0 (2026-04-28)" and 2.102.0 prints
  // "gh version 2.102.0 (2026-09-30)" (docs/plans/code-hosts.md, facts table; recordings/gh/NOTES.md).
  cli: 'gh',
  versions: {
    args: ['--version'],
    // 2.92.0 is the owner's floor. The recordings show 2.92 and 2.102 identical for everything
    // phase 1 uses, so any release at or above the floor is ready.
    minimum: '2.92.0',
    recorded: ['2.92.0', '2.102.0'],
    untested: 'ready',
  },
  auth: {
    // Recorded: exits 0 in every case; `hosts` is keyed by hostname, each account with `active`,
    // `state` (`success` or `error`) and `login`. A bad token gives `error`, no token `{"hosts":{}}`.
    kind: 'hosts-json',
    args: ['auth', 'status', '--json', 'hosts'],
  },
  defaultHosts: ['github.com'],
  // `gh help environment` lists GH_CONFIG_DIR as what relocates it; the default is ~/.config/gh.
  configHome: { default: '~/.config/gh', env: 'GH_CONFIG_DIR' },
  install: { url: 'https://cli.github.com' },
  signInUrl: 'https://cli.github.com/manual/gh_auth_login',
  docsUrl: 'https://cli.github.com/manual',
  refPrefix: '#',
  changeRequestNoun: 'pull request',
};
