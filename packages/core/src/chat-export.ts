import type { Chat, ContentBlock, ExportFormat, TranscriptEntry } from '@agentry/shared';

/** A tool result longer than this is cut in the Markdown, which is for reading; the JSON export keeps it whole. */
const RESULT_LIMIT = 4_000;
/** The longest a tool call's one-line summary gets. */
const SUMMARY_LIMIT = 90;

/** A fence longer than any run of backticks inside, so the content cannot close it early. */
function fence(text: string, lang = ''): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** What a tool call is about, in a line: the command, the file, the pattern, whatever the input leads with. */
function subject(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const fields = input as Record<string, unknown>;
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value, SUMMARY_LIMIT);
  }
  const first = Object.values(fields).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return first ? oneLine(first, SUMMARY_LIMIT) : '';
}

function stringify(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
const count = (n: number): string => n.toLocaleString('en-US');

function header(chat: Chat, entries: TranscriptEntry[], hidden: number): string {
  const lines: string[] = [`# ${oneLine(chat.title || chat.id, 200)}`, ''];
  const fact = (label: string, value: string | null): void => {
    if (value) lines.push(`- **${label}:** ${value}`);
  };
  fact('Chat', `\`${chat.id}\``);
  fact('Project', chat.project?.name ?? null);
  fact('Directory', `\`${chat.cwd}\``);
  const models = chat.cost.tokens.map((t) => t.model).filter((m): m is string => m !== null);
  fact('Model', models.length ? models.map((m) => `\`${m}\``).join(', ') : chat.model ? `\`${chat.model}\`` : null);
  fact('Started', chat.startedAt);
  fact('Last activity', chat.updatedAt);
  // The CLI's own figure, or none: a chat started from a terminal has no cost to show and none is worked out
  fact('Cost', chat.cost.usd !== null ? `${usd(chat.cost.usd)} (as reported by the CLI)` : 'not reported: the CLI only reports a cost for chats Agentry started');
  const total = chat.cost.total;
  if (total.total > 0) {
    fact('Tokens', `${count(total.total)} (${count(total.input)} input, ${count(total.output)} output, ${count(total.cacheRead)} cache read, ${count(total.cacheCreation)} cache write)`);
  }
  fact('Messages', `${count(entries.length)}${hidden ? `, and ${count(hidden)} more from subagents, left out here (the JSON export has them)` : ''}`);
  lines.push('');
  return lines.join('\n');
}

const speaker = (entry: TranscriptEntry): string => (entry.role === 'user' ? 'User' : entry.model ? `Assistant (${entry.model})` : 'Assistant');

/**
 * A chat as Markdown a person can read: the header says what it cost and which models answered,
 * then the conversation in turns, with every tool call folded into a `<details>` block that holds
 * the call and its result. Subagent messages are left out; the JSON export keeps every event.
 */
export function chatToMarkdown(chat: Chat, entries: TranscriptEntry[]): string {
  const main = entries.filter((e) => !e.isSidechain);
  const results = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>();
  const called = new Set<string>();
  for (const entry of main) {
    for (const block of entry.blocks) {
      if (block.type === 'tool_result') results.set(block.toolUseId, block);
      else if (block.type === 'tool_use') called.add(block.id);
    }
  }

  const renderResult = (result: Extract<ContentBlock, { type: 'tool_result' }>): string => {
    const cut = result.content.length > RESULT_LIMIT;
    const shown = cut ? `${result.content.slice(0, RESULT_LIMIT)}\n… ${count(result.content.length - RESULT_LIMIT)} more characters, cut here` : result.content;
    return fence(shown || '(empty)');
  };

  const out: string[] = [header(chat, main, entries.length - main.length)];
  let previous = '';
  for (const entry of main) {
    const parts: string[] = [];
    for (const block of entry.blocks) {
      switch (block.type) {
        case 'text':
          if (block.text.trim()) parts.push(block.text.trim());
          break;
        case 'thinking':
          if (block.text.trim()) parts.push(details('Thinking', block.text.trim()));
          break;
        case 'image':
        case 'document':
          parts.push(`_[${block.type}: ${block.name ?? block.mediaType}]_`);
          break;
        case 'tool_use': {
          const result = results.get(block.id);
          const about = subject(block.input);
          const label = `Tool: <code>${escapeHtml(block.name)}</code>${about ? ` — ${escapeHtml(about)}` : ''}${result?.isError ? ' (failed)' : ''}`;
          const body = [`**Input**\n\n${fence(stringify(block.input), 'json')}`];
          if (result) body.push(`**Result**\n\n${renderResult(result)}`);
          parts.push(details(label, body.join('\n\n')));
          break;
        }
        case 'tool_result':
          // Shown with its call; one whose call is not in the conversation has nowhere else to be
          if (!called.has(block.toolUseId)) parts.push(details(`Tool result${block.isError ? ' (failed)' : ''}`, renderResult(block)));
          break;
      }
    }
    if (!parts.length) continue;
    // The CLI writes one entry per content block: a turn is the run of them by the same speaker
    const who = speaker(entry);
    const heading = who === previous ? '' : `## ${who}${entry.timestamp ? ` · ${entry.timestamp}` : ''}\n\n`;
    previous = who;
    out.push(`${heading}${parts.join('\n\n')}`);
  }
  return `${out.join('\n\n')}\n`;
}

/** A name for the downloaded file: the title in a form any file system takes, and the start of the id so two chats never share one. */
export function exportFilename(chat: Pick<Chat, 'id' | 'title'>, format: ExportFormat): string {
  const slug = chat.title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 50)
    .replace(/-+$/, '');
  return `${slug || 'chat'}-${chat.id.slice(0, 8)}.${format === 'markdown' ? 'md' : 'json'}`;
}
