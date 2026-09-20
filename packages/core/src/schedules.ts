import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CreateScheduleRequest,
  NewChatRequest,
  OrchestrationSpec,
  Schedule,
  ScheduleRun,
  ScheduleRunStatus,
  SchedulePreview,
  ScheduleTarget,
  UpdateScheduleRequest,
} from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import { assertZone, describeCron, nextFire, nextFires, parseCron, serverZone } from './cron.ts';
import type { CoreConfig } from './paths.ts';

/** How often the scheduler looks at the clock. Only the slot it finds due matters, not this. */
const TICK_MS = 15_000;
/**
 * A slot this much older than the tick that finds it was passed while nothing was watching, and is
 * skipped. Deliberately about the size of a tick and not of an outage: a restart that spans a slot
 * must not fire it late, or "skipped, not replayed" would only hold for long outages.
 */
export const SLOT_GRACE_MS = 60_000;
/** Runs kept per schedule; a `* * * * *` schedule would otherwise grow the table without end. */
const KEEP_RUNS = 500;
/** Slots walked in one go when catching up after downtime; the rest are the same outage. */
const MAX_SLOTS_PER_TICK = 20_000;

/** What is stored in `schedules.json`: the definition, and nothing derived from the runs. */
interface StoredSchedule {
  id: string;
  name: string;
  cron: string;
  timezone?: string;
  target: ScheduleTarget;
  enabled: boolean;
  createdAt: string;
  /**
   * Slots at or before this are not this schedule's to fire. Set when it is created, enabled or
   * re-timed, so the time it spent switched off is never counted as missed.
   */
  armedAt: string;
}

/** What starting a target needs from the rest of core; kept as functions so this file depends on neither. */
export interface ScheduleLauncher {
  chat(request: NewChatRequest): Promise<{ id: string }>;
  orchestration(spec: OrchestrationSpec): { id: string };
}

interface RunRow {
  id: string;
  schedule_id: string;
  at: string;
  slot: string | null;
  status: ScheduleRunStatus;
  chat_id: string | null;
  orchestration_id: string | null;
  error: string | null;
}

const toRun = (row: RunRow): ScheduleRun => ({
  id: row.id,
  scheduleId: row.schedule_id,
  at: row.at,
  ...(row.slot ? { slot: row.slot } : {}),
  status: row.status,
  ...(row.chat_id ? { chatId: row.chat_id } : {}),
  ...(row.orchestration_id ? { orchestrationId: row.orchestration_id } : {}),
  ...(row.error ? { error: row.error } : {}),
});

/**
 * The history of what schedules did, as rows.
 *
 * It opens its own connection to `wrapper.db` and creates its table itself instead of joining the
 * numbered migrations in `db.ts`: those are a single ordered list every feature appends to, and this
 * table has no relation to any other, so it need not wait its turn in that list. Two wrapper
 * processes on one data dir share the file, which is why a slot is claimed by a unique key rather than
 * by anything held in memory.
 */
export class ScheduleRuns {
  private readonly db: DatabaseSync;

  constructor(config: CoreConfig) {
    this.db = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id               TEXT PRIMARY KEY,
        schedule_id      TEXT NOT NULL,
        at               TEXT NOT NULL,
        slot             TEXT,
        status           TEXT NOT NULL,
        chat_id          TEXT,
        orchestration_id TEXT,
        error            TEXT
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs (schedule_id, at DESC);
      -- One row per slot: this is what stops a slot from firing twice, across restarts and across
      -- processes. A run started by hand has no slot, and NULLs never collide.
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_slot ON schedule_runs (schedule_id, slot);
    `);
  }

  /** Writes the row that says "this slot is mine"; false when another row already has it. */
  claim(run: ScheduleRun): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO schedule_runs (id, schedule_id, at, slot, status, chat_id, orchestration_id, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.scheduleId, run.at, run.slot ?? null, run.status, run.chatId ?? null, run.orchestrationId ?? null, run.error ?? null);
    if (Number(result.changes) === 0) return false;
    this.db
      .prepare('DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY at DESC LIMIT ?)')
      .run(run.scheduleId, run.scheduleId, KEEP_RUNS);
    return true;
  }

  finish(id: string, outcome: Pick<ScheduleRun, 'status' | 'chatId' | 'orchestrationId' | 'error'>): void {
    this.db
      .prepare('UPDATE schedule_runs SET status = ?, chat_id = ?, orchestration_id = ?, error = ? WHERE id = ?')
      .run(outcome.status, outcome.chatId ?? null, outcome.orchestrationId ?? null, outcome.error ?? null, id);
  }

  /** Newest first. */
  list(scheduleId: string, limit = 50): ScheduleRun[] {
    const rows = this.db
      .prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(scheduleId, Math.min(Math.max(Math.trunc(limit), 1), KEEP_RUNS)) as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** The newest slot this schedule has an answer for, fired or skipped: where the next search starts. */
  lastSlot(scheduleId: string): string | null {
    const row = this.db.prepare('SELECT MAX(slot) AS slot FROM schedule_runs WHERE schedule_id = ?').get(scheduleId) as { slot: string | null } | undefined;
    return row?.slot ?? null;
  }

  /** When it last fired, by slot or by hand; a skipped slot is not a run. */
  lastFiredAt(scheduleId: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(at) AS at FROM schedule_runs WHERE schedule_id = ? AND status != 'skipped'")
      .get(scheduleId) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  removeAll(scheduleId: string): void {
    this.db.prepare('DELETE FROM schedule_runs WHERE schedule_id = ?').run(scheduleId);
  }

  close(): void {
    this.db.close();
  }
}

/** Reads a five-field expression and a zone, or throws saying which is wrong. */
function checked(cron: string, timezone: string | undefined): void {
  parseCron(cron);
  if (timezone) assertZone(timezone);
}

function checkedTarget(target: unknown): ScheduleTarget {
  if (!target || typeof target !== 'object') throw new Error('target is required');
  const t = target as Partial<ScheduleTarget>;
  if (t.kind === 'chat') {
    if (!t.chat || typeof t.chat.prompt !== 'string' || !t.chat.prompt.trim()) throw new Error('a chat target needs a prompt');
    return { kind: 'chat', chat: t.chat };
  }
  if (t.kind === 'orchestration') {
    if (!t.spec || !Array.isArray(t.spec.tasks) || t.spec.tasks.length === 0) throw new Error('an orchestration target needs at least one task');
    return { kind: 'orchestration', spec: t.spec };
  }
  throw new Error('target.kind must be "chat" or "orchestration"');
}

/** Says what an expression does without saving anything: what a form shows while it is being typed. */
export function previewCron(cron: string, timezone?: string, count = 5, now = Date.now()): SchedulePreview {
  const zone = timezone || serverZone();
  try {
    checked(cron, timezone);
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error), timezone: zone, next: [] };
  }
  const spec = parseCron(cron);
  return {
    valid: true,
    description: describeCron(spec),
    timezone: zone,
    next: nextFires(spec, now, Math.min(Math.max(Math.trunc(count), 1), 20), zone).map((t) => new Date(t).toISOString()),
  };
}

/**
 * Recurring chats and orchestrations.
 *
 * The definitions are a settings-shaped document, `schedules.json`, re-read whenever they are asked
 * for so a second process sees an edit. There is no timer per schedule: one tick looks at the clock,
 * and everything it needs to decide comes from the definitions and the run rows. That is what lets it
 * survive a restart with nothing to restore, and never fire a slot twice.
 */
export class Scheduler {
  private readonly file: string;
  private readonly runs: ScheduleRuns;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private closed = false;
  /** Writes wait their turn: two edits in flight would each read the file the other is about to replace */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    config: CoreConfig,
    private readonly launcher: ScheduleLauncher,
    private readonly clock: () => number = Date.now,
  ) {
    this.file = join(config.dataDir, 'schedules.json');
    mkdirSync(dirname(this.file), { recursive: true });
    this.runs = new ScheduleRuns(config);
  }

  // ---------- lifecycle ----------

  /** Looks at once, so a slot passed during the restart is judged at boot, then on a steady tick. */
  start(): void {
    // `close` may come first: the runtime restore that starts us can outlive a short-lived process
    if (this.timer || this.closed) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.runs.close();
  }

  // ---------- definitions ----------

  private read(): StoredSchedule[] {
    if (!existsSync(this.file)) return [];
    let doc: { schedules?: unknown };
    try {
      doc = JSON.parse(readFileSync(this.file, 'utf8')) as { schedules?: unknown };
    } catch {
      // Refusing beats starting from an empty list: the next save would erase every schedule
      throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    }
    if (!Array.isArray(doc.schedules)) return [];
    return doc.schedules.filter(
      (s): s is StoredSchedule => !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.cron === 'string' && !!s.target,
    );
  }

  private mutate<T>(change: (all: StoredSchedule[]) => T): Promise<T> {
    const next = this.writing.then(async () => {
      const all = this.read();
      const out = change(all);
      await writeAtomic(this.file, `${JSON.stringify({ schedules: all }, null, 2)}\n`);
      return out;
    });
    this.writing = next.catch(() => undefined);
    return next;
  }

  private view(stored: StoredSchedule, now = this.clock()): Schedule {
    let nextRunAt: string | null = null;
    if (stored.enabled) {
      const next = nextFire(parseCron(stored.cron), now, stored.timezone || serverZone());
      nextRunAt = next === null ? null : new Date(next).toISOString();
    }
    return {
      id: stored.id,
      name: stored.name,
      cron: stored.cron,
      ...(stored.timezone ? { timezone: stored.timezone } : {}),
      target: stored.target,
      enabled: stored.enabled,
      lastRunAt: this.runs.lastFiredAt(stored.id),
      nextRunAt,
      createdAt: stored.createdAt,
    };
  }

  list(): Schedule[] {
    return this.read()
      .map((s) => this.view(s))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private find(id: string): StoredSchedule {
    const stored = this.read().find((s) => s.id === id);
    if (!stored) throw new Error('schedule not found');
    return stored;
  }

  get(id: string): Schedule {
    return this.view(this.find(id));
  }

  async create(request: CreateScheduleRequest): Promise<Schedule> {
    const name = request.name?.trim();
    if (!name) throw new Error('name is required');
    if (typeof request.cron !== 'string') throw new Error('cron is required');
    checked(request.cron, request.timezone);
    const target = checkedTarget(request.target);
    const createdAt = new Date(this.clock()).toISOString();
    const stored: StoredSchedule = {
      id: randomUUID(),
      name,
      cron: request.cron.trim(),
      ...(request.timezone ? { timezone: request.timezone } : {}),
      target,
      enabled: request.enabled !== false,
      createdAt,
      armedAt: createdAt,
    };
    await this.mutate((all) => all.push(stored));
    return this.view(stored);
  }

  async update(id: string, request: UpdateScheduleRequest): Promise<Schedule> {
    const updated = await this.mutate((all) => {
      const stored = all.find((s) => s.id === id);
      if (!stored) throw new Error('schedule not found');
      let rearm = false;
      if (request.name !== undefined) {
        if (!request.name.trim()) throw new Error('name cannot be empty');
        stored.name = request.name.trim();
      }
      const cron = request.cron !== undefined ? request.cron.trim() : stored.cron;
      const timezone = request.timezone === undefined ? stored.timezone : request.timezone || undefined;
      checked(cron, timezone);
      if (cron !== stored.cron || timezone !== stored.timezone) rearm = true;
      stored.cron = cron;
      if (timezone) stored.timezone = timezone;
      else delete stored.timezone;
      if (request.target !== undefined) stored.target = checkedTarget(request.target);
      if (request.enabled !== undefined) {
        // Switching on starts the clock afresh: the hours it was off are not windows it missed
        if (request.enabled && !stored.enabled) rearm = true;
        stored.enabled = request.enabled;
      }
      if (rearm) stored.armedAt = new Date(this.clock()).toISOString();
      return { ...stored };
    });
    return this.view(updated);
  }

  async remove(id: string): Promise<void> {
    await this.mutate((all) => {
      const index = all.findIndex((s) => s.id === id);
      if (index < 0) throw new Error('schedule not found');
      all.splice(index, 1);
    });
    this.runs.removeAll(id);
  }

  history(id: string, limit?: number): ScheduleRun[] {
    this.find(id);
    return this.runs.list(id, limit);
  }

  // ---------- firing ----------

  /** Starts the schedule's target now, outside its timetable. Works while it is disabled. */
  async runNow(id: string): Promise<ScheduleRun> {
    const stored = this.find(id);
    return this.fire(stored, null);
  }

  /**
   * One pass over every enabled schedule. Safe to call at any time and from several processes: what
   * it fires is decided by the unique slot each run claims, not by who asked.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock();
      for (const stored of this.read().filter((s) => s.enabled)) {
        try {
          await this.settle(stored, now);
        } catch {
          // a schedule whose expression no longer parses must not stop the others
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Decides what the slots that have come due since the last answer mean. The newest one fires when
   * it is fresh; every older one was passed while nothing was watching, and is recorded once as
   * skipped, not fired: a week of missed slots run at once is never what anyone meant.
   */
  private async settle(stored: StoredSchedule, now: number): Promise<void> {
    const spec = parseCron(stored.cron);
    const zone = stored.timezone || serverZone();
    let cursor = Date.parse(this.runs.lastSlot(stored.id) ?? stored.armedAt);
    if (!Number.isFinite(cursor)) return;
    cursor = Math.max(cursor, Date.parse(stored.armedAt));

    const due: number[] = [];
    for (let i = 0; i < MAX_SLOTS_PER_TICK; i++) {
      const next = nextFire(spec, cursor, zone);
      if (next === null || next > now) break;
      due.push(next);
      cursor = next;
    }
    if (due.length === 0) return;

    const newest = due[due.length - 1] as number;
    const fresh = now - newest <= SLOT_GRACE_MS;
    const missed = fresh ? due.slice(0, -1) : due;
    if (missed.length > 0) this.skip(stored, missed, now);
    if (fresh) await this.fire(stored, new Date(newest).toISOString());
  }

  /** One row for the whole outage, keyed by its last slot so the next search starts after it. */
  private skip(stored: StoredSchedule, slots: number[], now: number): void {
    const first = new Date(slots[0] as number).toISOString();
    const last = new Date(slots[slots.length - 1] as number).toISOString();
    this.runs.claim({
      id: randomUUID(),
      scheduleId: stored.id,
      at: new Date(now).toISOString(),
      slot: last,
      status: 'skipped',
      error:
        slots.length === 1
          ? `The ${first} slot passed while Agentry was not running, so it was skipped, not run late.`
          : `${slots.length} slots between ${first} and ${last} passed while Agentry was not running, so they were skipped, not run late.`,
    });
  }

  private async fire(stored: StoredSchedule, slot: string | null): Promise<ScheduleRun> {
    const run: ScheduleRun = {
      id: randomUUID(),
      scheduleId: stored.id,
      at: new Date(this.clock()).toISOString(),
      ...(slot ? { slot } : {}),
      status: 'started',
    };
    // Claimed before launching: a crash in between leaves a run that started nothing, which is
    // better than a chat that starts twice
    if (!this.runs.claim(run)) return run;
    try {
      const outcome =
        stored.target.kind === 'chat'
          ? { chatId: (await this.launcher.chat(stored.target.chat)).id }
          : { orchestrationId: this.launcher.orchestration(stored.target.spec).id };
      this.runs.finish(run.id, { status: 'started', ...outcome });
      return { ...run, ...outcome };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runs.finish(run.id, { status: 'failed', error: message });
      return { ...run, status: 'failed', error: message };
    }
  }
}
