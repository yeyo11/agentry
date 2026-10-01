import type { CodeHostManifest } from '../manifest.ts';

export const gitlabManifest: CodeHostManifest = {
  id: 'gitlab',
  label: 'GitLab',
  // Recorded: `glab version` and `glab --version` print "glab 1.120.0 (78790114c)"
  // (docs/plans/code-hosts.md, glab facts; recordings/glab/NOTES.md).
  cli: 'glab',
  versions: {
    args: ['version'],
    // Older releases exit 0 from `auth status` when signed out (gitlab-org/cli issue 911), so the
    // exit code is only a probe from the release every fact was recorded on.
    minimum: '1.120.0',
    recorded: ['1.120.0'],
    // A newer release works, but nothing was recorded on it: Settings says so.
    untested: 'degraded',
  },
  auth: {
    // Recorded: exit 0 signed in, 1 not; stdout empty and the status on stderr, which is never read.
    kind: 'exit-code',
    args: ['auth', 'status'],
    hostFlag: '--hostname',
  },
  defaultHosts: ['gitlab.com'],
  // https://docs.gitlab.com/cli/configuration/: GLAB_CONFIG_DIR, else ~/.config/glab-cli. The host
  // names inside it are read by known-hosts.ts, which never reads a token.
  configHome: { default: '~/.config/glab-cli', env: 'GLAB_CONFIG_DIR' },
  install: { url: 'https://gitlab.com/gitlab-org/cli#installation' },
  signInUrl: 'https://docs.gitlab.com/cli/auth/login/',
  docsUrl: 'https://docs.gitlab.com/cli/',
  refPrefix: '!',
  changeRequestNoun: 'merge request',
};
