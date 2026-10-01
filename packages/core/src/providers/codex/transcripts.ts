import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  entrySearchText,
  searchPattern,
  TRANSCRIPT_PAGE_MAX,
  TranscriptSearch,
  type ContentBlock,
  type TranscriptEntry,
  type TranscriptSearchResult,
} from '@agentry/shared';
import type { TranscriptPage, TranscriptSummary } from '../../cli-facts.ts';
import { pageSize } from '../../sessions.ts';
import { emptyTokenUsage } from '../../usage.ts';
import { encodeProjectId } from '../../workspace.ts';
import { TranscriptUnavailable, type TranscriptStore } from '../transcripts.ts';
import { codexManifest } from './manifest.ts';
import type { ThreadItem } from './protocol/types.ts';
import { JsonRpc, RpcError } from './rpc.ts';

/** How long the reader process outlives its last call: a list and a page in a row share one. */
const IDLE_MS = 60_000;
/** Pages of threads and items read before the rest is left: a runaway cursor must not loop forever. */
const MAX_PAGES = 50;
const LIST_LIMIT = 100;
const ITEMS_LIMIT = 200;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const secondsIso = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null);
const millisIso = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : null);

function jsonText(v: unknown): string {
  if (typeof v === 'string') return v;
  return v === undefined || v === null ? '' : JSON.stringify(v);
}

/** What a person's input holds as text; an attachment shows as its kind, because nothing is dropped. */
function inputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = rec(part);
      return p['type'] === 'text' ? (str(p['text']) ?? '') : `[${str(p['type']) ?? 'input'}]`;
    })
    .join('\n');
}

/**
 * One thread item as transcript entries, the way the live path shows the same item: a call is the
 * assistant's `tool_use` and the user's `tool_result`. A type this driver does not know shows as
 * text naming it.
 */
export function itemEntries(item: ThreadItem, at: string | null, model: string | null): TranscriptEntry[] {
  const raw = rec(item);
  const id = str(raw['id']) ?? '';
  const make = (suffix: string, role: TranscriptEntry['role'], blocks: ContentBlock[]): TranscriptEntry => ({
    uuid: `${id}${suffix}`,
    role,
    timestamp: at,
    model: role === 'assistant' ? model : null,
    isSidechain: false,
    parentToolUseId: null,
    blocks,
  });
  const call = (name: string, input: unknown, output: string, isError: boolean): TranscriptEntry[] => [
    make('', 'assistant', [{ type: 'tool_use', id, name, input: input ?? {} }]),
    make(':result', 'user', [{ type: 'tool_result', toolUseId: id, content: output, isError }]),
  ];
  switch (raw['type']) {
    case 'userMessage':
      return [make('', 'user', [{ type: 'text', text: inputText(raw['content']) }])];
    case 'agentMessage':
    case 'plan':
      return [make('', 'assistant', [{ type: 'text', text: str(raw['text']) ?? '' }])];
    case 'reasoning': {
      const parts = [raw['summary'], raw['content']].flatMap((list) => (Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []));
      return [make('', 'assistant', [{ type: 'thinking', text: parts.join('\n\n') }])];
    }
    case 'commandExecution': {
      const failed = raw['status'] !== 'completed' || (typeof raw['exitCode'] === 'number' && raw['exitCode'] !== 0);
      return call('Bash', { command: str(raw['command']) ?? '' }, str(raw['aggregatedOutput']) ?? (raw['status'] === 'declined' ? 'declined' : ''), failed);
    }
    case 'fileChange': {
      const changes = Array.isArray(raw['changes']) ? raw['changes'].map(rec) : [];
      const failed = raw['status'] !== 'completed';
      const ids = changes.map((_, index) => (changes.length === 1 ? id : `${id}#${index}`));
      return [
        make(
          '',
          'assistant',
          changes.map((c, index): ContentBlock => ({ type: 'tool_use', id: ids[index] ?? id, name: 'Edit', input: { file_path: str(c['path']) ?? '', change: str(rec(c['kind'])['type']) ?? '', diff: str(c['diff']) ?? '' } })),
        ),
        make(
          ':result',
          'user',
          ids.map((toolUseId): ContentBlock => ({ type: 'tool_result', toolUseId, content: failed ? (str(raw['status']) ?? 'failed') : 'applied', isError: failed })),
        ),
      ];
    }
    case 'mcpToolCall': {
      const failed = raw['status'] === 'failed' || (raw['error'] !== null && raw['error'] !== undefined);
      return call(`mcp__${str(raw['server']) ?? ''}__${str(raw['tool']) ?? ''}`, raw['arguments'], jsonText(raw['error'] ?? raw['result']), failed);
    }
    case 'dynamicToolCall':
      return call(str(raw['tool']) ?? 'tool', raw['arguments'], jsonText(raw['contentItems']), raw['success'] === false);
    case 'collabAgentToolCall':
      return call(`agent:${str(raw['tool']) ?? 'call'}`, { prompt: str(raw['prompt']) }, jsonText(raw['agentsStates']), raw['status'] === 'failed');
    default:
      return [make('', 'assistant', [{ type: 'text', text: `[codex item: ${str(raw['type']) ?? 'unknown'}]` }])];
  }
}

export interface CodexTranscriptsOptions {
  /** The executable, its arguments (up to and including `app-server`) and its environment */
  bin?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** A reader process, and the handshake that has to finish before its first call. */
interface Reader {
  proc: ChildProcessWithoutNullStreams;
  rpc: JsonRpc;
  ready: Promise<void>;
  idle: NodeJS.Timeout | null;
}

/**
 * Codex's history, read through `codex app-server` itself (`thread/list`, `thread/read`,
 * `thread/items/list`): the vendor's versioned surface, not the rollout files, whose format is
 * internal. A reader process starts on the first call and ends a minute after the last one.
 */
export class CodexTranscripts implements TranscriptStore {
  private reader: Reader | null = null;

  constructor(private readonly opts: CodexTranscriptsOptions = {}) {}

  /** Ends the reader process; the next call starts another. */
  dispose(): void {
    const reader = this.reader;
    this.reader = null;
    if (!reader) return;
    if (reader.idle) clearTimeout(reader.idle);
    reader.proc.stdin.end();
    reader.proc.kill('SIGTERM');
  }

  private start(): Reader {
    const bin = this.opts.bin ?? codexManifest.commands.names[0] ?? 'codex';
    const args = this.opts.args ?? codexManifest.launch?.args ?? ['app-server'];
    const proc = spawn(bin, [...args], { env: { ...process.env, ...codexManifest.launch?.env, ...this.opts.env }, stdio: 'pipe' });
    const rpc = new JsonRpc((line) => proc.stdin.write(line), {
      request: (id) => rpc.fail(id, -32601, 'Agentry answers no requests while reading history'),
      notification: () => {},
      unreadable: () => {},
    });
    createInterface({ input: proc.stdout }).on('line', (line) => rpc.line(line));
    proc.stdin.on('error', () => {});
    proc.stderr.resume();
    let spawnError: Error | null = null;
    proc.on('error', (error) => {
      spawnError = error;
      rpc.dispose(error.message);
    });
    proc.on('exit', () => {
      rpc.dispose('codex exited');
      if (this.reader?.proc === proc) this.reader = null;
    });
    const ready = (async () => {
      await rpc.request('initialize', { clientInfo: { name: 'agentry', title: 'Agentry', version: '0.0.0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
      rpc.notify('initialized');
    })().catch((error: unknown) => {
      throw spawnError ?? error;
    });
    // A failed start must not leave the next call waiting on it
    ready.catch(() => {
      if (this.reader?.proc === proc) this.dispose();
    });
    return { proc, rpc, ready, idle: null };
  }

  /**
   * One call on the reader. Codex not being installed reads as nothing to list (`undefined`); a
   * thread it does not know is `null`; any other failure is "try again", never an empty session.
   */
  private async call<T>(method: string, params: Rec): Promise<T | null | undefined> {
    const reader = (this.reader ??= this.start());
    if (reader.idle) clearTimeout(reader.idle);
    reader.idle = null;
    try {
      await reader.ready;
      return await reader.rpc.request<T>(method, params);
    } catch (error) {
      if (error instanceof RpcError) return null;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new TranscriptUnavailable('busy');
    } finally {
      if (this.reader === reader) {
        reader.idle = setTimeout(() => this.dispose(), IDLE_MS);
        reader.idle.unref();
      }
    }
  }

  async list(projectPath?: string): Promise<TranscriptSummary[]> {
    const out: TranscriptSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply: Rec | null | undefined = await this.call<Rec>('thread/list', { limit: LIST_LIMIT, ...(cursor ? { cursor } : {}), ...(projectPath === undefined ? {} : { cwd: projectPath }) });
      if (!reply) break;
      const data = Array.isArray(reply['data']) ? reply['data'] : [];
      for (const thread of data) out.push(summaryOf(rec(thread), 0));
      cursor = str(reply['nextCursor']);
      if (!cursor) break;
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  async summary(nativeId: string): Promise<TranscriptSummary | null> {
    const found = await this.thread(nativeId);
    return found ? summaryOf(found.thread, found.entries.length) : null;
  }

  async page(nativeId: string, opts: { before?: number; limit?: number } = {}): Promise<TranscriptPage | null> {
    const found = await this.thread(nativeId);
    if (!found) return null;
    const { entries } = found;
    const end = opts.before === undefined ? entries.length : Math.max(0, Math.min(entries.length, Math.trunc(opts.before)));
    const from = Math.max(0, end - Math.min(pageSize(opts.limit), TRANSCRIPT_PAGE_MAX));
    return { summary: summaryOf(found.thread, entries.length), entries: entries.slice(from, end), from, total: entries.length };
  }

  async search(nativeId: string, query: string): Promise<TranscriptSearchResult | null> {
    const pattern = searchPattern(query);
    if (!pattern) throw new Error('q is required');
    const found = await this.thread(nativeId);
    if (!found) return null;
    const search = new TranscriptSearch(query, pattern);
    for (const entry of found.entries) search.add(entrySearchText(entry));
    return search.result();
  }

  /** The thread and every item of it as entries, oldest first; null when Codex does not know it. */
  private async thread(nativeId: string): Promise<{ thread: Rec; entries: TranscriptEntry[] } | null> {
    const read = await this.call<Rec>('thread/read', { threadId: nativeId, includeTurns: false });
    if (!read) return null;
    const thread = rec(read['thread']);
    const model = str(thread['model']);
    const fallback = secondsIso(thread['createdAt']);
    const entries: TranscriptEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply: Rec | null | undefined = await this.call<Rec>('thread/items/list', { threadId: nativeId, limit: ITEMS_LIMIT, ...(cursor ? { cursor } : {}) });
      if (!reply) break;
      for (const raw of Array.isArray(reply['data']) ? reply['data'] : []) {
        const entry = rec(raw);
        entries.push(...itemEntries(rec(entry['item']) as unknown as ThreadItem, millisIso(entry['completedAtMs']) ?? millisIso(entry['startedAtMs']) ?? fallback, model));
      }
      cursor = str(reply['nextCursor']);
      if (!cursor) break;
    }
    return { thread, entries };
  }
}

function summaryOf(thread: Rec, messageCount: number): TranscriptSummary {
  const cwd = str(thread['cwd']) ?? '';
  const preview = str(thread['preview']);
  const model = str(thread['model']);
  return {
    id: str(thread['id']) ?? '',
    projectId: encodeProjectId(cwd),
    projectPath: cwd,
    title: str(thread['name']) ?? preview ?? '',
    firstPrompt: preview || null,
    messageCount,
    startedAt: secondsIso(thread['createdAt']),
    updatedAt: secondsIso(thread['updatedAt']),
    model,
    gitBranch: str(rec(thread['gitInfo'])['branch']),
    cliVersion: str(thread['cliVersion']),
    sizeBytes: 0,
    usage: { context: null, tokens: [], total: emptyTokenUsage(), days: [] },
    worktree: null,
  };
}
