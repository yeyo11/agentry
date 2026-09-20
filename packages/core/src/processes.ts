import { readdirSync, readFileSync } from 'node:fs';

export interface CliProcess {
  pid: number;
  argv: string[];
}

/**
 * Whether a process is a CLI working on that session: stream-json on stdin, and the session on
 * `--resume` or `--session-id`. Matching on the arguments rather than the binary is what also finds
 * one started through `cswap run … --`, and a pid the system has since reused for something else
 * does not match. A `--fork-session` process reads the session it resumes but writes the copy named
 * by `--session-id`, so only the copy counts as the session it drives.
 */
export function drivesSession(argv: readonly string[], sessionId: string): boolean {
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  if (flag('--input-format') !== 'stream-json') return false;
  if (argv.includes('--fork-session')) return flag('--session-id') === sessionId;
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

// ---------- one command's process tree ----------

/** A process as the kernel lists it: what is needed to walk a tree and to know a pid is still the same process. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Clock ticks after boot when it started; with the pid it identifies a process for good, since a pid can be reused */
  started: number;
  argv: string[];
}

/**
 * The whole process table, with parents. `/proc/<pid>/stat` puts the command name in parentheses,
 * and the name may itself hold spaces and parentheses, so the fields are read after the last `)`.
 * Empty where `/proc` is not there: nothing can be walked, and callers say so instead of guessing.
 */
export function processTable(): ProcessEntry[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const table: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // After the name come the state, then the ppid, and starttime is the twentieth field
      const ppid = Number(fields[1]);
      const started = Number(fields[19]);
      if (!Number.isFinite(ppid) || !Number.isFinite(started)) continue;
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      table.push({ pid: Number(name), ppid, started, argv });
    } catch {
      // gone between listing and reading
    }
  }
  return table;
}

/** Kernel clock ticks per second; 100 on every Linux Agentry runs on. */
const TICKS_PER_SECOND = 100;

/**
 * When a process started, as a wall-clock time. Null where the boot time is not known. The boot time
 * comes from the uptime, which has a hundredth of a second, and not from `btime` in `/proc/stat`,
 * which is whole seconds: that is a second of error, and a command is told apart from its
 * neighbour by less than that.
 */
export function startedAtMs(entry: ProcessEntry): number | null {
  try {
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    return Number.isFinite(uptime) ? Date.now() - uptime * 1000 + (entry.started / TICKS_PER_SECOND) * 1000 : null;
  } catch {
    return null;
  }
}

/** Every descendant of `root` (not `root` itself), children before their parents. */
export function descendantsOf(table: readonly ProcessEntry[], root: number): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  const out: ProcessEntry[] = [];
  const seen = new Set([root]);
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      walk(child.pid);
      out.push(child);
    }
  };
  walk(root);
  return out;
}

/**
 * The process of the CLI itself under the pid Agentry spawned, which is the same one unless a
 * wrapper (`cswap chat …`) started it as a child: found by what it drives, not by its name.
 */
export function cliProcessOf(table: readonly ProcessEntry[], spawned: number, sessionId: string): ProcessEntry | null {
  const own = table.find((p) => p.pid === spawned);
  if (!own) return null;
  return [own, ...descendantsOf(table, spawned)].find((p) => drivesSession(p.argv, sessionId)) ?? own;
}

/**
 * The roots of the commands a CLI is running. Each shell command the CLI runs is one child of the
 * CLI, started right after the call was made; the children it keeps for its whole life (MCP servers,
 * language servers) started before any command did. So the roots are the children that started at
 * or after the earliest open command, and the i-th oldest command owns the i-th oldest of them. It
 * is a claim about the process tree and the clock, never about a command line: what `pnpm e2e`
 * looks like in `ps` decides nothing.
 *
 * `openSince` is when each open command was called, oldest first. A command with no root of its own
 * (it has not spawned yet, or already ended) gets null, and `unclaimed` counts the children that
 * started in that window and belong to none of them: a caller that knows something else could have
 * started a child there (a background command) must not trust the assignment.
 */
export function commandRoots(
  table: readonly ProcessEntry[],
  cli: number,
  openSince: readonly number[],
  toleranceMs = 2000,
): { roots: Array<ProcessEntry | null>; unclaimed: number } {
  const earliest = openSince[0];
  if (earliest === undefined) return { roots: [], unclaimed: 0 };
  const children = table
    .filter((p) => p.ppid === cli)
    .map((entry) => ({ entry, at: startedAtMs(entry) }))
    .filter((c): c is { entry: ProcessEntry; at: number } => c.at !== null && c.at >= earliest - toleranceMs)
    .sort((a, b) => a.at - b.at);
  const claimed = new Set<number>();
  const roots = openSince.map((since) => {
    const root = children.find((c) => !claimed.has(c.entry.pid) && c.at >= since - toleranceMs);
    if (!root) return null;
    claimed.add(root.entry.pid);
    return root.entry;
  });
  return { roots, unclaimed: children.length - claimed.size };
}

/**
 * Signals a process tree: the descendants first, so nothing is left to be adopted by init and
 * escape, then the root. What survives the grace period gets SIGKILL, but only if it is still the
 * same process (same pid, same start time): a pid the system has reused since is somebody else's.
 * Returns how many processes were signalled, at once: the escalation runs on its own timer, so the
 * request that asked for the cancel does not wait for it.
 */
export function terminateTree(root: ProcessEntry, table: readonly ProcessEntry[], graceMs = 2000): number {
  const victims = [...descendantsOf(table, root.pid), root];
  const signal = (entry: ProcessEntry, name: NodeJS.Signals): boolean => {
    try {
      process.kill(entry.pid, name);
      return true;
    } catch {
      return false; // gone already
    }
  };
  const signalled = victims.filter((victim) => signal(victim, 'SIGTERM')).length;
  setTimeout(() => {
    const now = processTable();
    for (const victim of victims) {
      if (now.some((p) => p.pid === victim.pid && p.started === victim.started)) signal(victim, 'SIGKILL');
    }
  }, graceMs).unref();
  return signalled;
}
