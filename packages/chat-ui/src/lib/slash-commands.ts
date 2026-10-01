/**
 * The slash commands a message box offers while its first word is being typed as one. The list is
 * what the CLI itself reported in its `init` event for the directory, so it holds the commands that
 * work headless (skills, plugin and project commands, the built-ins `-p` accepts) and nothing the
 * wrapper would have to guess.
 */

/** How many suggestions are shown at once: past this, typing narrows faster than scrolling. */
const LIMIT = 50;

/**
 * What follows the `/` of a command still being typed, or null when the box is not typing one: the
 * message must start with `/` and the caret must still be inside that first word.
 */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null;
  const word = /^\/\S*/.exec(text)?.[0] ?? '/';
  if (caret < 1 || caret > word.length) return null;
  return word.slice(1);
}

/** Each name once, without its `/`, in the order the CLI listed them. */
export function commandNames(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const command of commands) {
    const name = command.trim().replace(/^\/+/, '');
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * The commands that match what was typed: those that start with it first, then those that only
 * contain it (`debug` finds `engineering:debug`), each group in the CLI's order.
 */
export function matchCommands(names: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(needle)) starts.push(name);
    else if (lower.includes(needle)) contains.push(name);
  }
  return [...starts, ...contains].slice(0, LIMIT);
}

/** The text with its first word replaced by the chosen command, and where the caret goes after it. */
export function applyCommand(text: string, name: string): { text: string; caret: number } {
  const rest = text.replace(/^\/\S*/, '').replace(/^[^\S\n]+/, '');
  const head = `/${name} `;
  return { text: `${head}${rest}`, caret: head.length };
}
