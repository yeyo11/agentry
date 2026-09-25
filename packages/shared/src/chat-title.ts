import type { ChatSummary } from './types.ts';

/**
 * The title a person reads: the first prompt. A chat Agentry starts is named `<dir>-<id prefix>` for
 * the CLI's `--name`, which the transcript then reports as its title; that name is an id, not a
 * title, so the prompt wins over it. A name someone chose is kept.
 */
export function displayTitle(chat: Pick<ChatSummary, 'id' | 'title'> & { firstPrompt?: string | null }): string {
  const firstLine = chat.firstPrompt?.split('\n')[0]?.trim() ?? '';
  const generated = chat.title === chat.id || chat.title.endsWith(`-${chat.id.slice(0, 6)}`);
  return generated && firstLine ? firstLine.slice(0, 100) : chat.title;
}
