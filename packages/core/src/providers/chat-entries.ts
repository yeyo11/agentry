import { entrySearchText, searchPattern, TRANSCRIPT_PAGE_MAX, TranscriptSearch, entryText, type TranscriptEntry, type TranscriptSearchResult } from '@agentry/shared';
import type { TranscriptPage, TranscriptSummary } from '../cli-facts.ts';
import type { Db } from '../db.ts';
import { pageSize } from '../sessions.ts';
import { emptyTokenUsage } from '../usage.ts';
import { encodeProjectId } from '../workspace.ts';
import type { TranscriptStore } from './transcripts.ts';

/**
 * The transcript of a chat whose provider keeps none Agentry can read: what the chat streamed, as
 * the rows `chat_entries` holds. Keyed by the chat's id, not by a native id, and it lists nothing,
 * because a session the provider ran elsewhere never passed through Agentry.
 */
export class ChatEntriesTranscripts implements TranscriptStore {
  constructor(private readonly db: Pick<Db, 'chatEntries'>) {}

  private entries(chatId: string, includeSidechains = false): TranscriptEntry[] {
    const all = this.db.chatEntries(chatId).map((row) => row.entry as TranscriptEntry);
    return includeSidechains ? all : all.filter((e) => !e.isSidechain);
  }

  async list(): Promise<TranscriptSummary[]> {
    return [];
  }

  async summary(chatId: string): Promise<TranscriptSummary | null> {
    return this.summaryOf(chatId, this.entries(chatId));
  }

  async page(chatId: string, opts: { before?: number; limit?: number; includeSidechains?: boolean } = {}): Promise<TranscriptPage | null> {
    const entries = this.entries(chatId, opts.includeSidechains);
    const summary = this.summaryOf(chatId, entries);
    if (!summary) return null;
    const end = opts.before === undefined || !Number.isFinite(opts.before) ? entries.length : Math.max(0, Math.min(entries.length, Math.trunc(opts.before)));
    const from = Math.max(0, end - Math.min(pageSize(opts.limit), TRANSCRIPT_PAGE_MAX));
    return { summary, entries: entries.slice(from, end), from, total: entries.length };
  }

  async search(chatId: string, query: string, opts: { includeSidechains?: boolean } = {}): Promise<TranscriptSearchResult | null> {
    const pattern = searchPattern(query);
    if (!pattern) throw new Error('q is required');
    const entries = this.entries(chatId, opts.includeSidechains);
    if (entries.length === 0) return null;
    const search = new TranscriptSearch(query, pattern);
    for (const entry of entries) search.add(entrySearchText(entry));
    return search.result();
  }

  private summaryOf(chatId: string, entries: TranscriptEntry[]): TranscriptSummary | null {
    const first = entries[0];
    if (!first) return null;
    const firstPrompt = entries.filter((e) => e.role === 'user').map((e) => entryText(e)).find((t) => t.length > 0) ?? null;
    return {
      id: chatId,
      projectId: encodeProjectId(''),
      projectPath: '',
      title: firstPrompt ?? chatId,
      firstPrompt,
      messageCount: entries.length,
      startedAt: first.timestamp,
      updatedAt: entries.at(-1)?.timestamp ?? null,
      model: [...entries].reverse().find((e) => e.model)?.model ?? null,
      gitBranch: null,
      cliVersion: null,
      sizeBytes: 0,
      usage: { context: null, tokens: [], total: emptyTokenUsage(), days: [] },
      worktree: null,
    };
  }
}
