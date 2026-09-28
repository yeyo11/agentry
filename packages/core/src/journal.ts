import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  type AgentryEvent,
  type CreateJournalEntryRequest,
  type JournalEntry,
  type JournalEntryKind,
  type JournalPage,
  type WorkItemActor,
  type WorkItemRef,
  type WorkItemSource,
} from '@agentry/shared';
import type { Db } from './db.ts';
import { DocumentPathError, pathSegments } from './document-paths.ts';
import type { AgentryEventInput } from './events.ts';
import { actorOf } from './work-item-rows.ts';
import { PERSON, WorkItemError } from './work-item-validation.ts';

/**
 * A project's journal: Agentry's own record of the decisions taken and the items closed, beside the
 * CLI's memory (docs/plans/project-ecosystem.md, decision 32). Rows in the shared database, newest
 * first when read, and handed to every flow run with `--append-system-prompt` through
 * {@link JournalService.handoff}.
 *
 * Three things write it: an item reaching `done` (once per item, whoever moved it), a memory
 * proposal addressed to the journal once a person approves it, and a person by hand. Every entry
 * records who wrote it and, when it needed one, who approved it.
 */

/**
 * What a flow run is handed at most. The journal travels as one argument of `claude`, which Linux
 * caps at 128 KiB, and it is read by every run on top of the role's own prompt: a few thousand
 * tokens of the newest entries is what a member needs to know what was decided, not the whole story.
 */
export const JOURNAL_HANDOFF_BYTES = 16 * 1024;
/** An entry that could not be handed whole is a document, and belongs in the documents folder */
export const JOURNAL_ENTRY_MAX = 8_000;
export const JOURNAL_PAGE_DEFAULT = 50;
export const JOURNAL_PAGE_MAX = 200;

export interface JournalServiceDeps {
  db: Db;
  /** Told of every change once it is committed */
  emit?: (event: AgentryEventInput) => void;
  /** An item as an entry's chip shows it; null once it is gone */
  item?: (itemId: string) => WorkItemRef | null;
  /** The chats and orchestration tasks that worked on an item, for its `closed` entry */
  sources?: (itemId: string) => WorkItemSource[];
}

/** What {@link JournalService.handoff} hands a flow run: the prompt text and what it holds. */
export interface JournalHandoff {
  /** Empty when the journal is */
  text: string;
  entries: number;
  bytes: number;
}

/** What Agentry itself writes, beside the kinds a person may. */
export interface JournalWrite {
  kind: JournalEntryKind;
  text: string;
  itemId?: string | null;
  author: WorkItemActor;
  approvedBy?: WorkItemActor | null;
  proposalId?: string | null;
  documentPath?: string | null;
  sources?: WorkItemSource[];
}

interface EntryRow {
  seq: number;
  id: string;
  project_id: string;
  kind: string;
  text: string;
  item_id: string | null;
  author_kind: string;
  author_role: string | null;
  approved_by_kind: string | null;
  approved_by_role: string | null;
  proposal_id: string | null;
  document_path: string | null;
  sources: string;
  created_at: string;
}

const KINDS: Record<JournalEntryKind, true> = { closed: true, decision: true, memory: true, note: true };

export class JournalService {
  private readonly sql: DatabaseSync;

  constructor(private readonly deps: JournalServiceDeps) {
    this.sql = deps.db.connection;
  }

  // ---------- reading ----------

  /** Newest first. `before` is the `nextBefore` of the page read last. */
  page(projectId: string, query: { limit?: unknown; before?: unknown } = {}): JournalPage {
    const limit = pageLimit(query.limit);
    const before = cursor(query.before);
    const params: SQLInputValue[] = [projectId];
    if (before !== null) params.push(before);
    // One more than asked, to know whether another page follows without counting again
    const rows = this.sql
      .prepare(`SELECT * FROM journal_entries WHERE project_id = ?${before !== null ? ' AND seq < ?' : ''} ORDER BY seq DESC LIMIT ${String(limit + 1)}`)
      .all(...params) as unknown as EntryRow[];
    const shown = rows.slice(0, limit);
    const total = (this.sql.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE project_id = ?').get(projectId) as { n: number }).n;
    const handoff = this.handoff(projectId);
    const last = shown.at(-1);
    return {
      entries: shown.map((r) => this.entryOf(r)),
      total,
      handed: { entries: handoff.entries, bytes: handoff.bytes },
      nextBefore: rows.length > limit && last ? String(last.seq) : null,
    };
  }

  find(entryId: string): JournalEntry | null {
    const row = this.sql.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId) as EntryRow | undefined;
    return row ? this.entryOf(row) : null;
  }

  /**
   * What a flow run is handed: the newest entries that fit {@link JOURNAL_HANDOFF_BYTES}, newest
   * first. It stops at the first entry that does not fit rather than skipping it, so what a run
   * reads is always the recent story without a hole in it.
   */
  handoff(projectId: string): JournalHandoff {
    const header =
      "# Project journal\n\nAgentry's record of this project: decisions taken and work items closed, newest first. The whole team shares it. Do not edit it: propose what the team should remember in your result's `memoryProposals`.\n";
    const lines: string[] = [];
    let bytes = Buffer.byteLength(header);
    // No entry renders under 16 bytes, so no more than this many can ever fit the cap
    const most = Math.ceil(JOURNAL_HANDOFF_BYTES / 16);
    const rows = this.sql.prepare(`SELECT * FROM journal_entries WHERE project_id = ? ORDER BY seq DESC LIMIT ${String(most)}`).all(projectId) as unknown as EntryRow[];
    for (const row of rows) {
      const line = this.render(this.entryOf(row));
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > JOURNAL_HANDOFF_BYTES) break;
      bytes += size;
      lines.push(line);
    }
    if (!lines.length) return { text: '', entries: 0, bytes: 0 };
    return { text: `${header}\n${lines.join('\n')}\n`, entries: lines.length, bytes };
  }

  // ---------- writing ----------

  /** An entry a person writes by hand: a decision or a note. */
  create(projectId: string, input: CreateJournalEntryRequest): JournalEntry {
    const body = input as Partial<CreateJournalEntryRequest> | undefined;
    const kind = body?.kind ?? 'note';
    if (kind !== 'decision' && kind !== 'note') throw new WorkItemError('kind must be one of decision, note: closed and memory entries are written by Agentry', 400);
    const itemId = body?.itemId ?? null;
    if (itemId !== null) {
      if (typeof itemId !== 'string') throw new WorkItemError('itemId must be text', 400);
      const item = this.deps.item?.(itemId);
      if (this.deps.item && !item) throw new WorkItemError('work item not found', 404);
    }
    return this.add(projectId, { kind, text: entryText(body?.text), itemId, author: PERSON, documentPath: documentPath(body?.documentPath) });
  }

  /** Any entry, as Agentry writes it: the checks on the text and the path still hold. */
  add(projectId: string, input: JournalWrite): JournalEntry {
    if (!KINDS[input.kind]) throw new WorkItemError(`unknown journal entry kind: ${String(input.kind)}`, 400);
    const id = randomUUID();
    this.insert(id, projectId, { ...input, text: entryText(input.text), documentPath: documentPath(input.documentPath) }, false);
    const entry = this.find(id);
    if (!entry) throw new Error('the journal entry was not persisted');
    this.announce(entry, 'added');
    return entry;
  }

  /**
   * The entry of an item that reached `done`, written once per item: closing it again after it was
   * reopened keeps the first. Null when it already had one.
   */
  recordClosed(itemId: string, approvedBy: WorkItemActor): JournalEntry | null {
    const row = this.sql.prepare('SELECT project_id, title FROM work_items WHERE id = ?').get(itemId) as { project_id: string; title: string } | undefined;
    if (!row) return null;
    const id = randomUUID();
    const written = this.insert(
      id,
      row.project_id,
      { kind: 'closed', text: row.title, itemId, author: { kind: 'system', role: null }, approvedBy, sources: this.deps.sources?.(itemId) ?? [] },
      true,
    );
    if (!written) return null;
    const entry = this.find(id);
    if (entry) this.announce(entry, 'added');
    return entry;
  }

  remove(entryId: string): JournalEntry {
    const entry = this.find(entryId);
    if (!entry) throw new WorkItemError('journal entry not found', 404);
    this.sql.prepare('DELETE FROM journal_entries WHERE id = ?').run(entryId);
    this.announce(entry, 'removed');
    return entry;
  }

  /**
   * Hears the feed for items reaching `done`. Whoever moved it is who approved it: under the flow
   * only a person does (decision 29); an orchestration node that completes can too, and says so.
   */
  observe(event: AgentryEvent): void {
    if (event.type !== 'workitem.moved' || event.status !== 'done' || event.previousStatus === 'done') return;
    try {
      this.recordClosed(event.itemId, event.actor);
    } catch {
      // The move already happened; a journal that could not be written must not undo it or break the feed
    }
  }

  // ---------- rows ----------

  /** False when `ignoreDuplicate` swallowed a second `closed` entry for the same item. */
  private insert(id: string, projectId: string, input: JournalWrite, ignoreDuplicate: boolean): boolean {
    const result = this.sql
      .prepare(
        `INSERT ${ignoreDuplicate ? 'OR IGNORE ' : ''}INTO journal_entries (id, project_id, kind, text, item_id, author_kind, author_role,
           approved_by_kind, approved_by_role, proposal_id, document_path, sources, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        input.kind,
        input.text,
        input.itemId ?? null,
        input.author.kind,
        input.author.role ?? null,
        input.approvedBy?.kind ?? null,
        input.approvedBy ? (input.approvedBy.role ?? null) : null,
        input.proposalId ?? null,
        input.documentPath ?? null,
        JSON.stringify(input.sources ?? []),
        new Date().toISOString(),
      );
    return Number(result.changes) > 0;
  }

  private entryOf(row: EntryRow): JournalEntry {
    return {
      id: row.id,
      projectId: row.project_id,
      kind: (KINDS[row.kind as JournalEntryKind] ? row.kind : 'note') as JournalEntryKind,
      text: row.text,
      itemId: row.item_id,
      item: row.item_id ? (this.deps.item?.(row.item_id) ?? null) : null,
      author: actorOf(row.author_kind, row.author_role),
      approvedBy: row.approved_by_kind ? actorOf(row.approved_by_kind, row.approved_by_role) : null,
      proposalId: row.proposal_id,
      documentPath: row.document_path,
      sources: sourcesOf(row.sources),
      createdAt: row.created_at,
    };
  }

  /** One entry as a flow run reads it: when, what kind, the item's key, then the text. */
  private render(entry: JournalEntry): string {
    const day = entry.createdAt.slice(0, 10);
    const key = entry.item ? ` ${entry.item.key}` : '';
    const who = entry.author.kind === 'agent' ? ` (${entry.author.role ?? 'agent'})` : '';
    const doc = entry.documentPath ? ` [${entry.documentPath}]` : '';
    const text = entry.text.trim().replace(/\n/g, '\n  ');
    return `- ${day} ${entry.kind}${key}${who}${doc}: ${text}`;
  }

  private announce(entry: JournalEntry, action: 'added' | 'removed'): void {
    this.deps.emit?.({
      type: 'journal.changed',
      title: action === 'added' ? `Journal: ${entry.kind} entry added` : `Journal: ${entry.kind} entry removed`,
      projectId: entry.projectId,
      entryId: entry.id,
      action,
      kind: entry.kind,
      itemId: entry.itemId,
    });
  }
}

function entryText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new WorkItemError('text is required', 400);
  const text = value.trim();
  if (text.length > JOURNAL_ENTRY_MAX) throw new WorkItemError(`an entry is longer than ${String(JOURNAL_ENTRY_MAX)} characters: write it as a document and refer to it`, 400);
  return text;
}

/**
 * A path relative to the project, with the shape every document path has (`document-paths.ts`): no
 * climbing, no hidden part such as `.git`, no control character. It may name any file, a decision
 * can point at code as well as at a document. Stored in NFC, as a tie is.
 */
function documentPath(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    return pathSegments(typeof value === 'string' ? value.trim() : value, 'documentPath').join('/').normalize('NFC');
  } catch (err) {
    if (err instanceof DocumentPathError) throw new WorkItemError(err.message, 400);
    throw err;
  }
}

function pageLimit(value: unknown): number {
  if (value === undefined || value === '') return JOURNAL_PAGE_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new WorkItemError('limit must be a positive whole number', 400);
  return Math.min(n, JOURNAL_PAGE_MAX);
}

function cursor(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new WorkItemError('before must be the nextBefore of a page', 400);
  return n;
}

function sourcesOf(json: string): WorkItemSource[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as WorkItemSource[]) : [];
  } catch {
    return [];
  }
}
