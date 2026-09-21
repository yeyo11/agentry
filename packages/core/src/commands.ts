// What "the same command" and "longer than usual" mean. A shell command a worker runs is compared
// with the ones of its own kind that ran before, so `pnpm e2e` is judged against `pnpm e2e` and not
// against `ls`, and a suite that always takes twenty minutes is not called hung at three.

/** Programs whose first real argument says what they do: `pnpm e2e`, `cargo test`, `git log`. */
const SUBCOMMAND_PROGRAMS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'make', 'docker', 'git', 'gh', 'dotnet', 'gradle', 'mvn', 'pip', 'uv', 'poetry']);
/** Interpreters: what they run is the script, so that names the kind. */
const SCRIPT_PROGRAMS = new Set(['node', 'tsx', 'python', 'python3', 'bash', 'sh', 'zsh', 'deno', 'ruby']);
/** Flags that take a value, so the value is not mistaken for the subcommand. */
const VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--cwd', '--workspace', '-w', '--config', '-c', '-p', '--package']);
/** Words a package manager takes before the script it runs. */
const RUNNERS = new Set(['run', 'run-script', 'exec', 'dlx', 'x']);
/** Wrappers that change how a command runs and not what it is. */
const WRAPPERS = new Set(['time', 'nice', 'nohup', 'env', 'command', 'exec', 'sudo', 'ionice', 'stdbuf', 'unbuffer']);

const words = (segment: string): string[] => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

/**
 * The kind of a shell command: what it runs, without the arguments that differ each time. `cd app &&
 * timeout 300 pnpm --filter web test -- a.test.ts` is `pnpm test`. A command that is only a name
 * (`ls -la`) is the name. Empty input has no kind.
 */
export function commandKind(command: string): string {
  // The last stage of `cd x && …` is the one that takes the time; a pipeline is judged by its head
  const stages = command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^(cd|export|set|source|\.|umask|unset)\b/.test(s));
  const stage = stages[stages.length - 1] ?? stages[0] ?? command;
  const head = stage.split(/(?<!\|)\|(?!\|)/)[0] ?? stage;
  let tokens = words(head);
  // Environment assignments, then wrappers with their own flags, then `timeout <duration>`
  for (;;) {
    const first = tokens[0];
    if (first === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPERS.has(first)) tokens = tokens.slice(1);
    else if (first === 'timeout') {
      tokens = tokens.slice(1);
      while (tokens[0]?.startsWith('-')) {
        // `-k 5` and `-s TERM` carry their value as the next word; `--kill-after=5` carries it itself
        const takesValue = /^(?:-k|-s|--kill-after|--signal)$/.test(tokens[0]);
        tokens = tokens.slice(takesValue ? 2 : 1);
      }
      tokens = tokens.slice(1);
    } else break;
  }
  const program = tokens[0]?.replace(/^.*\//, '');
  if (!program) return '';
  const rest = tokens.slice(1);
  if (SUBCOMMAND_PROGRAMS.has(program)) {
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i] as string;
      if (VALUE_FLAGS.has(word)) i++;
      else if (word.startsWith('-') || RUNNERS.has(word)) continue;
      else return `${program} ${word}`;
    }
    return program;
  }
  if (SCRIPT_PROGRAMS.has(program)) {
    const script = rest.find((w) => !w.startsWith('-'));
    return script ? `${program} ${script.replace(/^["']|["']$/g, '')}` : program;
  }
  return program;
}

/** What a kind of command usually takes, from the durations of the runs that ended well. */
export interface UsualDuration {
  samples: number;
  medianMs: number;
  p90Ms: number;
}

/** Fewer runs than this say nothing about what is usual, and the fixed limit applies instead. */
export const MIN_SAMPLES = 5;

/**
 * The usual duration of a kind of command, or null while there is too little history to say. Only
 * runs that ended without an error count: a hung run that was cancelled at three minutes would
 * otherwise teach the next one that three minutes is normal.
 */
export function usualDuration(durationsMs: readonly number[]): UsualDuration | null {
  if (durationsMs.length < MIN_SAMPLES) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return { samples: sorted.length, medianMs: at(0.5), p90Ms: at(0.9) };
}

/** A command is only "far longer than usual" well past its slowest ordinary run. */
const SLOW_FACTOR = 3;
const P90_FACTOR = 1.5;
/** Whatever the history says, a command that ends in seconds is not worth a signal until this */
const FLOOR_MS = 30_000;

/** How long a command of a kind may run before it is called slow. */
export function slowAfterMs(usual: UsualDuration): number {
  return Math.max(FLOOR_MS, SLOW_FACTOR * usual.medianMs, P90_FACTOR * usual.p90Ms);
}
