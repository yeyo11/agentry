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

/** Stages that only prepare the shell for the next one. */
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'umask', 'unset', 'alias']);
/** Stages that report on the work or steer the shell around it, and never take the time themselves. */
const NO_OP = new Set(['echo', 'printf', 'true', 'false', ':', 'exit', 'test', '[', '[[', 'for', 'fi', 'done', 'esac', '}']);
/** Stages that do a little work of their own: they name the kind only when nothing heavier ran. */
const LIGHT = new Set(['tail', 'head', 'cat', 'wc', 'sleep']);
/** Shell keywords in front of the command they guard: `if pnpm test; then …`, `do pnpm e2e; done`. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{']);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The `&&`/`||`/`;`/newline stages of a command line, each cut to its pipeline head. Quotes are
 * respected because a worker's `git commit -m "…"` routinely carries `;` and newlines, and
 * here-document bodies are dropped because their lines are text, not commands.
 */
function stageHeads(command: string): string[] {
  const heads: string[] = [];
  const heredocs: string[] = [];
  let current = '';
  let inPipeTail = false;
  let quote: '"' | "'" | null = null;
  const add = (text: string) => {
    if (!inPipeTail) current += text;
  };
  const end = () => {
    heads.push(current.trim());
    current = '';
    inPipeTail = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    const two = command.slice(i, i + 2);
    if (quote) {
      if (c === quote) quote = null;
      if (c === '\\' && quote === '"') {
        add(two);
        i++;
      } else add(c);
    } else if (c === '\\') {
      // A backslash-newline continues the line; any other escaped character is just that character
      if (command[i + 1] !== '\n') add(two);
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
      add(c);
    } else if (two === '&&' || two === '||') {
      end();
      i++;
    } else if (c === ';') {
      end();
    } else if (c === '\n') {
      end();
      // The body of each here-document opened on this line runs up to its delimiter line
      for (const delimiter of heredocs.splice(0)) {
        const close = new RegExp(`^[\\t ]*${escapeRegExp(delimiter)}[\\t ]*$`, 'm').exec(command.slice(i + 1));
        i = close ? i + 1 + close.index + close[0].length : command.length;
      }
    } else if (c === '|') {
      inPipeTail = true;
      if (command[i + 1] === '&') i++;
    } else if (c === '(' || c === ')') {
      add(' ');
    } else if (two === '<<' && command[i + 2] !== '<') {
      const opener = /^<<-?[\t ]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(command.slice(i));
      const delimiter = opener?.[1] ?? opener?.[2] ?? opener?.[3];
      if (opener && delimiter) {
        heredocs.push(delimiter);
        add(opener[0]);
        i += opener[0].length - 1;
      } else add(c);
    } else add(c);
  }
  end();
  return heads.filter(Boolean);
}

const REDIRECTION = /^\d*(?:&>>?|>>?|<<<|<<-?|<>?)(&\d*-?)?$/;

/**
 * The words of a stage without its redirections. `> /tmp/x.log 2>&1` only says where the output
 * goes; left in, `python3 2>/dev/null x.py` would run the script `2>/dev/null`, and `>out pnpm test`
 * would be the program `>out`.
 */
function words(stage: string): string[] {
  const tokens = stage.match(/"[^"]*"|'[^']*'|\d*(?:&>>?|>>?|<<<|<<-?|<>?)(?:&\d*-?)?|[^\s<>]+/g) ?? [];
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const redirection = REDIRECTION.exec(token);
    if (!redirection) kept.push(token);
    // `2>&1` and `>&2` carry their target; `> file` and `<<EOF` take the next word as theirs
    else if (!redirection[1]) i++;
  }
  return kept;
}

/** A stage's program and its arguments, past keywords, env assignments, wrappers and `timeout <duration>`. */
function unwrap(stage: string): string[] {
  let tokens = words(stage);
  for (;;) {
    const first = tokens[0];
    if (first === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPERS.has(first) || KEYWORDS.has(first)) tokens = tokens.slice(1);
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
  return tokens;
}

const programOf = (tokens: readonly string[]) => tokens[0]?.replace(/^.*\//, '');

/** How much a stage says about where the time goes: real work, then a `tail`, then an `echo`, then a `cd`. */
function weight(program: string | undefined): number {
  if (!program || SETUP.has(program)) return 0;
  if (NO_OP.has(program)) return 1;
  if (LIGHT.has(program)) return 2;
  return 3;
}

/**
 * The kind of a shell command: what it runs, without the arguments that differ each time. `cd app &&
 * timeout 300 pnpm --filter web test -- a.test.ts` is `pnpm test`. A command that is only a name
 * (`ls -la`) is the name. Empty input has no kind.
 *
 * The kind has to name the stage that takes the time, because that is what the running command is
 * measured against. Workers wrap the work in setup in front (`cd x && …`) and bookkeeping behind
 * (`…; echo exit=$?`, `… && echo done`, `… || true`, `…; tail -5 log`); judged by its trailing
 * `echo`, a one-minute `pnpm test` "usually takes a second" and was called hung. So the last stage
 * doing real work wins, and only a command with none is named by its last light stage (`sleep 60`)
 * or, failing that, its last trivial one (`echo hi`). A pipeline spends its time in its head.
 */
export function commandKind(command: string): string {
  let tokens: string[] = [];
  let best = -1;
  for (const stage of stageHeads(command)) {
    const candidate = unwrap(stage);
    const stageWeight = weight(programOf(candidate));
    if (stageWeight >= best) {
      best = stageWeight;
      tokens = candidate;
    }
  }
  const program = programOf(tokens);
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
