/**
 * What "an agent is doing this right now" looks like, without React: the braille spinner's frames,
 * the verb a tool call reads as, and the clock a ticker counts with. Kept here so it can be unit
 * tested and so the chat, the lists, Home and the orchestration all say the same thing.
 */

/** The braille spinner every terminal uses; ten frames make one turn. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** What the spinner shows when motion is `subtle` or `off`: still there, still saying "busy". */
export const SPINNER_STILL = '⠿';

export function spinnerGlyph(index: number, moving = true): string {
  if (!moving) return SPINNER_STILL;
  const frames = SPINNER_FRAMES;
  return frames[((index % frames.length) + frames.length) % frames.length] ?? SPINNER_STILL;
}

/**
 * The shape `ChatActivity` has in `@agentry/shared`, declared structurally so this file and the
 * types task can land independently. Anything with these fields can be given to an `ActivityTicker`.
 */
export interface TickerActivity {
  kind: 'tool' | 'writing' | 'thinking' | 'waiting';
  tool?: string;
  target?: string;
  /** ISO timestamp of when this started */
  since: string;
}

/** The verbs a ticker says; each has its text under `primitives:activity.<verb>`. */
export const ACTIVITY_VERBS = ['editing', 'reading', 'running', 'searching', 'delegating', 'browsing', 'writing', 'thinking', 'waiting', 'working'] as const;
export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

const TOOL_VERBS: Record<string, ActivityVerb> = {
  edit: 'editing',
  write: 'editing',
  multiedit: 'editing',
  notebookedit: 'editing',
  read: 'reading',
  notebookread: 'reading',
  bash: 'running',
  bashoutput: 'running',
  grep: 'searching',
  glob: 'searching',
  ls: 'searching',
  task: 'delegating',
  agent: 'delegating',
  webfetch: 'browsing',
  websearch: 'browsing',
};

/**
 * A tool call reads as what a person would say they are doing. A tool nobody has mapped — an MCP
 * server's, a new one from the CLI — falls back to "working" and shows its own name as the target,
 * which is more honest than inventing a verb for it.
 */
export function activityVerb(activity: TickerActivity): ActivityVerb {
  if (activity.kind === 'writing') return 'writing';
  if (activity.kind === 'thinking') return 'thinking';
  if (activity.kind === 'waiting') return 'waiting';
  const tool = activity.tool?.trim().toLowerCase() ?? '';
  return TOOL_VERBS[tool] ?? 'working';
}

/**
 * The mono part of a ticker line. A mapped tool has said its name in the verb already, so only its
 * target is shown; an unmapped one shows its name, and an MCP tool the part a person chose.
 */
export function activityTarget(activity: TickerActivity): string {
  const target = activity.target?.trim() ?? '';
  if (activity.kind !== 'tool') return target;
  const tool = activity.tool?.trim() ?? '';
  if (!tool || TOOL_VERBS[tool.toLowerCase()]) return target;
  const name = tool.startsWith('mcp__') ? (tool.split('__').at(-1) ?? tool) : tool;
  return target ? `${name} ${target}` : name;
}

export function elapsedSince(since: string, now: number = Date.now()): number {
  const started = Date.parse(since);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/**
 * A clock, not a sentence: `12s`, `3:04`, `1:02:03`. It sits in a mono line next to a spinner and
 * changes every second, so it has to keep its width and stay short.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
