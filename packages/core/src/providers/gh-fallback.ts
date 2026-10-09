import { tmpdir } from 'node:os';
import { runHostCall, type HostCall } from '../hosts/exec.ts';
import { resolveCommand } from './path.ts';

/**
 * Whether the GitHub CLI holds a token for `hostname`, the way a CLI that falls back to it asks:
 * `gh auth token --hostname <host>` (Copilot's documented last credential source). It runs the `gh`
 * found on the same PATH the agent gets, so the answer is the one the agent will see, through the
 * code-host execution layer (gh's own environment, a process group, a timeout). Only the exit code
 * and whether anything was printed are read; the token is dropped here and never logged.
 */
export async function ghHasToken(hostname: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<boolean> {
  const binaryPath = await resolveCommand('gh', env.PATH ?? '');
  if (!binaryPath) return false;
  const call: HostCall = { cli: 'gh', args: ['auth', 'token', '--hostname', hostname], kind: 'read', class: 'probe', host: hostname };
  try {
    const result = await runHostCall(call, { binaryPath, cwd: tmpdir(), baseEnv: env, timeoutMs, killGraceMs: 1_000, retry: { delaysMs: [] } });
    // A signed-out gh exits 1; a probe is never retried, it is read again at the next detection
    return result.exitCode === 0 && result.stdout.trim() !== '';
  } catch {
    return false;
  }
}
