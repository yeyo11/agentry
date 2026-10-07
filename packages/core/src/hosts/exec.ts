import { spawn } from 'node:child_process';
import type { HostReason } from '@agentry/shared';
import { classifyCall, reasonOf } from './classify.ts';
import { buildHostEnv } from './env.ts';
import { HostBusyError, hostLimiter, type HostLimiter } from './limits.ts';
import type { HostRateLimiter } from './rate-limit.ts';
import { firstLine, redactHostText } from './redact.ts';
import { retryRead, type RetryOptions } from './retry.ts';

// The one place that starts `gh`, `glab`, `youtrack-app`. An adapter never runs anything: it
// returns a HostCall and parses what came back. The rules (process groups, timeouts per class, the
// stdout caps, stdout/stderr/exit code as three separate things) are in docs/plans/code-hosts.md,
// "The execution layer".

export interface HostCall {
  cli: 'gh' | 'glab' | 'youtrack-app';
  /** argv, never a shell string */
  args: string[];
  /** stdin; bodies always travel here or in a 0600 temp file */
  input?: string;
  /** declared by the adapter, checked by the classifier */
  kind: 'read' | 'write';
  /** picks the timeout and the caps */
  class: 'probe' | 'read' | 'write' | 'log' | 'long-write';
  /** the pinned host, for the breaker and the concurrency cap */
  host: string | null;
  /** GitHub's rate-limit bucket; GitLab has one */
  bucket?: 'core' | 'graphql' | 'search';
}

export interface HostResult {
  /** null when Agentry killed it, or the system did */
  exitCode: number | null;
  /** the data; parsed only when exitCode === 0 (the host's structured error fields excepted) */
  stdout: string;
  /** redacted, 500 chars, for the person to read; never parsed */
  stderrFirstLine: string;
  /** redacted and cut at 2000 chars: only for an adapter that must read a boxed refusal (glab's merge), never shown as it is */
  stderrText?: string;
  /** from `api -i` only */
  http: { status: number; headers: Record<string, string> } | null;
  truncated: boolean;
  durationMs: number;
  /** why Agentry itself stopped or refused the call; a reason from the host is `reasonOf`'s */
  reason?: HostReason | null;
}

const MIB = 1024 * 1024;

/** Timeouts per class (ms): a probe is a version or an auth check; a long write is a merge, which waits on the host */
export const CLASS_TIMEOUT_MS: Readonly<Record<HostCall['class'], number>> = {
  probe: 15_000,
  read: 60_000,
  log: 60_000,
  write: 120_000,
  'long-write': 180_000,
};

export interface ExecCaps {
  /** stdout read before the process is killed */
  stdoutBytes: number;
  /** a log keeps this much of its end while streaming */
  tailBytes: number;
  /** a log is cut after reading this much */
  logReadBytes: number;
  /** stderr keeps its first bytes */
  stderrBytes: number;
}

export const DEFAULT_CAPS: Readonly<ExecCaps> = { stdoutBytes: 32 * MIB, tailBytes: 512 * 1024, logReadBytes: 64 * MIB, stderrBytes: 8 * 1024 };

export interface SpawnOptions {
  binaryPath: string;
  /** the project's checkout for reads, the item's worktree for writes about its branch, a scratch directory for the rest */
  cwd: string;
  /** the environment to start from; the CLI's variables are removed and set on a copy */
  baseEnv?: NodeJS.ProcessEnv;
  /** credentials Agentry stores for this CLI, passed in the environment and never in argv */
  secretEnv?: Record<string, string>;
  /** replaces the class's timeout, for tests */
  timeoutMs?: number;
  /** SIGTERM to SIGKILL, 5 s */
  killGraceMs?: number;
  caps?: Partial<ExecCaps>;
}

export interface RunOptions extends SpawnOptions {
  breaker?: HostRateLimiter;
  limiter?: HostLimiter;
  retry?: RetryOptions;
}

const HEAD = /^HTTP\/\d(?:\.\d)? (\d{3})/;

/** Splits the status line and headers `api -i` prints before the body. Header names are lower case; a repeated one keeps its last value. */
export function splitHttpHead(text: string): { http: HostResult['http']; body: string } {
  const match = HEAD.exec(text);
  if (!match) return { http: null, body: text };
  const end = /\r?\n\r?\n/.exec(text);
  const head = end ? text.slice(0, end.index) : text;
  const body = end ? text.slice(end.index + end[0].length) : '';
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { http: { status: Number(match[1]), headers }, body };
}

const includesHead = (args: readonly string[]): boolean => args.includes('-i') || args.includes('--include');

/** `gh api rate_limit` is exempt from the breaker: its counts did not match the headers of the same calls (recorded) */
const isRateLimitProbe = (call: HostCall): boolean => call.args[0] === 'api' && call.args.some((a) => a === 'rate_limit' || a.endsWith('/rate_limit'));

function refusal(reason: HostReason): HostResult {
  return { exitCode: null, stdout: '', stderrFirstLine: '', http: null, truncated: false, durationMs: 0, reason };
}

/** Starts one process and reports what it did. No retry, no breaker, no slot: see `runHostCall`. */
export function spawnHostCall(call: HostCall, options: SpawnOptions): Promise<HostResult> {
  const caps = { ...DEFAULT_CAPS, ...options.caps };
  const timeoutMs = options.timeoutMs ?? CLASS_TIMEOUT_MS[call.class];
  const graceMs = options.killGraceMs ?? 5_000;
  const isLog = call.class === 'log';
  const started = Date.now();

  return new Promise((resolve) => {
    // A process group of its own, so that a shim that starts another process can be killed with it
    const child = spawn(options.binaryPath, call.args, {
      shell: false,
      cwd: options.cwd,
      env: buildHostEnv(call.cli, options.baseEnv, options.secretEnv),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    let timedOut = false;
    let overflow = false;
    let cut = false;
    let missing = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let finished = false;
    const timers: NodeJS.Timeout[] = [];

    const chunks: Buffer[] = [];
    let held = 0;
    let read = 0;
    const errChunks: Buffer[] = [];
    let errHeld = 0;

    const stop = (): void => {
      killGroup('SIGTERM');
      timers.push(
        setTimeout(() => {
          killGroup('SIGKILL');
          // Pipes a survivor held open are cut here, so the result never waits on them
          timers.push(setTimeout(finish, 1_000));
        }, graceMs),
      );
    };

    function finish(): void {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // Anything still alive in the group after a normal exit is a stray; nothing is left behind
      if (exit !== null || timedOut || overflow) killGroup('SIGKILL');
      const raw = Buffer.concat(chunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      const killed = timedOut || overflow || missing;
      // A killed or cut answer has lost its head, so nothing is read from it
      const split = includesHead(call.args) && !killed && !cut ? splitHttpHead(raw) : { http: null, body: raw };
      let reason: HostReason | null = null;
      if (missing) reason = 'cli-missing';
      else if (overflow) reason = 'output-too-large';
      else if (timedOut) reason = 'timeout';
      resolve({
        exitCode: killed ? null : (exit?.code ?? null),
        stdout: split.body,
        stderrFirstLine: firstLine(stderr),
        stderrText: redactHostText(stderr).slice(0, 2000),
        http: split.http,
        truncated: cut || overflow,
        durationMs: Date.now() - started,
        reason,
      });
    }

    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs),
    );

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') missing = true;
      finish();
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // `close` follows once the pipes end; a survivor holding them open must not hold the result
      timers.push(setTimeout(finish, 1_000));
    });
    child.on('close', finish);

    child.stdout?.on('data', (data: Buffer) => {
      if (finished || overflow) return;
      read += data.length;
      chunks.push(data);
      held += data.length;
      if (isLog) {
        // The tail ring: only the end of a log is kept, so a multi-megabyte job log never sits in memory
        while (held - (chunks[0]?.length ?? 0) >= caps.tailBytes && chunks.length > 1) held -= chunks.shift()?.length ?? 0;
        if (held > caps.tailBytes) {
          const first = chunks[0];
          if (first) {
            const drop = held - caps.tailBytes;
            chunks[0] = first.subarray(drop);
            held -= drop;
          }
        }
        if (read > caps.tailBytes) cut = true;
        if (read > caps.logReadBytes) {
          overflow = true;
          stop();
        }
        return;
      }
      if (read > caps.stdoutBytes) {
        // Over the cap: the process is stopped and only the end of what came is kept
        overflow = true;
        cut = true;
        const kept = Buffer.concat(chunks);
        chunks.length = 0;
        chunks.push(kept.subarray(Math.max(0, kept.length - caps.tailBytes)));
        stop();
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (errHeld >= caps.stderrBytes) return;
      const piece = data.subarray(0, caps.stderrBytes - errHeld);
      errChunks.push(piece);
      errHeld += piece.length;
    });
    // A CLI that exits before reading its stdin must not take Agentry down with EPIPE
    child.stdin?.on('error', () => {});
    // stdin is always given and closed, so no CLI ever waits on a terminal
    child.stdin?.end(call.input ?? '');
  });
}

/**
 * Runs a call the way every caller must: the breaker is asked first, a slot is taken for each
 * process, a read is retried (a write never is), and the breaker learns from the headers of what
 * came back. The kind is the stricter of the adapter's and the classifier's.
 */
export async function runHostCall(call: HostCall, options: RunOptions): Promise<HostResult> {
  const limiter = options.limiter ?? hostLimiter;
  const kind: HostCall['kind'] = call.kind === 'write' || classifyCall(call) === 'write' ? 'write' : 'read';
  const bucket = call.bucket ?? 'core';
  const metered = options.breaker !== undefined && call.host !== null && !isRateLimitProbe(call);
  const breaker = metered ? options.breaker : undefined;
  const host = call.host ?? '';

  const once = async (): Promise<HostResult> => {
    const state = breaker?.check(host, bucket);
    if (state?.open) return { ...refusal(state.reason), stderrFirstLine: '' };
    let release: () => void;
    try {
      release = await limiter.acquire(call.cli);
    } catch (error) {
      if (error instanceof HostBusyError) return refusal('busy');
      throw error;
    }
    let result: HostResult;
    try {
      result = await spawnHostCall(call, options);
    } finally {
      release();
    }
    if (breaker && result.http) {
      const after = breaker.record(host, bucket, result.http);
      if (after.open && (result.http.status === 403 || result.http.status === 429)) result.reason = after.reason;
    }
    result.reason ??= result.exitCode === 0 ? null : reasonOf(result, call.cli);
    return result;
  };

  if (kind === 'write') return once();
  return retryRead(once, call.cli, {
    ...options.retry,
    isOpen: () => breaker?.check(host, bucket).open ?? false,
    openFor: (ms) => breaker?.openFor(host, bucket, ms),
  });
}
