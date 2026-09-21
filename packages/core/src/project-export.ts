import type { ChatExport, ChatOrigin, ChatSummary, ExportFormat, Project, TokenUsage } from '@agentry/shared';
import { chatToMarkdown, count, oneLine, slugOf, usd } from './chat-export.ts';
import { emptyTokenUsage } from './usage.ts';

/**
 * The chats a project export holds. Housekeeping chats are left out: they are Agentry's own
 * errands (a title, a summary), not work done in the project, and most have no transcript.
 */
export const EXPORTED_ORIGINS: readonly ChatOrigin[] = ['agentry', 'external', 'orchestration'];

/**
 * What a project export is made of. The chats are listed up front, because the header needs their
 * dates, models and costs; their transcripts are read one at a time by `load` while the export is
 * written, so a project of hundreds of chats never holds more than one transcript in memory.
 */
export interface ProjectExportSource {
  exportedAt: string;
  project: Project;
  /** Oldest first: a project reads as the story of its chats */
  chats: ChatSummary[];
  load: (chatId: string) => Promise<ChatExport>;
}

const startOf = (chat: ChatSummary): string => chat.startedAt ?? chat.updatedAt ?? '';

/** Oldest first; a chat with no dates at all goes last, where it disturbs nothing. */
export function byStart(a: ChatSummary, b: ChatSummary): number {
  const x = startOf(a);
  const y = startOf(b);
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  return x.localeCompare(y) || a.id.localeCompare(b.id);
}

function addTokens(into: TokenUsage, more: TokenUsage): void {
  into.input += more.input;
  into.output += more.output;
  into.cacheRead += more.cacheRead;
  into.cacheCreation += more.cacheCreation;
  into.total += more.total;
}

function projectHeader(source: ProjectExportSource): string {
  const { project, chats } = source;
  const lines: string[] = [`# ${oneLine(project.name || project.id, 200)}`, ''];
  const fact = (label: string, value: string): void => {
    lines.push(`- **${label}:** ${value}`);
  };
  fact('Project', `\`${project.id}\``);
  fact('Directory', `\`${project.path}\``);
  fact('Exported', source.exportedAt);

  const starts = chats.map(startOf).filter(Boolean).sort();
  const ends = chats.map((c) => c.updatedAt ?? c.startedAt ?? '').filter(Boolean).sort();
  if (starts.length) fact('Range', `${starts[0]} to ${ends[ends.length - 1] ?? starts[starts.length - 1]}`);
  fact('Chats', count(chats.length));

  const models = new Set<string>();
  for (const chat of chats) {
    const named = chat.cost.tokens.map((t) => t.model).filter((m): m is string => m !== null);
    for (const model of named.length ? named : chat.model ? [chat.model] : []) models.add(model);
  }
  if (models.size) fact('Models', [...models].sort().map((m) => `\`${m}\``).join(', '));

  // The CLI's own figures summed, never a price worked out from tokens: a chat started from a
  // terminal reported none, and the header says how many of those there are instead
  const reported = chats.filter((c) => c.cost.usd !== null);
  const unreported = chats.length - reported.length;
  const spent = reported.reduce((sum, c) => sum + (c.cost.usd ?? 0), 0);
  const without = unreported ? `; ${count(unreported)} ${unreported === 1 ? 'chat' : 'chats'} started outside Agentry reported none and ${unreported === 1 ? 'is' : 'are'} not in it` : '';
  fact('Cost', reported.length ? `${usd(spent)} (as reported by the CLI${without})` : 'not reported: the CLI only reports a cost for chats Agentry started');

  const tokens = emptyTokenUsage();
  for (const chat of chats) addTokens(tokens, chat.cost.total);
  if (tokens.total > 0) {
    fact('Tokens', `${count(tokens.total)} (${count(tokens.input)} input, ${count(tokens.output)} output, ${count(tokens.cacheRead)} cache read, ${count(tokens.cacheCreation)} cache write)`);
  }

  if (chats.length) {
    lines.push('', '## Chats', '');
    chats.forEach((chat, i) => {
      const cost = chat.cost.usd !== null ? ` · ${usd(chat.cost.usd)}` : '';
      lines.push(`${i + 1}. ${oneLine(chat.title || chat.id, 120)} · \`${chat.id}\`${chat.startedAt ? ` · ${chat.startedAt}` : ''}${cost}`);
    });
  }
  lines.push('');
  return lines.join('\n');
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A project as Markdown, one piece at a time: a header with the project, the dates its chats span,
 * the models that answered and what the CLI reported they cost, then every chat as a section
 * rendered the way a single chat's export is. A chat that went away between the listing and its
 * turn is named in its place, so the list in the header still matches the sections.
 */
export async function* projectToMarkdown(source: ProjectExportSource): AsyncGenerator<string> {
  yield `${projectHeader(source)}\n`;
  for (const chat of source.chats) {
    let section: string;
    try {
      const exported = await source.load(chat.id);
      section = chatToMarkdown(exported.chat, exported.entries, { depth: 2 });
    } catch (err) {
      section = `## ${oneLine(chat.title || chat.id, 200)}\n\n_The chat \`${chat.id}\` could not be read: ${oneLine(reason(err), 200)}._\n`;
    }
    yield `---\n\n${section}\n`;
  }
}

/**
 * A project as a {@link ProjectExport}, written as JSON one chat at a time. A chat that went away
 * between the listing and its turn is left out: JSON has no place for a note, and every chat that
 * is there is whole.
 */
export async function* projectToJson(source: ProjectExportSource): AsyncGenerator<string> {
  yield `{"exportedAt":${JSON.stringify(source.exportedAt)},"project":${JSON.stringify(source.project)},"chats":[`;
  let first = true;
  for (const chat of source.chats) {
    let exported: ChatExport;
    try {
      exported = await source.load(chat.id);
    } catch {
      continue;
    }
    yield `${first ? '' : ','}${JSON.stringify(exported)}`;
    first = false;
  }
  yield ']}\n';
}

/** A name for the downloaded file, with the start of the id so two projects of the same name never share one. */
export function projectExportFilename(project: Pick<Project, 'id' | 'name'>, format: ExportFormat): string {
  return `${slugOf(project.name, 'project')}-${project.id.slice(0, 8)}.${format === 'markdown' ? 'md' : 'json'}`;
}
