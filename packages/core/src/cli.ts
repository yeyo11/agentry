import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveCliSession, AuthStatus, CliInfo, TokenSource } from '@agentry/shared';
import type { CoreConfig } from './paths.ts';

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function execCli(
  config: CoreConfig,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      config.claudeBin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolvePromise({ stdout, stderr: stderr || (error && code !== 0 ? error.message : ''), code });
      },
    );
  });
}

function which(bin: string): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

/** Detects the Claude Code installation available in the container. */
export async function detectCli(config: CoreConfig): Promise<CliInfo> {
  const path = which(config.claudeBin);
  if (!path) return { installed: false, version: null, path: null, error: `'${config.claudeBin}' was not found in PATH` };
  const res = await execCli(config, ['--version']);
  if (res.code !== 0) return { installed: false, version: null, path, error: res.stderr.trim() };
  return { installed: true, version: res.stdout.trim().split(' ')[0] ?? null, path };
}

function tokenSource(config: CoreConfig): TokenSource {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'env-oauth-token';
  if (process.env.ANTHROPIC_API_KEY) return 'env-api-key';
  if (existsSync(join(config.configDir, '.credentials.json'))) return 'credentials-file';
  return 'none';
}

export async function getAuthStatus(config: CoreConfig): Promise<AuthStatus> {
  const source = tokenSource(config);
  const res = await execCli(config, ['auth', 'status', '--json']);
  try {
    const json = JSON.parse(res.stdout) as Record<string, unknown>;
    return {
      loggedIn: json.loggedIn === true,
      authMethod: typeof json.authMethod === 'string' ? json.authMethod : undefined,
      apiProvider: typeof json.apiProvider === 'string' ? json.apiProvider : undefined,
      email: typeof json.email === 'string' ? json.email : undefined,
      orgName: typeof json.orgName === 'string' ? json.orgName : undefined,
      subscriptionType: typeof json.subscriptionType === 'string' ? json.subscriptionType : undefined,
      tokenSource: source,
    };
  } catch {
    return { loggedIn: false, tokenSource: source, error: (res.stderr || res.stdout).trim().slice(0, 500) };
  }
}

/**
 * Whether an agent the CLI lists is a session actually open for work.
 *
 * Two of the processes `claude agents --json` reports are not. One it marks `state: 'done'` —
 * it finished, its pid just has not gone yet. The other is the spare the daemon pre-warms for an
 * attach: it holds a session id, but its transcript carries only the slash command that spawned
 * it, never a user turn, which is what leaves `firstPrompt` null. A missing summary proves
 * nothing (a session that started seconds ago has no transcript yet), so it counts as live.
 */
export function isLiveCliSession(agent: { state?: string }, summary: { firstPrompt: string | null } | null): boolean {
  if (agent.state === 'done') return false;
  return summary === null || summary.firstPrompt !== null;
}

/** Live CLI sessions (interactive and background) as reported by `claude agents --json`. */
export async function listActiveCliSessions(config: CoreConfig): Promise<Array<Omit<ActiveCliSession, 'live'>>> {
  const res = await execCli(config, ['agents', '--json']);
  try {
    const arr = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => ({
      pid: Number(s.pid ?? 0),
      cwd: String(s.cwd ?? ''),
      kind: String(s.kind ?? 'unknown'),
      startedAt: Number(s.startedAt ?? 0),
      sessionId: String(s.sessionId ?? ''),
      name: String(s.name ?? ''),
      status: String(s.status ?? 'unknown'),
      ...(typeof s.state === 'string' ? { state: s.state } : {}),
    }));
  } catch {
    return [];
  }
}
