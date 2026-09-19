import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  AutoSwitchEvent,
  EffectiveEnvironment,
  Orchestration,
  OrchestrationSpec,
  PlanDraftSummary,
  RunSummary,
} from '@agentry/shared';
import type { CoreConfig } from './paths.ts';

/**
 * Embedded store for everything that is a stream rather than a document: rotation events today,
 * usage and audit history next. Settings-shaped state stays in its JSON file — a document that is
 * read and rewritten whole loses nothing to `writeAtomic`.
 *
 * SQLite comes with Node (>=22.5), so this costs no dependency and no build toolchain in the
 * image. WAL is the point of it as much as the persistence: several wrapper processes share one
 * data dir, and a JSON blob read, mutated and rewritten by two of them loses one side's writes.
 */

/** Applied in order; `user_version` records how many have run, so each one is written once. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE rotation_events (
     seq       INTEGER PRIMARY KEY AUTOINCREMENT,
     ts        TEXT NOT NULL,
     event     TEXT NOT NULL,
     from_acct TEXT,
     to_acct   TEXT,
     reason    TEXT,
     detail    TEXT,
     raw       TEXT
   );
   CREATE INDEX rotation_events_ts ON rotation_events (ts);`,

  // Runs and orchestrations keep their shared type as the source of truth and travel as JSON in
  // one row each. The row is the point: two wrapper processes on one data dir used to rewrite a
  // whole-file blob from their own in-memory map, so whoever saved last erased the other's work.
  `CREATE TABLE runs (
     id         TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     json       TEXT NOT NULL
   );
   CREATE INDEX runs_created_at ON runs (created_at DESC);
   CREATE TABLE orchestrations (
     id         TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     json       TEXT NOT NULL
   );
   CREATE INDEX orchestrations_created_at ON orchestrations (created_at DESC);`,

  // A planner run is expensive and leaves no transcript, so its draft is written down the moment
  // it finishes. Without this the plan lived only in the HTTP response, and a dropped connection
  // meant paying for it again.
  `CREATE TABLE plan_drafts (
     run_id     TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     objective  TEXT,
     json       TEXT NOT NULL
   );
   CREATE INDEX plan_drafts_created_at ON plan_drafts (created_at DESC);`,

  // What Claude actually loaded in a directory — tools, MCP servers, agents, skills — arrives only
  // in a run's init event. The transcript does not keep it, so without this the panel forgot it on
  // every restart until the next run there.
  `CREATE TABLE environments (
     cwd         TEXT PRIMARY KEY,
     observed_at TEXT NOT NULL,
     json        TEXT NOT NULL
   );`,
];

/** Rows older than this are dropped on open, so a long-lived install cannot grow without bound. */
const KEEP_EVENTS = 20_000;

interface EventRow {
  seq: number;
  ts: string;
  event: string;
  from_acct: string | null;
  to_acct: string | null;
  reason: string | null;
  detail: string | null;
  raw: string | null;
}

function toEvent(row: EventRow): AutoSwitchEvent {
  let data: Record<string, unknown> | undefined;
  if (row.raw) {
    try {
      data = JSON.parse(row.raw) as Record<string, unknown>;
    } catch {
      data = undefined; // a row written by a newer schema, or hand-edited: the columns still stand
    }
  }
  return {
    seq: row.seq,
    ts: row.ts,
    event: row.event,
    ...(row.from_acct ? { from: row.from_acct } : {}),
    ...(row.to_acct ? { to: row.to_acct } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(data ? { data } : {}),
  };
}

export class Db {
  private readonly db: DatabaseSync;

  constructor(config: CoreConfig) {
    this.db = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
    // WAL lets readers run while a writer holds the lock; busy_timeout absorbs the contention
    // between processes instead of throwing SQLITE_BUSY at whoever lost the race.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.pruneRotationEvents();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const applied = row?.user_version ?? 0;
    for (let version = applied; version < MIGRATIONS.length; version++) {
      const statement = MIGRATIONS[version];
      if (statement === undefined) continue;
      // One transaction per migration: a failure leaves user_version behind, never half a schema
      this.tx(() => {
        this.db.exec(statement);
        this.db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      });
    }
  }

  /** Appends one rotation event and returns it with the seq the store assigned. */
  appendRotationEvent(event: Omit<AutoSwitchEvent, 'seq'>): AutoSwitchEvent {
    const result = this.db
      .prepare(
        `INSERT INTO rotation_events (ts, event, from_acct, to_acct, reason, detail, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.ts,
        event.event,
        event.from ?? null,
        event.to ?? null,
        event.reason ?? null,
        event.detail ?? null,
        event.data ? JSON.stringify(event.data) : null,
      );
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  /**
   * Most recent events first in the query, returned oldest last so the panel can append them
   * the way it already renders the in-memory buffer.
   */
  rotationEvents(opts: { limit?: number; since?: string } = {}): AutoSwitchEvent[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 5_000);
    const params: SQLInputValue[] = [];
    let where = '';
    if (opts.since) {
      where = 'WHERE ts > ?';
      params.push(opts.since);
    }
    const rows = this.db
      .prepare(`SELECT * FROM rotation_events ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit) as unknown as EventRow[];
    return rows.map(toEvent).reverse();
  }

  /** Drops everything but the newest `keep` rows. Returns how many went. */
  pruneRotationEvents(keep = KEEP_EVENTS): number {
    const result = this.db
      .prepare(
        `DELETE FROM rotation_events
         WHERE seq <= COALESCE((SELECT seq FROM rotation_events ORDER BY seq DESC LIMIT 1 OFFSET ?), -1)`,
      )
      .run(keep);
    return Number(result.changes);
  }

  // ---------- runs and orchestrations ----------

  /**
   * Upserts the records this process owns, in one transaction. It never clears the table first:
   * rows another wrapper process wrote are not ours to drop.
   */
  private saveDocs(table: 'runs' | 'orchestrations', docs: Array<{ id: string; createdAt: string; value: unknown }>): void {
    const upsert = this.db.prepare(
      `INSERT INTO ${table} (id, created_at, json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, json = excluded.json`,
    );
    this.tx(() => {
      for (const doc of docs) upsert.run(doc.id, doc.createdAt, JSON.stringify(doc.value));
    });
  }

  private loadDocs<T>(table: 'runs' | 'orchestrations'): T[] {
    const rows = this.db.prepare(`SELECT json FROM ${table} ORDER BY created_at DESC`).all() as unknown as Array<{
      json: string;
    }>;
    const out: T[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.json) as T);
      } catch {
        // one unreadable row must not cost the caller the rest of its history
      }
    }
    return out;
  }

  /** Saves the given runs and trims the table to the newest `keep` by creation time. */
  saveRuns(runs: RunSummary[], keep: number): void {
    this.saveDocs(
      'runs',
      runs.map((run) => ({ id: run.id, createdAt: run.createdAt, value: run })),
    );
    this.db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT ?)').run(keep);
  }

  deleteRun(id: string): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  loadRuns(): RunSummary[] {
    return this.loadDocs<RunSummary>('runs');
  }

  saveOrchestrations(items: Orchestration[]): void {
    this.saveDocs(
      'orchestrations',
      items.map((item) => ({ id: item.id, createdAt: item.createdAt, value: item })),
    );
  }

  loadOrchestrations(): Orchestration[] {
    return this.loadDocs<Orchestration>('orchestrations');
  }

  // ---------- effective environments ----------

  saveEnvironment(env: EffectiveEnvironment): void {
    this.db
      .prepare(
        `INSERT INTO environments (cwd, observed_at, json) VALUES (?, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET observed_at = excluded.observed_at, json = excluded.json`,
      )
      .run(env.cwd, env.observedAt, JSON.stringify(env));
  }

  loadEnvironments(): EffectiveEnvironment[] {
    const rows = this.db.prepare('SELECT json FROM environments ORDER BY observed_at DESC').all() as unknown as Array<{ json: string }>;
    const out: EffectiveEnvironment[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.json) as EffectiveEnvironment);
      } catch {
        // an unreadable row just drops out of the panel
      }
    }
    return out;
  }

  // ---------- planner drafts ----------

  savePlanDraft(runId: string, draft: OrchestrationSpec): void {
    this.db
      .prepare(
        `INSERT INTO plan_drafts (run_id, created_at, objective, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET objective = excluded.objective, json = excluded.json`,
      )
      .run(runId, new Date().toISOString(), draft.objective ?? null, JSON.stringify(draft));
  }

  planDraft(runId: string): OrchestrationSpec | null {
    const row = this.db.prepare('SELECT json FROM plan_drafts WHERE run_id = ?').get(runId) as { json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.json) as OrchestrationSpec;
    } catch {
      return null;
    }
  }

  /** Newest first, for the picker that lets a lost plan be recovered instead of re-planned. */
  planDrafts(limit = 20): PlanDraftSummary[] {
    const rows = this.db
      .prepare('SELECT run_id, created_at, objective, json FROM plan_drafts ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(Math.trunc(limit), 1), 100)) as unknown as Array<{
      run_id: string;
      created_at: string;
      objective: string | null;
      json: string;
    }>;
    const out: PlanDraftSummary[] = [];
    for (const row of rows) {
      try {
        const spec = JSON.parse(row.json) as OrchestrationSpec;
        out.push({
          runId: row.run_id,
          createdAt: row.created_at,
          name: spec.name,
          objective: row.objective,
          taskCount: spec.tasks.length,
        });
      } catch {
        // a row we can no longer read is not worth failing the list over
      }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
