import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { DEFAULT_LEVEL, KINDS, LEVELS, type NotificationKind, type NotificationLevel } from '@agentry/shared';
import type {
  AuditEntry,
  AuditFilter,
  HealthSignalKind,
  AuditPage,
  AutoSwitchEvent,
  DecisionAnswer,
  DecisionFeedback,
  DecisionFilter,
  DecisionPage,
  DecisionPageQuery,
  DecisionPointId,
  DecisionPointKind,
  DecisionPointStats,
  DecisionProviderId,
  DecisionQuestion,
  DecisionRecord,
  DecisionResolution,
  DecisionStats,
  DecisionSubjectKind,
  DecisionUnavailableReason,
  EffectiveEnvironment,
  Execution,
  Orchestration,
  OrchestrationSpec,
  PlanDraftSummary,
  SupervisorProposal,
  SupervisorProposalStatus,
  UsageHistoryPoint,
  UsageWindowKind,
} from '@agentry/shared';
import { chatsFromRuns, type ChatRecord, type LegacyRun, type StoredChat } from './chat-records.ts';
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

/**
 * Applied in order; `user_version` records how many have run, so each one is written once. A
 * function is for a change SQL cannot express: it rewrites rows into a new shape, inside the same
 * transaction as the version bump.
 */
const MIGRATIONS: ReadonlyArray<string | ((db: DatabaseSync) => void)> = [
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

  // A run stops being a peer of a chat and becomes one execution of it. The chat is the session id,
  // and its executions are indexed by it; the old rows are folded into that shape here, once, and
  // the table they lived in is dropped, so nothing reads the old shape afterwards.
  migrateRunsToChats,

  // The context window of a model is a fact the CLI reports with every result (`modelUsage`), and
  // the only honest source of one: it differs between a model and its `[1m]` variant, and even
  // between accounts. Kept as it was last observed, so a chat read from a transcript, which does
  // not record it, can still be measured against it.
  `CREATE TABLE model_windows (
     model       TEXT PRIMARY KEY,
     context     INTEGER NOT NULL,
     observed_at TEXT NOT NULL
   );`,

  // How long each kind of shell command took, and how it ended, so that "far longer than usual" is
  // measured on this machine's own history and not guessed. One row per command a worker ran; the
  // index serves the only question asked of it: the recent runs of one kind.
  `CREATE TABLE command_durations (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     kind        TEXT NOT NULL,
     chat_id     TEXT NOT NULL,
     tool_use_id TEXT NOT NULL,
     started_at  TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     outcome     TEXT NOT NULL
   );
   CREATE INDEX command_durations_kind ON command_durations (kind, id DESC);
   CREATE UNIQUE INDEX command_durations_call ON command_durations (chat_id, tool_use_id);`,

  // Every mutating request, so exposing the port leaves a trail. The body is deliberately not a
  // column: it carries prompts, credentials and MCP secrets, and an audit log nobody can share is
  // worth less than one that records who did what to which route.
  `CREATE TABLE audit (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     at     TEXT NOT NULL,
     actor  TEXT NOT NULL,
     method TEXT NOT NULL,
     path   TEXT NOT NULL,
     status INTEGER NOT NULL,
     summary TEXT NOT NULL
   );
   CREATE INDEX audit_path ON audit (path);`,
  // What claude-swap reports about each account's windows, one row per reading: the panel draws a
  // line from them, and "how fast does this account burn" has no other source. The key makes a
  // second reading of the same instant a no-op instead of a duplicate.
  `CREATE TABLE usage_history (
     account INTEGER NOT NULL,
     window  TEXT NOT NULL,
     at      TEXT NOT NULL,
     pct     REAL NOT NULL,
     PRIMARY KEY (account, window, at)
   );
   CREATE INDEX usage_history_at ON usage_history (at);`,

  // What the supervisor proposed when a worker's health turned bad. Rows, because they accumulate;
  // the unique key is the rule "once per signal per chat", held by the store and not by a map that
  // a restart would empty.
  `CREATE TABLE supervisor_proposals (
     id               TEXT PRIMARY KEY,
     chat_id          TEXT NOT NULL,
     task_id          TEXT,
     orchestration_id TEXT,
     signal           TEXT NOT NULL,
     hint             TEXT NOT NULL,
     cost_usd         REAL NOT NULL,
     at               TEXT NOT NULL,
     status           TEXT NOT NULL
   );
   CREATE UNIQUE INDEX supervisor_proposals_signal ON supervisor_proposals (chat_id, signal);`,

  // One row per install that asked to be pushed to. Rows, because they accumulate and each one is
  // a fact about a device rather than a setting of this server. The endpoint is the identity a push
  // service gives an install, so it is the unique key: a browser that re-subscribes with the same
  // endpoint refreshes its row instead of adding a second one.
  `CREATE TABLE push_subscriptions (
     id           TEXT PRIMARY KEY,
     endpoint     TEXT NOT NULL UNIQUE,
     p256dh       TEXT NOT NULL,
     auth         TEXT NOT NULL,
     kinds        TEXT NOT NULL,
     label        TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     last_seen_at TEXT NOT NULL
   );`,
  // How much each install may be interrupted. Rows from before it get the default a new install
  // gets: the page re-registers with its own choice the next time it opens anyway.
  `ALTER TABLE push_subscriptions ADD COLUMN level TEXT NOT NULL DEFAULT 'important';`,

  // The work items of the project ecosystem (docs/plans/project-ecosystem.md), in rows rather than
  // one document per item: several processes move cards at once, and a card rewritten whole by one
  // of them would erase the other's comment. Only the number is stored, never the key, so a new
  // prefix renames every key at once. The counter hands out numbers and is never decremented, so a
  // number freed by a delete is not handed out again. Nothing references the projects: a project
  // removed from Agentry keeps its work items for when its directory is imported again.
  `CREATE TABLE work_item_counters (
     project_id  TEXT PRIMARY KEY,
     last_number INTEGER NOT NULL
   );
   CREATE TABLE milestones (
     id          TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL,
     name        TEXT NOT NULL,
     description TEXT NOT NULL,
     state       TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     closed_at   TEXT
   );
   CREATE INDEX milestones_project ON milestones (project_id, created_at);
   CREATE TABLE work_items (
     id            TEXT PRIMARY KEY,
     project_id    TEXT NOT NULL,
     number        INTEGER NOT NULL,
     type          TEXT NOT NULL,
     title         TEXT NOT NULL,
     description   TEXT NOT NULL,
     status        TEXT NOT NULL,
     priority      TEXT NOT NULL,
     assignee_kind TEXT,
     assignee_role TEXT,
     epic_id       TEXT REFERENCES work_items (id) ON DELETE SET NULL,
     milestone_id  TEXT REFERENCES milestones (id) ON DELETE SET NULL,
     rank          TEXT NOT NULL,
     worktree      TEXT,
     branch        TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     closed_at     TEXT,
     UNIQUE (project_id, number)
   );
   CREATE INDEX work_items_board ON work_items (project_id, status, rank);
   CREATE INDEX work_items_status ON work_items (status, rank);
   CREATE INDEX work_items_epic ON work_items (epic_id);
   CREATE INDEX work_items_milestone ON work_items (milestone_id);
   CREATE TABLE work_item_labels (
     item_id  TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     label    TEXT NOT NULL,
     PRIMARY KEY (item_id, label)
   );
   CREATE INDEX work_item_labels_label ON work_item_labels (label);
   CREATE TABLE work_item_criteria (
     id              TEXT PRIMARY KEY,
     item_id         TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     position        INTEGER NOT NULL,
     text            TEXT NOT NULL,
     checked         INTEGER NOT NULL DEFAULT 0,
     checked_by_kind TEXT,
     checked_by_role TEXT
   );
   CREATE INDEX work_item_criteria_item ON work_item_criteria (item_id, position);
   CREATE TABLE work_item_relations (
     blocker_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     blocked_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     PRIMARY KEY (blocker_id, blocked_id)
   );
   CREATE INDEX work_item_relations_blocked ON work_item_relations (blocked_id);
   CREATE TABLE work_item_comments (
     id                      TEXT PRIMARY KEY,
     item_id                 TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     author_kind             TEXT NOT NULL,
     author_role             TEXT,
     source_kind             TEXT,
     source_chat_id          TEXT,
     source_orchestration_id TEXT,
     source_task_id          TEXT,
     body                    TEXT NOT NULL,
     created_at              TEXT NOT NULL,
     updated_at              TEXT NOT NULL
   );
   CREATE INDEX work_item_comments_item ON work_item_comments (item_id, created_at);
   CREATE TABLE work_item_history (
     seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
     id                     TEXT NOT NULL UNIQUE,
     item_id                TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     change                 TEXT NOT NULL,
     from_value             TEXT,
     to_value               TEXT,
     actor_kind             TEXT NOT NULL,
     actor_role             TEXT,
     cause_kind             TEXT,
     cause_event            TEXT,
     cause_chat_id          TEXT,
     cause_orchestration_id TEXT,
     cause_task_id          TEXT,
     created_at             TEXT NOT NULL
   );
   CREATE INDEX work_item_history_item ON work_item_history (item_id, seq);
   CREATE TABLE work_item_links (
     id               TEXT PRIMARY KEY,
     item_id          TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     kind             TEXT NOT NULL,
     role             TEXT NOT NULL,
     chat_id          TEXT,
     orchestration_id TEXT,
     task_id          TEXT,
     created_at       TEXT NOT NULL
   );
   CREATE INDEX work_item_links_item ON work_item_links (item_id, created_at);
   CREATE INDEX work_item_links_chat ON work_item_links (chat_id);
   CREATE INDEX work_item_links_task ON work_item_links (orchestration_id, task_id);`,

  // A project's journal and the memory its team proposes (orchestration 3 of
  // docs/plans/project-ecosystem.md). Rows, because both accumulate and several processes write
  // them: a closed item, an approval and a note typed by hand can land at once. `seq` orders the
  // journal and pages it, since two entries can share a timestamp. A `closed` entry is written once
  // per item, which the partial index holds even against two processes closing it together. No
  // reference to the work items: the journal keeps what happened after the item is deleted.
  `CREATE TABLE journal_entries (
     seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
     id                      TEXT NOT NULL UNIQUE,
     project_id              TEXT NOT NULL,
     kind                    TEXT NOT NULL,
     text                    TEXT NOT NULL,
     item_id                 TEXT,
     author_kind             TEXT NOT NULL,
     author_role             TEXT,
     approved_by_kind        TEXT,
     approved_by_role        TEXT,
     proposal_id             TEXT,
     document_path           TEXT,
     sources                 TEXT NOT NULL DEFAULT '[]',
     created_at              TEXT NOT NULL
   );
   CREATE INDEX journal_entries_project ON journal_entries (project_id, seq);
   CREATE UNIQUE INDEX journal_entries_closed ON journal_entries (item_id) WHERE kind = 'closed';
   CREATE TABLE memory_proposals (
     seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
     id                      TEXT NOT NULL UNIQUE,
     project_id              TEXT NOT NULL,
     target_kind             TEXT NOT NULL,
     target_file             TEXT,
     target_section          TEXT,
     text                    TEXT NOT NULL,
     reason                  TEXT NOT NULL,
     status                  TEXT NOT NULL,
     proposed_by_kind        TEXT NOT NULL,
     proposed_by_role        TEXT,
     source_kind             TEXT,
     source_chat_id          TEXT,
     source_orchestration_id TEXT,
     source_task_id          TEXT,
     flow_run_id             TEXT,
     item_id                 TEXT,
     approved_text           TEXT,
     decided_by_kind         TEXT,
     decided_by_role         TEXT,
     decided_at              TEXT,
     reject_reason           TEXT,
     journal_entry_id        TEXT REFERENCES journal_entries (id) ON DELETE SET NULL,
     created_at              TEXT NOT NULL
   );
   CREATE INDEX memory_proposals_project ON memory_proposals (project_id, status, seq);`,

  // A document of the project tied to a work item (the Documents module) is a link like a chat is,
  // so an item keeps one list of what it is tied to. The path is relative to the project, never
  // absolute, so a project moved to another directory keeps its ties. `team_role` is the role whose
  // flow run made a link, for documents and chats alike; null for links made outside the flow.
  `ALTER TABLE work_item_links ADD COLUMN document_path TEXT;
   ALTER TABLE work_item_links ADD COLUMN document_kind TEXT;
   ALTER TABLE work_item_links ADD COLUMN team_role TEXT;
   CREATE INDEX work_item_links_document ON work_item_links (document_path) WHERE document_path IS NOT NULL;`,

  // The flow by column (orchestration 3 of docs/plans/project-ecosystem.md). An item's bounces and
  // what it waits for are its own columns, read with the card. Each run of a team member is a row, so
  // a queue a restart cut off is still there when the wrapper comes back; `seq` is the queue's order.
  // At most one run per item waits in the queue: a second trigger replaces the first, which is what
  // keeps a burst of moves from queueing a burst of paid runs.
  `ALTER TABLE work_items ADD COLUMN bounces INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE work_items ADD COLUMN waiting TEXT;
   CREATE TABLE flow_runs (
     seq         INTEGER PRIMARY KEY AUTOINCREMENT,
     id          TEXT NOT NULL UNIQUE,
     project_id  TEXT NOT NULL,
     item_id     TEXT NOT NULL,
     role        TEXT NOT NULL,
     agent       TEXT NOT NULL,
     model       TEXT NOT NULL,
     stage       TEXT NOT NULL,
     column_name TEXT NOT NULL,
     state       TEXT NOT NULL,
     chat_id     TEXT,
     outcome     TEXT,
     summary     TEXT,
     error       TEXT,
     queued_at   TEXT NOT NULL,
     started_at  TEXT,
     ended_at    TEXT
   );
   CREATE INDEX flow_runs_project ON flow_runs (project_id, state, seq);
   CREATE INDEX flow_runs_item ON flow_runs (item_id, seq);
   CREATE INDEX flow_runs_chat ON flow_runs (chat_id) WHERE chat_id IS NOT NULL;
   CREATE UNIQUE INDEX flow_runs_queued ON flow_runs (item_id) WHERE state = 'queued';`,
  // The project assistant (orchestration 4): each run a read-only chat, each proposal a row decided on
  // its own. What a run laid out to read and what it read are kept apart, so the list can be drawn
  // at any moment. One running run per project and kind, held by the index rather than by a check
  // two processes could both pass.
  `CREATE TABLE assistant_runs (
     seq           INTEGER PRIMARY KEY AUTOINCREMENT,
     id            TEXT NOT NULL UNIQUE,
     project_id    TEXT NOT NULL,
     kind          TEXT NOT NULL,
     status        TEXT NOT NULL,
     model         TEXT NOT NULL,
     description   TEXT,
     resource_kind TEXT,
     chat_id       TEXT,
     empty         INTEGER NOT NULL DEFAULT 0,
     template      TEXT,
     proposes      TEXT NOT NULL,
     base_sources  TEXT NOT NULL,
     reads         TEXT NOT NULL,
     findings      TEXT NOT NULL DEFAULT '[]',
     summary       TEXT,
     cost_usd      REAL,
     error         TEXT,
     supersedes    TEXT,
     superseded_by TEXT,
     restarts      INTEGER NOT NULL DEFAULT 0,
     started_at    TEXT NOT NULL,
     ended_at      TEXT
   );
   CREATE INDEX assistant_runs_project ON assistant_runs (project_id, kind, seq);
   CREATE INDEX assistant_runs_chat ON assistant_runs (chat_id) WHERE chat_id IS NOT NULL;
   CREATE UNIQUE INDEX assistant_runs_running ON assistant_runs (project_id, kind) WHERE status = 'running';
   CREATE TABLE assistant_proposals (
     seq              INTEGER PRIMARY KEY AUTOINCREMENT,
     id               TEXT NOT NULL UNIQUE,
     run_id           TEXT NOT NULL,
     project_id       TEXT NOT NULL,
     kind             TEXT NOT NULL,
     status           TEXT NOT NULL,
     position         INTEGER NOT NULL,
     reason           TEXT NOT NULL,
     payload          TEXT NOT NULL,
     outcome          TEXT,
     decided_by_kind  TEXT,
     decided_by_role  TEXT,
     decided_at       TEXT,
     created_at       TEXT NOT NULL
   );
   CREATE INDEX assistant_proposals_run ON assistant_proposals (run_id, kind, position);`,
  // How many times a restart cut a flow run off: a run goes on in its chat at most twice, so a
  // run that keeps dying with the wrapper does not keep spending
  `ALTER TABLE flow_runs ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0;`,
  // A label filter folds case and accents in JS, so no query ever used this index: it only cost
  // every write of an item's labels
  `DROP INDEX IF EXISTS work_item_labels_label;`,
  // What "Suggest tasks" is asked to look at, apart from what a project is for, and the language a
  // run's chat is titled in, so a run started again after a restart is worded as it was first
  `ALTER TABLE assistant_runs ADD COLUMN focus TEXT;
   ALTER TABLE assistant_runs ADD COLUMN language TEXT;`,
  // The language a flow run's chat is titled in, taken when the run is queued: after a restart the
  // person's language is unknown until their next request, and a queued run would be titled in English
  `ALTER TABLE flow_runs ADD COLUMN language TEXT;`,
  // Why a flow run failed or was cancelled, as a code the panel words in the person's language (the
  // English error stays beside it), and the failed run a person's retry queued it for
  `ALTER TABLE flow_runs ADD COLUMN cause TEXT;
   ALTER TABLE flow_runs ADD COLUMN retry_of TEXT;`,
  // Who queued a flow run by hand: a person starting the cards that waited when the flow was
  // switched on. Null for a run a card entering its column queued
  `ALTER TABLE flow_runs ADD COLUMN queued_by TEXT;`,
  // How many times the flow sent a run back to its chat because it ended with work still owed
  // (`openItems`): capped, so a run that keeps stopping early cannot spend for ever
  `ALTER TABLE flow_runs ADD COLUMN continuations INTEGER NOT NULL DEFAULT 0;`,
  // A work item's pull requests, one row per PR (docs/plans/work-item-pull-requests.md): they
  // accumulate, and the item reads its newest. `approved_at` is when the person approved it, and
  // `moved_at` when a conflict sent the item back to work, which a person's later move is measured
  // from. `claimed_until` keeps two processes on one database from asking gh about one PR at once.
  // A verification's criteria are kept on its run, as the PR's body quotes QA's notes
  `CREATE TABLE work_item_pull_requests (
     id             TEXT PRIMARY KEY,
     item_id        TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     project_id     TEXT NOT NULL,
     phase          TEXT NOT NULL,
     number         INTEGER,
     url            TEXT,
     branch         TEXT NOT NULL,
     base           TEXT NOT NULL,
     ci             TEXT,
     conflicts      TEXT NOT NULL DEFAULT '[]',
     error_code     TEXT,
     error_detail   TEXT,
     approved_at    TEXT NOT NULL,
     moved_at       TEXT,
     opened_at      TEXT,
     closed_at      TEXT,
     checked_at     TEXT,
     claimed_until  TEXT,
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL
   );
   CREATE INDEX work_item_pull_requests_item ON work_item_pull_requests (item_id, created_at);
   CREATE INDEX work_item_pull_requests_phase ON work_item_pull_requests (phase);
   ALTER TABLE flow_runs ADD COLUMN criteria TEXT;`,
  // The decision engine's history (docs/plans/decision-engine.md): one row per question batch sent
  // to a provider. Rows, because they accumulate, and the shadow comparison needs each answer next
  // to what later happened. `seq` is the paging cursor; `state` is the exact state sent, which the
  // consent preview reads back
  `CREATE TABLE decisions (
     seq            INTEGER PRIMARY KEY AUTOINCREMENT,
     id             TEXT NOT NULL UNIQUE,
     point          TEXT NOT NULL,
     kind           TEXT NOT NULL,
     project_id     TEXT,
     subject_kind   TEXT NOT NULL,
     subject_id     TEXT,
     provider       TEXT NOT NULL,
     model          TEXT NOT NULL,
     mode           TEXT NOT NULL,
     status         TEXT NOT NULL,
     unavailable    TEXT,
     state          TEXT NOT NULL,
     questions      TEXT NOT NULL,
     answers        TEXT,
     confidence     REAL,
     threshold      REAL,
     acted          INTEGER NOT NULL,
     visible        INTEGER NOT NULL,
     saved_run      INTEGER NOT NULL,
     latency_ms     INTEGER NOT NULL,
     input_tokens   INTEGER,
     cost_usd       REAL,
     outcome        TEXT,
     agreed         INTEGER,
     resolved_at    TEXT,
     feedback       TEXT,
     feedback_at    TEXT,
     at             TEXT NOT NULL
   );
   CREATE INDEX decisions_point_at ON decisions (point, at);
   CREATE INDEX decisions_project_at ON decisions (project_id, at);
   CREATE INDEX decisions_subject ON decisions (subject_kind, subject_id);`,
];

/**
 * The schema version the work item tables arrive in. Found rather than counted, so the test that
 * upgrades into it keeps upgrading from the version before it when later migrations are added.
 */
export const WORK_ITEMS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE work_item_counters')) + 1;

/** The version that added the flow's runs, for the test that upgrades a database from the one before */
export const FLOW_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE flow_runs')) + 1;
/** The version flow runs got their cause and the run a retry was for, for the test that upgrades into it */
export const FLOW_CAUSE_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('ADD COLUMN retry_of')) + 1;
/** The schema version document links arrive in, found the same way. */
export const DOCUMENT_LINKS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('ADD COLUMN document_path')) + 1;
/** The version that added the assistant's runs and proposals, found the same way */
export const ASSISTANT_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE assistant_runs')) + 1;

/**
 * Applies the migrations a database has not run yet, up to schema version `until` (every one by
 * default). Exported so a test can build a database as an older release left it.
 */
export function migrate(db: DatabaseSync, until = MIGRATIONS.length): void {
  const target = Math.min(until, MIGRATIONS.length);
  for (;;) {
    // One transaction per migration: a failure leaves user_version behind, never half a schema.
    // IMMEDIATE, and the version read inside it: two processes opening an old database at once
    // would otherwise both read the same version and the second would run a migration again
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
      const version = row?.user_version ?? 0;
      if (version >= target) {
        db.exec('COMMIT');
        return;
      }
      const statement = MIGRATIONS[version];
      if (typeof statement === 'string') db.exec(statement);
      else if (statement) statement(db);
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Rows older than this are dropped on open, so a long-lived install cannot grow without bound. */
const KEEP_EVENTS = 20_000;
/** Command runs kept across every kind; the newest few dozen of a kind are all "usual" ever looks at. */
const KEEP_COMMANDS = 10_000;

/** How a command ended: `cancelled` is a person's decision, and a command that hung and was cancelled is that. */
export type CommandOutcome = 'ok' | 'error' | 'cancelled';

export interface CommandRun {
  kind: string;
  chatId: string;
  toolUseId: string;
  startedAt: string;
  durationMs: number;
  outcome: CommandOutcome;
}
/** The same for the audit log, which grows with every write a person or a worker makes. */
const KEEP_AUDIT = 50_000;
/** Pruning on every insert would cost a delete per request; this is often enough to bound it. */
const AUDIT_PRUNE_EVERY = 500;

interface JsonRow {
  json: string;
}

/** Reads a table of JSON documents, skipping a row that no longer parses. */
function readDocs<T>(db: DatabaseSync, sql: string): Array<{ row: Record<string, unknown>; doc: T }> {
  const out: Array<{ row: Record<string, unknown>; doc: T }> = [];
  for (const row of db.prepare(sql).all() as Array<Record<string, unknown>>) {
    try {
      out.push({ row, doc: JSON.parse(String(row.json)) as T });
    } catch {
      // an unreadable row cannot be carried over; it was already unreadable before
    }
  }
  return out;
}

function migrateRunsToChats(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE chats (
      id         TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      json       TEXT NOT NULL
    );
    CREATE INDEX chats_created_at ON chats (created_at DESC);
    CREATE TABLE executions (
      id         TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      json       TEXT NOT NULL
    );
    CREATE INDEX executions_chat ON executions (chat_id, started_at);
  `);
  const { chats, chatOf } = chatsFromRuns(readDocs<LegacyRun>(db, 'SELECT json FROM runs').map((r) => r.doc));
  const insertChat = db.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)');
  const insertExecution = db.prepare('INSERT INTO executions (id, chat_id, started_at, json) VALUES (?, ?, ?, ?)');
  for (const { record, executions } of chats) {
    insertChat.run(record.id, record.createdAt, JSON.stringify(record));
    for (const execution of executions) insertExecution.run(execution.id, record.id, execution.startedAt, JSON.stringify(execution));
  }
  db.exec('DROP TABLE runs');

  // What pointed at a run now points at the chat that run became; a run that started nothing has
  // no chat, and what pointed at it points at nothing
  const chat = (runId: unknown): string | null => (typeof runId === 'string' ? (chatOf.get(runId) ?? null) : null);
  const updateOrchestration = db.prepare('UPDATE orchestrations SET json = ? WHERE id = ?');
  for (const { row, doc } of readDocs<Orchestration & { workflow?: { runId: string | null } | null }>(db, 'SELECT id, json FROM orchestrations')) {
    for (const task of doc.tasks) task.runId = chat(task.runId);
    if ('synthesisRunId' in doc) doc.synthesisRunId = chat(doc.synthesisRunId);
    if (doc.workflow) doc.workflow.runId = chat(doc.workflow.runId);
    updateOrchestration.run(JSON.stringify(doc), String(row.id));
  }
  // The planner's draft is found by the run that wrote it; a draft whose run left no chat has no
  // key to be found by, so it goes with it
  for (const row of db.prepare('SELECT run_id FROM plan_drafts').all() as Array<{ run_id: string }>) {
    const next = chat(row.run_id);
    if (next) db.prepare('UPDATE plan_drafts SET run_id = ? WHERE run_id = ?').run(next, row.run_id);
    else db.prepare('DELETE FROM plan_drafts WHERE run_id = ?').run(row.run_id);
  }
  const updateEnvironment = db.prepare('UPDATE environments SET json = ? WHERE cwd = ?');
  for (const { row, doc } of readDocs<Record<string, unknown>>(db, 'SELECT cwd, json FROM environments')) {
    const { runId, ...rest } = doc;
    updateEnvironment.run(JSON.stringify({ ...rest, chatId: chat(runId) ?? '' }), String(row.cwd));
  }
}

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
  private auditWrites = 0;

  constructor(config: CoreConfig) {
    this.db = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
    // WAL lets readers run while a writer holds the lock; busy_timeout absorbs the contention
    // between processes instead of throwing SQLITE_BUSY at whoever lost the race. It goes first:
    // switching the journal mode takes a lock too, and a process opening the file while another
    // writes would otherwise fail on the spot with "database is locked".
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
    this.pruneRotationEvents();
    this.pruneAudit();
  }

  /**
   * The connection itself, for a store whose queries live in their own module (`work-items.ts`)
   * rather than growing this class: it shares the schema, the pragmas and the migrations.
   */
  get connection(): DatabaseSync {
    return this.db;
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

  // ---------- audit log ----------

  /** Appends one mutating request. The caller builds the summary from the route, never from the body. */
  appendAudit(entry: Omit<AuditEntry, 'id'>): AuditEntry {
    const result = this.db
      .prepare('INSERT INTO audit (at, actor, method, path, status, summary) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.at, entry.actor, entry.method, entry.path, entry.status, entry.summary);
    if (++this.auditWrites % AUDIT_PRUNE_EVERY === 0) this.pruneAudit();
    return { ...entry, id: String(result.lastInsertRowid) };
  }

  /**
   * Newest first. `path` matches anywhere in the path, which is how the panel filters by route;
   * `method` and `status` narrow it further, and every filter narrows `total` with the page.
   */
  auditPage(opts: { limit?: number; from?: number } & AuditFilter = {}): AuditPage {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 500);
    const from = Math.max(Math.trunc(opts.from ?? 0), 0);
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    const path = opts.path?.trim();
    if (path) {
      // Paths hold `_` in ids and `%` in encoded segments, which LIKE would read as wildcards
      clauses.push("path LIKE ? ESCAPE '\\'");
      params.push(`%${path.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const method = opts.method?.trim();
    if (method) {
      clauses.push('method = ?');
      params.push(method.toUpperCase());
    }
    const status = opts.status?.trim();
    if (status) {
      const range = statusRange(status);
      clauses.push('status BETWEEN ? AND ?');
      params.push(range[0], range[1]);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM audit ${where}`).get(...params) as { n: number } | undefined;
    const rows = this.db
      .prepare(`SELECT * FROM audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, from) as unknown as Array<{ id: number; at: string; actor: string; method: string; path: string; status: number; summary: string }>;
    return {
      entries: rows.map((row) => ({ ...row, id: String(row.id) })),
      total: totalRow?.n ?? 0,
      from,
    };
  }

  /** Drops everything but the newest `keep` rows. Returns how many went. */
  pruneAudit(keep = KEEP_AUDIT): number {
    const result = this.db
      .prepare('DELETE FROM audit WHERE id <= COALESCE((SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?), -1)')
      .run(keep);
    return Number(result.changes);
  }

  // ---------- usage history ----------

  /** Appends readings; one already stored for the same account, window and instant is left as it was. */
  appendUsagePoints(points: readonly UsageHistoryPoint[]): void {
    if (!points.length) return;
    const insert = this.db.prepare('INSERT OR IGNORE INTO usage_history (account, window, at, pct) VALUES (?, ?, ?, ?)');
    this.tx(() => {
      for (const p of points) insert.run(p.account, p.window, p.at, p.pct);
    });
  }

  /** The newest reading of one account's window, so a sampler can tell whether anything moved. */
  latestUsagePoint(account: number, window: UsageWindowKind): UsageHistoryPoint | null {
    const row = this.db
      .prepare('SELECT account, window, at, pct FROM usage_history WHERE account = ? AND window = ? ORDER BY at DESC LIMIT 1')
      .get(account, window) as unknown as UsageHistoryPoint | undefined;
    return row ? { at: row.at, pct: row.pct, window: row.window, account: row.account } : null;
  }

  /** Oldest first, so a chart can draw it as it comes. `limit` keeps the newest rows of the range. */
  usageHistory(opts: { account?: number; window?: UsageWindowKind; since?: string; until?: string; limit?: number } = {}): UsageHistoryPoint[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 5_000), 1), 50_000);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.account !== undefined) {
      where.push('account = ?');
      params.push(opts.account);
    }
    if (opts.window) {
      where.push('window = ?');
      params.push(opts.window);
    }
    if (opts.since) {
      where.push('at >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      where.push('at <= ?');
      params.push(opts.until);
    }
    const rows = this.db
      .prepare(`SELECT account, window, at, pct FROM usage_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`)
      .all(...params, limit) as unknown as UsageHistoryPoint[];
    return rows.map((r) => ({ at: r.at, pct: r.pct, window: r.window, account: r.account })).reverse();
  }

  /** Drops readings older than `before`. Returns how many went. */
  pruneUsageHistory(before: string): number {
    return Number(this.db.prepare('DELETE FROM usage_history WHERE at < ?').run(before).changes);
  }

  // ---------- chats, executions and orchestrations ----------

  /**
   * Upserts the records this process owns, in one transaction. It never clears the table first:
   * rows another wrapper process wrote are not ours to drop.
   */
  private saveDocs(table: 'orchestrations', docs: Array<{ id: string; createdAt: string; value: unknown }>): void {
    const upsert = this.db.prepare(
      `INSERT INTO ${table} (id, created_at, json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, json = excluded.json`,
    );
    this.tx(() => {
      for (const doc of docs) upsert.run(doc.id, doc.createdAt, JSON.stringify(doc.value));
    });
  }

  private loadDocs<T>(table: 'orchestrations'): T[] {
    const rows = this.db.prepare(`SELECT json FROM ${table} ORDER BY created_at DESC`).all() as unknown as JsonRow[];
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

  /**
   * Saves the given chats with their executions and trims the table to the newest `keep` chats by
   * creation time; the executions of a chat that goes, go with it. With `keep` null nothing is
   * trimmed: only a new chat can push an old one out.
   */
  saveChats(chats: StoredChat[], keep: number | null): void {
    const upsertChat = this.db.prepare(
      `INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, json = excluded.json`,
    );
    const upsertExecution = this.db.prepare(
      `INSERT INTO executions (id, chat_id, started_at, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, json = excluded.json`,
    );
    this.tx(() => {
      for (const { record, executions } of chats) {
        upsertChat.run(record.id, record.createdAt, JSON.stringify(record));
        for (const execution of executions) upsertExecution.run(execution.id, record.id, execution.startedAt, JSON.stringify(execution));
      }
      if (keep !== null) this.db.prepare('DELETE FROM chats WHERE id NOT IN (SELECT id FROM chats ORDER BY created_at DESC LIMIT ?)').run(keep);
    });
  }

  deleteChat(id: string): void {
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  }

  /** Which of `ids` are stored now: a trim, ours or another process's, may have taken one since it was saved. */
  storedChats(ids: readonly string[]): Set<string> {
    const found = new Set<string>();
    const has = this.db.prepare('SELECT 1 FROM chats WHERE id = ?');
    for (const id of ids) if (has.get(id)) found.add(id);
    return found;
  }

  /** Newest chat first, each with its executions oldest first. */
  loadChats(): StoredChat[] {
    const byChat = new Map<string, Execution[]>();
    const executions = this.db.prepare('SELECT chat_id, json FROM executions ORDER BY started_at ASC').all() as unknown as Array<JsonRow & { chat_id: string }>;
    for (const row of executions) {
      try {
        const list = byChat.get(row.chat_id) ?? [];
        list.push(JSON.parse(row.json) as Execution);
        byChat.set(row.chat_id, list);
      } catch {
        // an execution that cannot be read leaves a gap in the history, not in the chat
      }
    }
    const out: StoredChat[] = [];
    for (const row of this.db.prepare('SELECT json FROM chats ORDER BY created_at DESC').all() as unknown as JsonRow[]) {
      try {
        const record = JSON.parse(row.json) as ChatRecord;
        out.push({ record, executions: byChat.get(record.id) ?? [] });
      } catch {
        // one unreadable row must not cost the caller the rest of its history
      }
    }
    return out;
  }

  /** When a stored chat was last heard from, which is when an execution a restart cut off stopped. */
  chatUpdatedAt(id: string): string | null {
    const row = this.db.prepare('SELECT json FROM chats WHERE id = ?').get(id) as JsonRow | undefined;
    if (!row) return null;
    try {
      return (JSON.parse(row.json) as ChatRecord).updatedAt;
    } catch {
      return null;
    }
  }

  saveOrchestrations(items: Orchestration[]): void {
    this.saveDocs(
      'orchestrations',
      items.map((item) => ({ id: item.id, createdAt: item.createdAt, value: item })),
    );
  }

  deleteOrchestration(id: string): void {
    this.db.prepare('DELETE FROM orchestrations WHERE id = ?').run(id);
  }

  loadOrchestrations(): Orchestration[] {
    return this.loadDocs<Orchestration>('orchestrations');
  }

  // ---------- model context windows ----------

  saveModelWindow(model: string, context: number): void {
    this.db
      .prepare(
        `INSERT INTO model_windows (model, context, observed_at) VALUES (?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET context = excluded.context, observed_at = excluded.observed_at`,
      )
      .run(model, context, new Date().toISOString());
  }

  /** The window the CLI last reported for this exact model id; null when it never has. */
  modelWindow(model: string): number | null {
    const row = this.db.prepare('SELECT context FROM model_windows WHERE model = ?').get(model) as { context: number } | undefined;
    return row?.context ?? null;
  }

  // ---------- command durations ----------

  /** Records one command that ended; a call already recorded (a replayed event) is left as it was. */
  recordCommand(run: CommandRun): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO command_durations (kind, chat_id, tool_use_id, started_at, duration_ms, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.kind, run.chatId, run.toolUseId, run.startedAt, Math.round(run.durationMs), run.outcome);
    // Old runs say little about how long a command takes now, and the table must not grow for ever
    this.db.prepare('DELETE FROM command_durations WHERE id <= (SELECT MAX(id) FROM command_durations) - ?').run(KEEP_COMMANDS);
  }

  /** The newest runs of a kind, newest first. */
  commandRuns(kind: string, limit = 50): Array<{ durationMs: number; outcome: CommandOutcome; startedAt: string }> {
    const rows = this.db
      .prepare('SELECT duration_ms, outcome, started_at FROM command_durations WHERE kind = ? ORDER BY id DESC LIMIT ?')
      .all(kind, Math.min(Math.max(Math.trunc(limit), 1), 500)) as unknown as Array<{ duration_ms: number; outcome: CommandOutcome; started_at: string }>;
    return rows.map((r) => ({ durationMs: r.duration_ms, outcome: r.outcome, startedAt: r.started_at }));
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

  // ---------- supervisor proposals ----------

  /** False when the chat already has one for that signal: the supervisor answers each signal once. */
  saveProposal(p: SupervisorProposal): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO supervisor_proposals (id, chat_id, task_id, orchestration_id, signal, hint, cost_usd, at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.chatId, p.taskId ?? null, p.orchestrationId ?? null, p.signal, p.hint, p.costUsd, p.at, p.status);
    return Number(result.changes) > 0;
  }

  proposal(id: string): SupervisorProposal | null {
    const row = this.db.prepare('SELECT * FROM supervisor_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return row ? proposalOf(row) : null;
  }

  /** The chat's proposals, newest first. */
  proposalsOf(chatId: string): SupervisorProposal[] {
    const rows = this.db.prepare('SELECT * FROM supervisor_proposals WHERE chat_id = ? ORDER BY at DESC').all(chatId) as unknown as ProposalRow[];
    return rows.map(proposalOf);
  }

  /** Moves a proposal on from `proposed`; false when it had already been sent or dismissed. */
  settleProposal(id: string, status: Exclude<SupervisorProposalStatus, 'proposed'>): boolean {
    const result = this.db.prepare("UPDATE supervisor_proposals SET status = ? WHERE id = ? AND status = 'proposed'").run(status, id);
    return Number(result.changes) > 0;
  }

  // ---------- decisions ----------

  /** Stores a decision as the engine recorded it; the engine picks the id and the time. */
  insertDecision(d: DecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO decisions (id, point, kind, project_id, subject_kind, subject_id, provider, model, mode, status, unavailable,
           state, questions, answers, confidence, threshold, acted, visible, saved_run, latency_ms, input_tokens, cost_usd,
           outcome, agreed, resolved_at, feedback, feedback_at, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.point,
        d.kind,
        d.projectId,
        d.subjectKind,
        d.subjectId,
        d.provider,
        d.model,
        d.mode,
        d.status,
        d.unavailable,
        JSON.stringify(d.state),
        JSON.stringify(d.questions),
        d.answers ? JSON.stringify(d.answers) : null,
        d.confidence,
        d.threshold,
        d.acted ? 1 : 0,
        d.visible ? 1 : 0,
        d.savedRun ? 1 : 0,
        d.latencyMs,
        d.inputTokens,
        d.costUsd,
        d.outcome ? JSON.stringify(d.outcome) : null,
        d.agreed === null ? null : d.agreed ? 1 : 0,
        d.resolvedAt,
        d.feedback,
        d.feedbackAt,
        d.at,
      );
  }

  decision(id: string): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DecisionRow | undefined;
    return row ? decisionOf(row) : null;
  }

  /**
   * Records what really happened. A person's feedback outranks the inference, so `agreed` is left
   * alone once there is some. False when the row is gone or already has an outcome (a rating alone does not count): a point may report
   * twice, and the first word stands.
   */
  resolveDecision(id: string, outcome: DecisionResolution, at: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE decisions SET outcome = ?, resolved_at = COALESCE(resolved_at, ?), agreed = CASE WHEN feedback IS NULL THEN ? ELSE agreed END
         WHERE id = ? AND outcome IS NULL`,
      )
      .run(JSON.stringify(outcome), at, outcome.agreed ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  /**
   * Useful agrees with the answer and not useful disagrees (D13); the latest word replaces the last.
   * A person's word is also a resolution, so `resolved_at` is set unless something already set it.
   */
  setDecisionFeedback(id: string, feedback: DecisionFeedback, at: string): boolean {
    const result = this.db
      .prepare('UPDATE decisions SET feedback = ?, feedback_at = ?, agreed = ?, resolved_at = COALESCE(resolved_at, ?) WHERE id = ?')
      .run(feedback, at, feedback === 'useful' ? 1 : 0, at, id);
    return Number(result.changes) > 0;
  }

  /** Newest first. The cursor is the `seq` of the last row of the previous page. */
  listDecisions(query: DecisionPageQuery = {}): DecisionPage {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
    const { where, params } = decisionWhere(query);
    const cursor = query.cursor === undefined ? NaN : Number(query.cursor);
    if (Number.isInteger(cursor)) {
      where.push('seq < ?');
      params.push(cursor);
    }
    const rows = this.db
      .prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit + 1) as unknown as DecisionRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(decisionOf), nextCursor: rows.length > limit && last ? String(last.seq) : null };
  }

  /** Per point, over the rows since `since`; points with no row in the window are absent. */
  decisionStats(since: string): DecisionStats {
    const rows = this.db
      .prepare(
        `SELECT point,
           COUNT(*) AS count,
           COALESCE(SUM(acted), 0) AS acted,
           COALESCE(SUM(status = 'unavailable'), 0) AS unavailable,
           AVG(confidence) AS mean_confidence,
           COALESCE(SUM(resolved_at IS NOT NULL), 0) AS resolved,
           COALESCE(SUM(agreed = 1), 0) AS agreed,
           COALESCE(SUM(feedback = 'useful'), 0) AS useful,
           COALESCE(SUM(feedback = 'not_useful'), 0) AS not_useful,
           COALESCE(SUM(cost_usd), 0) AS cost_usd,
           COALESCE(SUM(acted = 1 AND saved_run = 1), 0) AS runs_saved
         FROM decisions WHERE at >= ? GROUP BY point ORDER BY point`,
      )
      .all(since) as unknown as Array<{
      point: string;
      count: number;
      acted: number;
      unavailable: number;
      mean_confidence: number | null;
      resolved: number;
      agreed: number;
      useful: number;
      not_useful: number;
      cost_usd: number;
      runs_saved: number;
    }>;
    const points: DecisionPointStats[] = rows.map((r) => ({
      point: r.point as DecisionPointId,
      count: r.count,
      acted: r.acted,
      unavailable: r.unavailable,
      meanConfidence: r.mean_confidence,
      resolved: r.resolved,
      agreed: r.agreed,
      useful: r.useful,
      notUseful: r.not_useful,
      costUsd: r.cost_usd,
      runsSaved: r.runs_saved,
    }));
    const jev = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM decisions WHERE at >= ? AND provider = 'jev'").get(since) as { n: number } | undefined;
    return {
      since,
      points,
      jevCostUsd: jev?.n ?? 0,
      claudeRunsSaved: points.reduce((sum, p) => sum + p.runsSaved, 0),
    };
  }

  /** The newest row of a point, for the consent preview's "what was sent last" (D12). */
  lastDecisionOf(point: DecisionPointId): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE point = ? ORDER BY seq DESC LIMIT 1').get(point) as DecisionRow | undefined;
    return row ? decisionOf(row) : null;
  }

  deleteDecision(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM decisions WHERE id = ?').run(id).changes) > 0;
  }

  /** Deletes the rows a filter matches; an empty filter clears the history. Returns how many went. */
  clearDecisions(filter: DecisionFilter = {}): number {
    const { where, params } = decisionWhere(filter);
    return Number(this.db.prepare(`DELETE FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).run(...params).changes);
  }

  /** Drops decisions older than `before`. Returns how many went. */
  pruneDecisions(before: string): number {
    return Number(this.db.prepare('DELETE FROM decisions WHERE at < ?').run(before).changes);
  }

  // ---------- push subscriptions ----------

  /**
   * Registers an install, or refreshes the one that already holds this endpoint. The row keeps the
   * `createdAt` of the first registration: a browser rotating its keys is the same device.
   */
  savePushSubscription(record: PushSubscriptionRecord): PushSubscriptionRecord {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, kinds, level, label, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh, auth = excluded.auth, kinds = excluded.kinds, level = excluded.level,
           label = excluded.label, last_seen_at = excluded.last_seen_at`,
      )
      .run(
        record.id,
        record.endpoint,
        record.p256dh,
        record.auth,
        JSON.stringify(record.kinds),
        record.level,
        record.label,
        record.createdAt,
        record.lastSeenAt,
      );
    return this.pushSubscription({ endpoint: record.endpoint }) ?? record;
  }

  /** Oldest first, which is the order the Settings list shows them in. */
  pushSubscriptions(): PushSubscriptionRecord[] {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as unknown as PushRow[];
    return rows.map(pushRecordOf);
  }

  pushSubscription(ref: { id?: string; endpoint?: string }): PushSubscriptionRecord | null {
    const row = ref.endpoint
      ? (this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(ref.endpoint) as PushRow | undefined)
      : ref.id
        ? (this.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(ref.id) as PushRow | undefined)
        : undefined;
    return row ? pushRecordOf(row) : null;
  }

  /** False when there was no such install, which is what a second unsubscribe of the same one is. */
  deletePushSubscription(ref: { id?: string; endpoint?: string }): boolean {
    const result = ref.endpoint
      ? this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(ref.endpoint)
      : ref.id
        ? this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(ref.id)
        : { changes: 0 };
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

/** `404` is one code, `4xx` its whole class; anything else is refused rather than matching nothing. */
function statusRange(status: string): [number, number] {
  const code = /^([1-5])(\d\d|xx)$/i.exec(status);
  if (!code?.[1] || !code[2]) throw new Error('status must be a code such as 404 or a class such as 4xx');
  const hundreds = Number(code[1]) * 100;
  if (code[2].toLowerCase() === 'xx') return [hundreds, hundreds + 99];
  const exact = hundreds + Number(code[2]);
  return [exact, exact];
}

/** One install that asked to be pushed to, with the endpoint and keys the sender needs. */
export interface PushSubscriptionRecord {
  /** Derived from the endpoint by the caller, so the same install always has the same id */
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  kinds: NotificationKind[];
  level: NotificationLevel;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

interface PushRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  kinds: string;
  level: string;
  label: string;
  created_at: string;
  last_seen_at: string;
}

function pushRecordOf(row: PushRow): PushSubscriptionRecord {
  let kinds: NotificationKind[] = [];
  try {
    const parsed: unknown = JSON.parse(row.kinds);
    if (Array.isArray(parsed)) kinds = parsed.filter((k): k is NotificationKind => KINDS.includes(k as NotificationKind));
  } catch {
    // a hand-edited row asking for nothing is better than one that breaks every send
  }
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    kinds,
    level: LEVELS.includes(row.level as NotificationLevel) ? (row.level as NotificationLevel) : DEFAULT_LEVEL,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

interface ProposalRow {
  id: string;
  chat_id: string;
  task_id: string | null;
  orchestration_id: string | null;
  signal: string;
  hint: string;
  cost_usd: number;
  at: string;
  status: string;
}

function proposalOf(row: ProposalRow): SupervisorProposal {
  return {
    id: row.id,
    chatId: row.chat_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.orchestration_id ? { orchestrationId: row.orchestration_id } : {}),
    signal: row.signal as HealthSignalKind,
    hint: row.hint,
    costUsd: row.cost_usd,
    at: row.at,
    status: row.status as SupervisorProposalStatus,
  };
}

interface DecisionRow {
  seq: number;
  id: string;
  point: string;
  kind: string;
  project_id: string | null;
  subject_kind: string;
  subject_id: string | null;
  provider: string;
  model: string;
  mode: string;
  status: string;
  unavailable: string | null;
  state: string;
  questions: string;
  answers: string | null;
  confidence: number | null;
  threshold: number | null;
  acted: number;
  visible: number;
  saved_run: number;
  latency_ms: number;
  input_tokens: number | null;
  cost_usd: number | null;
  outcome: string | null;
  agreed: number | null;
  resolved_at: string | null;
  feedback: string | null;
  feedback_at: string | null;
  at: string;
}

function decisionOf(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    point: row.point as DecisionPointId,
    kind: row.kind as DecisionPointKind,
    projectId: row.project_id,
    subjectKind: row.subject_kind as DecisionSubjectKind,
    subjectId: row.subject_id,
    provider: row.provider as DecisionProviderId,
    model: row.model,
    mode: row.mode as DecisionRecord['mode'],
    status: row.status as DecisionRecord['status'],
    unavailable: row.unavailable as DecisionUnavailableReason | null,
    state: JSON.parse(row.state) as Record<string, unknown>,
    questions: JSON.parse(row.questions) as DecisionQuestion[],
    answers: row.answers ? (JSON.parse(row.answers) as Record<string, DecisionAnswer>) : null,
    confidence: row.confidence,
    threshold: row.threshold,
    acted: row.acted === 1,
    visible: row.visible === 1,
    savedRun: row.saved_run === 1,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    costUsd: row.cost_usd,
    outcome: row.outcome ? (JSON.parse(row.outcome) as DecisionResolution) : null,
    agreed: row.agreed === null ? null : row.agreed === 1,
    resolvedAt: row.resolved_at,
    feedback: row.feedback as DecisionFeedback | null,
    feedbackAt: row.feedback_at,
    at: row.at,
  };
}

function decisionWhere(filter: DecisionFilter): { where: string[]; params: SQLInputValue[] } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const add = (clause: string, value: string | undefined) => {
    if (value === undefined) return;
    where.push(clause);
    params.push(value);
  };
  add('point = ?', filter.point);
  add('project_id = ?', filter.projectId);
  add('subject_kind = ?', filter.subjectKind);
  add('subject_id = ?', filter.subjectId);
  if (filter.visible) where.push('visible = 1');
  add('provider = ?', filter.provider);
  add('mode = ?', filter.mode);
  add('status = ?', filter.status);
  add('at >= ?', filter.since);
  add('at <= ?', filter.until);
  return { where, params };
}
