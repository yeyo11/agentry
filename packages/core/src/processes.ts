import { readdirSync, readFileSync } from 'node:fs';

export interface CliProcess {
  pid: number;
  argv: string[];
}

/**
 * Whether a process is a CLI the wrapper started for that session: stream-json on stdin, and the
 * session on `--resume` or `--session-id`. Matching on the arguments rather than the binary is
 * what also finds one started through `cswap run … --`, and a pid the system has since reused for
 * something else does not match. A `--fork-session` process works on a copy, not on the session it
 * names, so it only counts as the very process a run recorded.
 */
export function drivesSession(argv: readonly string[], sessionId: string, recorded = false): boolean {
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  if (flag('--input-format') !== 'stream-json') return false;
  if (argv.includes('--fork-session')) return recorded;
  return flag('--resume') === sessionId || flag('--session-id') === sessionId;
}

/**
 * Every process in the table that takes stream-json on stdin, read once so that matching many runs
 * against it costs one pass. Only Linux exposes argument vectors without spawning `ps`; elsewhere
 * nothing is found, and the wrapper behaves as it did before it looked.
 */
export function streamJsonProcesses(): CliProcess[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const found: CliProcess[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let argv: string[];
    try {
      // A zombie's is empty, and one that exited in between cannot be read: both are gone
      argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (argv.includes('stream-json')) found.push({ pid: Number(name), argv });
  }
  return found;
}
