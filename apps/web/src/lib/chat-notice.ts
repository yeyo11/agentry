/**
 * The messages nobody typed.
 *
 * Claude Code writes a few things into the transcript as if they came from the person: a background
 * task that finished, a reminder the harness injected, the output of a slash command, the note left
 * when a turn was interrupted. They arrive as `user` entries full of tags, and shown as a message
 * they read like the person suddenly speaking XML. Read here into what they actually say, so the
 * page can show them as what they are — something the system said, next to the conversation.
 */

export type NoticeKind = 'task' | 'reminder' | 'command' | 'output' | 'interrupt';

export interface Notice {
  kind: NoticeKind;
  /** The single line the row shows */
  detail: string;
  /** Everything else, kept behind a fold; empty when the line is the whole of it */
  body: string;
  /** How a background task ended (`completed`, `failed`, …) */
  status?: string;
}

const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'g');
const inner = (text: string, name: string): string => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(text)?.[1]?.trim() ?? '';

/** `[Request interrupted by user]`, and the variants the CLI writes around it. */
const INTERRUPT = /^\[Request interrupted[^\]]*\]$/;

function taskNotice(raw: string): Notice {
  const status = inner(raw, 'status');
  const summary = inner(raw, 'summary');
  const file = inner(raw, 'output-file');
  return { kind: 'task', status: status || undefined, detail: summary || inner(raw, 'task-id'), body: file };
}

/**
 * The notices in one message and the prose left around them: a person's message that carries a
 * reminder is still their message, so only what they wrote stays in the bubble.
 */
export function readNotices(text: string): { prose: string; notices: Notice[] } {
  const notices: Notice[] = [];
  let prose = text;
  const take = (name: string, make: (raw: string) => Notice) => {
    prose = prose.replace(TAG(name), (_match, raw: string) => {
      notices.push(make(raw.trim()));
      return '';
    });
  };
  take('task-notification', (raw) => taskNotice(raw));
  take('system-reminder', (raw) => ({ kind: 'reminder', detail: firstLine(raw), body: rest(raw) }));
  take('local-command-stdout', (raw) => ({ kind: 'output', detail: firstLine(raw), body: rest(raw) }));
  // A slash command: its name is the line, its arguments and the message it expanded to are the body
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(prose);
  if (command) {
    const args = inner(prose, 'command-args');
    const message = inner(prose, 'command-message');
    notices.push({ kind: 'command', detail: `${(command[1] ?? '').trim()}${args ? ` ${args}` : ''}`.trim(), body: message });
    prose = prose.replace(/<command-(name|args|message|contents)>[\s\S]*?<\/command-\1>/g, '');
  }
  prose = prose
    .split('\n')
    .filter((line) => {
      if (!INTERRUPT.test(line.trim())) return true;
      notices.push({ kind: 'interrupt', detail: line.trim().replace(/^\[|\]$/g, ''), body: '' });
      return false;
    })
    .join('\n');
  return { prose: prose.trim(), notices };
}

const firstLine = (text: string): string => text.split('\n').find((line) => line.trim())?.trim() ?? '';

const rest = (text: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim());
  return lines.slice(start + 1).join('\n').trim();
};
