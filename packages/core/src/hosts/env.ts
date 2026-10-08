import type { HostCall } from './exec.ts';
import { childEnv } from '../child-env.ts';

// The environment every host CLI runs in. Telemetry is on by default in gh and names the calling
// agent; GH_FORCE_TTY sends output through the pager and renders tables; GH_HOST overrides a
// host-less `-R`; glab's NO_PROMPT is deprecated and warns on every call in 1.120.0 (all recorded,
// see docs/plans/code-hosts.md, "The execution layer"). Tokens the person keeps in the environment
// (GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, GITLAB_TOKEN) are left alone: they are the
// person's session, and pinning the host on every call is what keeps them from going elsewhere.

export interface HostEnv {
  set: Record<string, string>;
  unset: string[];
}

const COMMON_SET: Record<string, string> = { NO_COLOR: '1', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };

export const HOST_ENV: Readonly<Record<HostCall['cli'], Readonly<HostEnv>>> = {
  gh: {
    set: {
      ...COMMON_SET,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      GH_PAGER: 'cat',
      GH_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
    },
    unset: ['GH_HOST', 'GH_REPO', 'GH_FORCE_TTY', 'GH_DEBUG', 'DEBUG', 'CLICOLOR_FORCE'],
  },
  glab: {
    set: { ...COMMON_SET, GLAB_NO_PROMPT: '1', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false' },
    unset: ['NO_PROMPT', 'GITLAB_HOST', 'GL_HOST', 'GITLAB_URI', 'DEBUG', 'GLAB_DEBUG'],
  },
  'youtrack-app': { set: { ...COMMON_SET }, unset: ['YOUTRACK_API_TOKEN'] },
};

/** What an adapter's `env()` returns: a copy, so a caller cannot change the table */
export function envOf(cli: HostCall['cli']): HostEnv {
  const env = HOST_ENV[cli];
  return { set: { ...env.set }, unset: [...env.unset] };
}

/**
 * The environment of one process: `base`, with the CLI's variables removed and set, and what the
 * secret vault keeps for the CLI laid over it (`childEnv`: YouTrack's address and token, for
 * `youtrack-app` only; gh and glab keep their own sign-in). `secrets` lays a given credential over
 * that, for `youtrack-app` only. Neither is ever put in argv, which other local users can read.
 */
export function buildHostEnv(cli: HostCall['cli'], base: NodeJS.ProcessEnv = process.env, secrets: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const table = HOST_ENV[cli];
  for (const name of table.unset) delete env[name];
  Object.assign(env, table.set);
  const withVault = childEnv(cli, env);
  if (cli === 'youtrack-app') Object.assign(withVault, secrets);
  return withVault;
}
