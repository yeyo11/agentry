import type { TranscriptSearchResult } from '@agentry/shared';
import type { TranscriptPage, TranscriptSummary } from '../cli-facts.ts';
import type { SessionStore } from '../sessions.ts';
import { encodeProjectId } from '../workspace.ts';

/** A read that cannot answer yet, and why; a caller shows the reason and never an empty session. */
export type TranscriptUnknown = 'busy' | 'schema-untested';

/**
 * Reads what one provider wrote about its sessions, by the agent's own session id. `null` means
 * there is no such session; a store that cannot tell right now throws {@link TranscriptUnavailable}.
 */
export interface TranscriptStore {
  /** Sessions the provider holds, newest first; those run in `projectPath` when given */
  list(projectPath?: string): Promise<TranscriptSummary[]>;
  summary(nativeId: string): Promise<TranscriptSummary | null>;
  /** The newest `limit` entries, or the ones just before `before` (an index from a previous page) */
  page(nativeId: string, opts?: { before?: number; limit?: number; includeSidechains?: boolean }): Promise<TranscriptPage | null>;
  /** Entries of the whole session whose text contains `query` */
  search(nativeId: string, query: string, opts?: { includeSidechains?: boolean }): Promise<TranscriptSearchResult | null>;
  /**
   * Calls `listener` when the provider's sessions changed under this store, and returns how to stop.
   * A store whose changes the app already learns of another way leaves it out.
   */
  watch?(listener: () => void): () => void;
}

/** The store cannot read at this moment; `reason` says why and whether to try again. */
export class TranscriptUnavailable extends Error {
  constructor(readonly reason: TranscriptUnknown) {
    super(`transcripts unavailable: ${reason}`);
    this.name = 'TranscriptUnavailable';
  }
}

/**
 * Claude Code's JSONL transcripts behind the interface. For Claude the native id is the session
 * id Agentry imposes, so every call passes straight to {@link SessionStore}, which stays as it is.
 */
export class SessionStoreTranscripts implements TranscriptStore {
  constructor(private readonly sessions: SessionStore) {}

  list(projectPath?: string): Promise<TranscriptSummary[]> {
    return this.sessions.listSessions(projectPath === undefined ? undefined : encodeProjectId(projectPath));
  }

  summary(nativeId: string): Promise<TranscriptSummary | null> {
    return this.sessions.summary(nativeId);
  }

  page(nativeId: string, opts: { before?: number; limit?: number; includeSidechains?: boolean } = {}): Promise<TranscriptPage | null> {
    return this.sessions.getSession(nativeId, opts);
  }

  search(nativeId: string, query: string, opts: { includeSidechains?: boolean } = {}): Promise<TranscriptSearchResult | null> {
    return this.sessions.searchSession(nativeId, query, opts);
  }
}
