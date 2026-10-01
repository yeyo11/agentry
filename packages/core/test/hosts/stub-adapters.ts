import type { CodeHostId } from '@agentry/shared';
import type { CodeHostAdapter } from '../../src/hosts/code-host.ts';
import type { HostCall, HostResult } from '../../src/hosts/exec.ts';
import type { HostRun } from '../../src/hosts/detector.ts';

/** The two probes and the default branch: all that detection and readiness ask of an adapter. */
function stub(id: CodeHostId, cli: 'gh' | 'glab', versionArgs: string[]): CodeHostAdapter {
  const call = (args: string[], host: string | null): HostCall => ({ cli, args, kind: 'read', class: 'probe', host });
  const fail = (): never => {
    throw new Error('not used by detection or readiness');
  };
  return {
    id,
    refPrefix: id === 'github' ? '#' : '!',
    env: () => ({ set: {}, unset: [] }),
    version: () => call(versionArgs, null),
    parseVersion: (stdout) => /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null,
    authStatus: (hostname) => (id === 'github' ? call(['auth', 'status', '--json', 'hosts'], null) : call(['auth', 'status', '--hostname', hostname], hostname)),
    parseAuth: (result, hostname) => {
      if (id === 'gitlab') return { signedIn: result.exitCode === 0, user: null };
      try {
        const json = JSON.parse(result.stdout) as { hosts: Record<string, Array<{ active: boolean; state: string; login: string }>> };
        const account = json.hosts[hostname]?.find((entry) => entry.active && entry.state === 'success');
        return { signedIn: Boolean(account), user: account?.login ?? null };
      } catch {
        return { signedIn: false, user: null };
      }
    },
    defaultBranch: (repo) => call(['default-branch', repo.host, repo.path], repo.host),
    parseDefaultBranch: (stdout) => stdout.trim() || null,
    create: fail,
    find: fail,
    parseFind: fail,
    view: fail,
    parseView: fail,
  };
}

export const ghStub = stub('github', 'gh', ['--version']);
export const glabStub = stub('gitlab', 'glab', ['version']);

export const adapterOf = (id: CodeHostId): CodeHostAdapter => (id === 'github' ? ghStub : glabStub);

export const answer = (stdout: string, exitCode: number | null = 0, extra: Partial<HostResult> = {}): HostResult => ({
  exitCode,
  stdout,
  stderrFirstLine: '',
  http: null,
  truncated: false,
  durationMs: 1,
  ...extra,
});

export const ghHosts = (hosts: Record<string, string | null>): string =>
  JSON.stringify({
    hosts: Object.fromEntries(
      Object.entries(hosts).map(([name, login]) => [
        name,
        login === null ? [] : [{ state: 'success', active: true, host: name, login }],
      ]),
    ),
  });

export interface Script {
  ghVersion?: string;
  glabVersion?: string;
  /** What `gh auth status --json hosts` prints */
  ghAuth?: string;
  /** The hostnames glab is signed in to */
  glabSignedIn?: string[];
  defaultBranch?: HostResult;
  /** Every call that was run, in order */
  calls?: HostCall[];
}

/** A `run` that answers the calls the adapters above make, from a script, and records them. */
export function scripted(script: Script): HostRun {
  return async (call) => {
    script.calls?.push(call);
    const [first, second] = call.args;
    if (call.cli === 'gh') {
      if (first === '--version') return answer(`gh version ${script.ghVersion ?? '2.92.0'} (2026-04-28)\n`);
      if (first === 'auth') return answer(script.ghAuth ?? ghHosts({}));
    } else {
      if (first === 'version') return answer(`glab ${script.glabVersion ?? '1.120.0'} (2026-09-01)\n`);
      if (first === 'auth') {
        const host = call.args[3] ?? '';
        return script.glabSignedIn?.includes(host) ? answer('') : answer('', 1, { stderrFirstLine: `x No token found for ${host}` });
      }
    }
    if (first === 'default-branch') return script.defaultBranch ?? answer('main\n');
    return answer('', 1, { stderrFirstLine: `unscripted ${first} ${second}` });
  };
}
