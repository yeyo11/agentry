import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { CodeHostId, CodeHostsSettings, ProjectCodeHostRemote, PullRequestNotReadyReason, PullRequestReadiness, PullRequestRemedy } from '@agentry/shared';
import { git, isGitRepo, mainCheckout } from '../git.ts';
import { compareVersions } from '../version-check.ts';
import type { CodeHostAdapter, HostRepo } from './code-host.ts';
import {
  defaultHostRun,
  hostnamesOfAuthJson,
  hostSearchPath,
  probeHostVersion,
  resolveHostBinary,
  type HostRun,
  type HostRunWhere,
} from './detector.ts';
import { glabKnownHosts, type GlabKnownHost } from './known-hosts.ts';
import type { CodeHostManifest } from './manifest.ts';
import { CodeHostRegistry } from './registry.ts';
import { parseRemote, resolveSshHost, type SshExec } from './remote.ts';

/** git's own page on remotes: what a project without `origin` needs. */
export const REMOTES_DOCS_URL = 'https://git-scm.com/book/en/v2/Git-Basics-Working-with-Remotes';

export interface ReadinessDeps {
  registry?: CodeHostRegistry;
  /** The adapter of a host, looked up by id */
  adapter: (id: CodeHostId) => CodeHostAdapter | undefined;
  /** What the person chose; null (or a missing entry) means every host is on, searching for its binary */
  settings?: () => CodeHostsSettings | null;
  run?: HostRun;
  /** Runs `ssh`, for `ssh -G` on an alias; defaults to the real one */
  sshExec?: SshExec;
  /** The hosts glab's own configuration lists; defaults to reading its `config.yml` */
  glabHosts?: () => Promise<GlabKnownHost[]>;
  /** The PATH to search; defaults to the current one plus the install directories */
  resolvePath?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const realSsh: SshExec = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split('\n').find((line) => line.trim()) ?? text).trim().slice(0, 500);
}

/** `owner/name` of a path with any number of groups: the name is the last segment, the owner the rest. */
function repoOf(hostname: string, path: string): HostRepo {
  const at = path.lastIndexOf('/');
  return { host: hostname, path, owner: at === -1 ? '' : path.slice(0, at), name: path.slice(at + 1) };
}

/**
 * Whether a project can open change requests, in the order the plan lists: the checks stop at the
 * first that fails and say what to do about it. It runs its own `--version` and auth probe and
 * never reads the detector's cache, so the calls a CLI receives for a project are the same every
 * time. An unknown host is never sent to a CLI.
 */
export async function projectReadiness(projectPath: string, deps: ReadinessDeps): Promise<PullRequestReadiness> {
  const registry = deps.registry ?? new CodeHostRegistry();
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const run = deps.run ?? defaultHostRun;
  const settings = deps.settings?.() ?? null;
  const ssh = deps.sshExec ?? realSsh;

  let host: CodeHostId | null = null;
  let hostname: string | null = null;
  const no = (
    status: PullRequestNotReadyReason,
    detail: string | null,
    remedy: PullRequestRemedy | null,
    defaultBranch: string | null = null,
  ): PullRequestReadiness => ({ status, detail, defaultBranch, host, hostname, remedy });

  if (!existsSync(projectPath) || !isGitRepo(projectPath)) return no('not-git', null, null);
  const checkout = mainCheckout(projectPath);
  let url: string;
  try {
    url = git(checkout, ['remote', 'get-url', 'origin'], 10_000);
  } catch (err) {
    return no('no-remote', messageOf(err), { kind: 'docs', url: REMOTES_DOCS_URL });
  }

  // Which CLI the host belongs to. What is neither hosted by default nor listed by a CLI goes to none
  const unsupported = (detail: string | null): PullRequestReadiness => no('unsupported-host', detail, { kind: 'settings', url: null });
  const parsed = parseRemote(url);
  if (!parsed) return unsupported(null);
  const remote: ProjectCodeHostRemote = { hostname: parsed.hostname, path: parsed.path, protocol: parsed.protocol };
  hostname = remote.protocol === 'ssh' ? await resolveSshHost(parsed.hostname, ssh) : parsed.hostname;
  if (parsed.port !== null) return unsupported(`${hostname}:${parsed.port}`);

  const searchPath = await (deps.resolvePath ? deps.resolvePath() : hostSearchPath(env, home));
  const where = (binaryPath: string, cwd: string): HostRunWhere => ({ binaryPath, cwd, env: { ...env, PATH: searchPath } });
  const enabled = registry.list().filter((m) => settings?.hosts[m.id]?.enabled !== false);
  const overrideOf = (manifest: CodeHostManifest): string | null => settings?.hosts[manifest.id]?.binaryPath ?? null;

  let manifest: CodeHostManifest | undefined = registry.byDefaultHost(hostname);
  if (manifest && !enabled.includes(manifest)) return unsupported(`${hostname}: ${manifest.label} is turned off`);
  if (!manifest) {
    // The CLIs' own lists, in registry order: a host both know goes to the first
    for (const candidate of enabled) {
      if (await knows(candidate, hostname)) {
        manifest = candidate;
        break;
      }
    }
  }
  if (!manifest) return unsupported(hostname);
  host = manifest.id;

  async function knows(candidate: CodeHostManifest, name: string): Promise<boolean> {
    if (candidate.auth.kind === 'exit-code') {
      const hosts = deps.glabHosts ? await deps.glabHosts() : await glabKnownHosts({ env, home });
      return hosts.some((entry) => entry.hostname === name);
    }
    const adapter = deps.adapter(candidate.id);
    const binary = await resolveHostBinary(candidate, overrideOf(candidate), searchPath);
    if (!adapter || !binary) return false;
    const result = await run(adapter.authStatus(name), where(binary, checkout));
    return result.exitCode === 0 && (hostnamesOfAuthJson(result.stdout) ?? []).includes(name);
  }

  const adapter = deps.adapter(manifest.id);
  const install: PullRequestRemedy = { kind: 'install', url: manifest.install.url };
  const binaryPath = await resolveHostBinary(manifest, overrideOf(manifest), searchPath);
  if (!binaryPath || !adapter) return no('cli-missing', null, install);

  const version = await probeHostVersion(adapter, run, where(binaryPath, checkout));
  if (version.kind === 'timeout') return no('cli-missing', `${manifest.cli} did not answer`, install);
  if (version.kind === 'failed') return no('cli-missing', version.detail, install);
  if (version.kind === 'unreadable') return no('cli-missing', `${manifest.cli}: unreadable version`, install);
  if (compareVersions(version.version, manifest.versions.minimum) < 0) {
    return no('cli-incompatible', `${manifest.cli} ${version.version} < ${manifest.versions.minimum}`, install);
  }

  const auth = await run(adapter.authStatus(hostname), where(binaryPath, checkout));
  if (!adapter.parseAuth(auth, hostname).signedIn) {
    return no('cli-signed-out', auth.stderrFirstLine ? `${hostname}: ${auth.stderrFirstLine}` : hostname, { kind: 'sign-in', url: manifest.signInUrl });
  }

  const docs: PullRequestRemedy = { kind: 'docs', url: manifest.docsUrl };
  let base: string | null = null;
  try {
    base = git(checkout, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 10_000).replace(/^origin\//, '') || null;
  } catch {
    // not set locally: the CLI knows it
  }
  if (!base) {
    const result = await run(adapter.defaultBranch(repoOf(hostname, remote.path)), where(binaryPath, checkout));
    if (result.exitCode !== 0) return no('no-default-branch', result.stderrFirstLine || null, docs);
    try {
      base = adapter.parseDefaultBranch(result.stdout);
    } catch (err) {
      return no('no-default-branch', messageOf(err), docs);
    }
  }
  if (!base) return no('no-default-branch', null, docs);
  return { status: 'ready', detail: null, defaultBranch: base, host, hostname, remedy: null };
}
