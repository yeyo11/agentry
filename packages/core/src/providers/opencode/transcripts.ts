import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  entrySearchText,
  searchPattern,
  TRANSCRIPT_PAGE_MAX,
  TranscriptSearch,
  type ContentBlock,
  type TranscriptEntry,
  type TranscriptSearchResult,
} from '@agentry/shared';
import { encodeProjectId } from '../../workspace.ts';
import type { TranscriptPage, TranscriptSummary } from '../../cli-facts.ts';
import { pageSize } from '../../sessions.ts';
import type { TokenUsage } from '@agentry/shared';
import { addTokenUsage, emptyTokenUsage } from '../../usage.ts';
import { TranscriptUnavailable, type TranscriptStore } from '../transcripts.ts';
import { dbExists, opencodeDbPath, readDb, type SchemaState } from './opencode-db.ts';

type Row = Record<string, unknown>;

const WATCH_DEBOUNCE_MS = 500;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const iso = (ms: unknown): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function parse(data: unknown): Record<string, unknown> {
  if (typeof data !== 'string') return {};
  try {
    const v: unknown = JSON.parse(data);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The text of a tool's result, whatever shape the part keeps it in. */
function resultText(v: unknown): string {
  if (typeof v === 'string') return v;
  return v === undefined || v === null ? '' : JSON.stringify(v);
}

/** One `part` row's `data` as blocks. A type the store does not know shows as text naming it: nothing is dropped. */
export function partBlocks(data: Record<string, unknown>): ContentBlock[] {
  const type = str(data['type']) ?? 'unknown';
  switch (type) {
    case 'text':
      return [{ type: 'text', text: str(data['text']) ?? '' }];
    case 'reasoning':
      return [{ type: 'thinking', text: str(data['text']) ?? '' }];
    case 'tool': {
      const id = str(data['callID']) ?? str(data['id']) ?? '';
      const state = obj(data['state']);
      const blocks: ContentBlock[] = [{ type: 'tool_use', id, name: str(data['tool']) ?? 'tool', input: state['input'] ?? {} }];
      const status = str(state['status']);
      if (status === 'completed') blocks.push({ type: 'tool_result', toolUseId: id, content: resultText(state['output']), isError: false });
      else if (status === 'error') blocks.push({ type: 'tool_result', toolUseId: id, content: resultText(state['error']), isError: true });
      return blocks;
    }
    case 'patch': {
      const id = str(data['id']) ?? str(data['hash']) ?? '';
      return [{ type: 'tool_use', id, name: 'patch', input: { files: Array.isArray(data['files']) ? data['files'] : [] } }];
    }
    case 'file':
      return [{ type: 'document', mediaType: str(data['mime']) ?? 'application/octet-stream', ...(str(data['filename']) ? { name: str(data['filename'])! } : {}) }];
    // bookkeeping parts carry no words of their own: the step's usage is read from the session row
    case 'step-start':
    case 'step-finish':
      return [];
    default:
      return [{ type: 'text', text: `[opencode part: ${type}]` }];
  }
}

function tokenUsage(row: Row): TokenUsage {
  const u = emptyTokenUsage();
  addTokenUsage(u, {
    input: num(row['tokens_input']),
    output: num(row['tokens_output']) + num(row['tokens_reasoning']),
    cacheRead: num(row['tokens_cache_read']),
    cacheCreation: num(row['tokens_cache_write']),
    total: 0,
  });
  return u;
}

/** `providerID/modelID` the way OpenCode shows a model, from a session's `model` column (JSON or plain). */
function modelName(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  if (!s.startsWith('{')) return s;
  const m = parse(s);
  const id = str(m['id']) ?? str(m['modelID']);
  const provider = str(m['providerID']);
  return id ? (provider ? `${provider}/${id}` : id) : null;
}

const SESSION_COLUMNS =
  'id, directory, title, model, cost, time_created, time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write';

function summaryOf(row: Row, messageCount: number, firstPrompt: string | null): TranscriptSummary {
  const directory = str(row['directory']) ?? '';
  const total = tokenUsage(row);
  const model = modelName(row['model']);
  return {
    id: String(row['id']),
    projectId: encodeProjectId(directory),
    projectPath: directory,
    title: str(row['title']) ?? '',
    firstPrompt,
    messageCount,
    startedAt: iso(row['time_created']),
    updatedAt: iso(row['time_updated']),
    model,
    gitBranch: null,
    cliVersion: null,
    sizeBytes: 0,
    usage: {
      context: null,
      tokens: total.total > 0 ? [{ model, ...total }] : [],
      total,
      days: [],
    },
    worktree: null,
  };
}

/** The newest entries of the session as a window, oldest first, the way the Claude store pages. */
function window(entries: TranscriptEntry[], opts: { before?: number; limit?: number }): { from: number; entries: TranscriptEntry[] } {
  const limit = pageSize(opts.limit);
  const end = opts.before === undefined ? entries.length : Math.max(0, Math.min(entries.length, Math.trunc(opts.before)));
  const from = Math.max(0, end - Math.min(limit, TRANSCRIPT_PAGE_MAX));
  return { from, entries: entries.slice(from, end) };
}

/**
 * OpenCode's transcripts, read from its SQLite database. Read-only by construction (see
 * {@link readDb}), and it selects from `session`, `message`, `part`, `session_message`, `project`
 * and `todo` only: `account`, `control_account`, `credential` and `session_share` hold secrets.
 */
export class OpencodeTranscripts implements TranscriptStore {
  private readonly path: string;

  constructor(opts: { env?: NodeJS.ProcessEnv; channel?: string | null; dbPath?: string } = {}) {
    this.path = opts.dbPath ?? opencodeDbPath(opts.env, opts.channel ?? null);
  }

  /** Whether the database holds migrations beyond the pinned set; null when it cannot be read. */
  async schemaState(): Promise<SchemaState | null> {
    if (!dbExists(this.path)) return null;
    try {
      return await readDb(this.path, (_db, schema) => schema);
    } catch (e) {
      if (e instanceof TranscriptUnavailable) return null;
      throw e;
    }
  }

  async list(projectPath?: string): Promise<TranscriptSummary[]> {
    if (!dbExists(this.path)) return [];
    return readDb(this.path, (db) => {
      const rows =
        projectPath === undefined
          ? db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC`).all()
          : db
              .prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE parent_id IS NULL AND time_archived IS NULL AND directory = ? ORDER BY time_updated DESC`)
              .all(projectPath);
      return rows.map((row) => summaryOf(row, this.count(db, String(row['id'])), null));
    });
  }

  async summary(nativeId: string): Promise<TranscriptSummary | null> {
    if (!dbExists(this.path)) return null;
    return readDb(this.path, (db) => {
      const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`).get(nativeId);
      if (!row) return null;
      const first = this.entries(db, nativeId).find((e) => e.role === 'user');
      const text = first?.blocks.find((b) => b.type === 'text');
      return summaryOf(row, this.count(db, nativeId), text?.type === 'text' ? text.text : null);
    });
  }

  async page(nativeId: string, opts: { before?: number; limit?: number } = {}): Promise<TranscriptPage | null> {
    if (!dbExists(this.path)) return null;
    return readDb(this.path, (db) => {
      const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`).get(nativeId);
      if (!row) return null;
      const all = this.entries(db, nativeId);
      const first = all.find((e) => e.role === 'user')?.blocks.find((b) => b.type === 'text');
      const { from, entries } = window(all, opts);
      return { summary: summaryOf(row, all.length, first?.type === 'text' ? first.text : null), entries, from, total: all.length };
    });
  }

  async search(nativeId: string, query: string): Promise<TranscriptSearchResult | null> {
    const pattern = searchPattern(query);
    if (!pattern) throw new Error('q is required');
    if (!dbExists(this.path)) return null;
    return readDb(this.path, (db) => {
      if (!db.prepare('SELECT 1 FROM session WHERE id = ?').get(nativeId)) return null;
      const search = new TranscriptSearch(query, pattern);
      for (const entry of this.entries(db, nativeId)) search.add(entrySearchText(entry));
      return search.result();
    });
  }

  /**
   * Cost and tokens the `session` row keeps, which the usage page reads because ACP reports no cost.
   * Null when the session is not there.
   */
  async cost(nativeId: string): Promise<{ cost: number; tokens: TokenUsage } | null> {
    if (!dbExists(this.path)) return null;
    return readDb(this.path, (db) => {
      const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`).get(nativeId);
      return row ? { cost: num(row['cost']), tokens: tokenUsage(row) } : null;
    });
  }

  /**
   * Calls `listener` (debounced) when the database or its `-wal` changes. Watches the directory, so a
   * database that is created later is noticed, and filters by name.
   */
  watch(listener: () => void): () => void {
    const names = new Set([basename(this.path), `${basename(this.path)}-wal`]);
    let timer: NodeJS.Timeout | null = null;
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(dirname(this.path), (_event, file) => {
        if (file && !names.has(String(file))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          listener();
        }, WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => {});
    } catch {
      // no data directory yet: nothing to watch
    }
    return () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
  }

  private count(db: DatabaseSync, sessionId: string): number {
    const n = (sql: string): number => num(db.prepare(sql).get(sessionId)?.['n']);
    const messages = n('SELECT count(*) AS n FROM message WHERE session_id = ?');
    return messages > 0 ? messages : n('SELECT count(*) AS n FROM session_message WHERE session_id = ?');
  }

  /**
   * The session's entries, oldest first. The `message` + `part` layout when it holds rows for the
   * session, else `session_message`, whose rows each become one entry.
   */
  private entries(db: DatabaseSync, sessionId: string): TranscriptEntry[] {
    const messages = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId);
    if (messages.length > 0) {
      const parts = new Map<string, Row[]>();
      for (const p of db.prepare('SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id').all(sessionId)) {
        const key = String(p['message_id']);
        const list = parts.get(key);
        if (list) list.push(p);
        else parts.set(key, [p]);
      }
      return messages.map((m) => {
        const data = parse(m['data']);
        const model = obj(data['model']);
        const modelId = str(data['modelID']) ?? str(model['modelID']);
        const providerId = str(data['providerID']) ?? str(model['providerID']);
        const blocks = (parts.get(String(m['id'])) ?? []).flatMap((p) => partBlocks(parse(p['data'])));
        return {
          uuid: String(m['id']),
          role: data['role'] === 'user' ? 'user' : 'assistant',
          timestamp: iso(m['time_created']),
          model: modelId ? (providerId ? `${providerId}/${modelId}` : modelId) : null,
          isSidechain: false,
          parentToolUseId: null,
          blocks,
        } satisfies TranscriptEntry;
      });
    }
    return db
      .prepare('SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq')
      .all(sessionId)
      .map((m) => {
        const data = parse(m['data']);
        const type = str(m['type']) ?? 'unknown';
        const text = str(data['text']) ?? str(data['content']);
        return {
          uuid: String(m['id']),
          role: type === 'user' ? 'user' : 'assistant',
          timestamp: iso(m['time_created']),
          model: null,
          isSidechain: false,
          parentToolUseId: null,
          blocks: text !== null ? [{ type: 'text', text }] : [{ type: 'text', text: `[opencode message: ${type}]` }],
        } satisfies TranscriptEntry;
      });
  }
}
