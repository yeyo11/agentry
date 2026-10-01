import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TranscriptUnavailable } from '../transcripts.ts';

/**
 * The migration ids OpenCode 1.18.34 records in its own `migration` table (`PRAGMA user_version`
 * stays 0), in order. The store reads when these are a prefix of what it finds; a recording task
 * adds each newer version's set.
 */
export const PINNED_MIGRATIONS: readonly string[] = [
  '20260127222353_familiar_lady_ursula',
  '20260211171708_add_project_commands',
  '20260213144116_wakeful_the_professor',
  '20260225215848_workspace',
  '20260227213759_add_session_workspace_id',
  '20260228203230_blue_harpoon',
  '20260303231226_add_workspace_fields',
  '20260309230000_move_org_to_state',
  '20260312043431_session_message_cursor',
  '20260323234822_events',
  '20260410174513_workspace-name',
  '20260413175956_chief_energizer',
  '20260423070820_add_icon_url_override',
  '20260427172553_slow_nightmare',
  '20260428004200_add_session_path',
  '20260501142318_next_venus',
  '20260504145000_add_sync_owner',
  '20260507164347_add_workspace_time',
  '20260510033149_session_usage',
  '20260511000411_data_migration_state',
  '20260511173437_session-metadata',
  '20260601010001_normalize_storage_paths',
  '20260601202201_amazing_prowler',
  '20260602002951_lowly_union_jack',
  '20260602182828_add_project_directories',
  '20260603001617_session_message_projection_indexes',
  '20260603040000_session_message_projection_order',
  '20260603141458_session_input_inbox',
  '20260603160727_jittery_ezekiel_stane',
  '20260604172448_event_sourced_session_input',
  '20260605003541_add_session_context_snapshot',
  '20260605042240_add_context_epoch_agent',
  '20260611035744_credential',
  '20260611192811_lush_chimera',
  '20260612174303_project_dir_strategy',
  '20260622142730_simplify_session_context_epoch',
  '20260622170816_reset_v2_session_state',
  '20260622202450_simplify_session_input',
];

/** The columns the store selects, per table: one missing makes the schema untested. */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session: [
    'id', 'directory', 'title', 'model', 'cost', 'time_created', 'time_updated', 'parent_id',
    'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write', 'time_archived',
  ],
  message: ['id', 'session_id', 'time_created', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_created', 'data'],
  session_message: ['id', 'session_id', 'type', 'seq', 'time_created', 'data'],
};

const RETRY_DELAYS_MS = [50, 150, 400];
const BUSY_TIMEOUT_MS = 250;

/**
 * Where OpenCode keeps its database: `OPENCODE_DB` when set, else `opencode.db` in its data
 * directory, `opencode-<channel>.db` when the channel is not latest, beta or prod. Never asks the
 * CLI (`opencode db path` creates and migrates the file).
 */
export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env, channel: string | null = null): string {
  const override = env['OPENCODE_DB'];
  if (override) return override;
  const dataHome = env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  const named = channel && !['latest', 'beta', 'prod'].includes(channel) ? `opencode-${channel.replace(/[^\w.-]/g, '-')}.db` : 'opencode.db';
  return join(dataHome, 'opencode', named);
}

/** `degraded`: migrations newer than the pinned set exist, the pinned ones still read. */
export type SchemaState = 'ok' | 'degraded';

const isBusy = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  const code = (e as { errcode?: unknown }).errcode;
  // SQLITE_BUSY is 5 and SQLITE_LOCKED 6; the extended codes keep them in the low byte
  if (typeof code === 'number') return (code & 0xff) === 5 || (code & 0xff) === 6;
  return /database (table )?is (locked|busy)/i.test(e.message);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads the migration table and the columns the store needs; throws `schema-untested` when they do not match. */
function checkSchema(db: DatabaseSync): SchemaState {
  let ids: string[];
  try {
    ids = db.prepare('SELECT id FROM migration ORDER BY id').all().map((r) => String(r['id']));
  } catch (e) {
    if (isBusy(e)) throw e;
    throw new TranscriptUnavailable('schema-untested');
  }
  if (ids.length < PINNED_MIGRATIONS.length || PINNED_MIGRATIONS.some((id, i) => ids[i] !== id)) {
    throw new TranscriptUnavailable('schema-untested');
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    // the table name is one of our own constants, never input
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r['name'])));
    if (columns.some((c) => !have.has(c))) throw new TranscriptUnavailable('schema-untested');
  }
  return ids.length > PINNED_MIGRATIONS.length ? 'degraded' : 'ok';
}

export function dbExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * One short read: opens the database read-only, runs `fn` in one transaction, closes it. Never
 * `immutable` (it would ignore the WAL), never a checkpoint or a write, and never held open across
 * calls, so OpenCode's own checkpoints are not stopped. A busy database is retried with backoff,
 * then answers `busy`.
 */
export async function readDb<T>(path: string, fn: (db: DatabaseSync, schema: SchemaState) => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec('PRAGMA query_only = 1');
      db.exec('BEGIN');
      const schema = checkSchema(db);
      return fn(db, schema);
    } catch (e) {
      if (!isBusy(e)) throw e;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw new TranscriptUnavailable('busy');
      await sleep(delay);
    } finally {
      // closing ends the read transaction; there is nothing to commit
      try {
        db?.close();
      } catch {
        // never opened
      }
    }
  }
}
