import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CreateScheduleRequest,
  NewChatRequest,
  OrchestrationSpec,
  Schedule,
  ScheduleChangeAction,
  ScheduleOverlap,
  ScheduleRun,
  ScheduleRunStatus,
  SchedulePreview,
  ScheduleTarget,
  UpdateScheduleRequest,
} from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import { assertZone, describeCron, nextFire, nextFires, parseCron, serverZone } from './cron.ts';
import type { EventBus } from './events.ts';
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
  /** Absent in files written before there was a choice, which is `parallel` */
  overlap?: ScheduleOverlap;
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
  /**
   * Whether what a run started is still going: its chat working or its orchestration running. Without
   * it nothing ever counts as still going, so every overlap policy behaves as `parallel`.
   */
  running?(run: Pick<ScheduleRun, 'chatId' | 'orchestrationId'>): boolean;
}

const OVERLAPS: readonly ScheduleOverlap[] = ['parallel', 'skip', 'queue'];

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

  /**
   * Starts a queued run: true for the one caller that moved it from `queued`, so two processes (or a
   * tick and a drain) never launch it twice. `at` becomes the moment it started; `slot` stays.
   */
  take(id: string, at: string): boolean {
    const result = this.db.prepare("UPDATE schedule_runs SET status = 'started', at = ? WHERE id = ? AND status = 'queued'").run(at, id);
    return Number(result.changes) > 0;
  }

  /** Every queued run of a schedule but `keep` becomes `overlapped` with `error`; returns the ones it changed. */
  supersede(scheduleId: string, keep: string | null, error: string): ScheduleRun[] {
    const rows = this.db
      .prepare("UPDATE schedule_runs SET status = 'overlapped', error = ? WHERE schedule_id = ? AND status = 'queued' AND id IS NOT ? RETURNING *")
      .all(error, scheduleId, keep) as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** Runs waiting for the one before them to end, oldest first. */
  queued(): ScheduleRun[] {
    const rows = this.db.prepare("SELECT * FROM schedule_runs WHERE status = 'queued' ORDER BY at, rowid").all() as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** The newest run that launched something: the one an overlap policy asks about. */
  lastLaunched(scheduleId: string): ScheduleRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM schedule_runs WHERE schedule_id = ? AND status = 'started' AND (chat_id IS NOT NULL OR orchestration_id IS NOT NULL) ORDER BY at DESC, rowid DESC LIMIT 1",
      )
      .get(scheduleId) as RunRow | undefined;
    return row ? toRun(row) : null;
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

  /** When it last fired, by slot or by hand; a slot it skipped, set aside or is still holding is not a run. */
  lastFiredAt(scheduleId: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(at) AS at FROM schedule_runs WHERE schedule_id = ? AND status IN ('started', 'failed')")
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

function checkedOverlap(overlap: unknown): ScheduleOverlap {
  if (!OVERLAPS.includes(overlap as ScheduleOverlap)) throw new Error('overlap must be "parallel", "skip" or "queue"');
  return overlap as ScheduleOverlap;
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
  /**
   * Schedules this process is launching a run for. Between claiming a run and learning the chat or
   * orchestration it started there is nothing in the rows to say it is going, so an overlap check
   * in that window asks here.
   */
  private readonly launching = new Set<string>();
  /** Where `schedule.changed` and `schedule.fired` go; the API's global feed */
  bus: Pick<EventBus, 'emit'> | null = null;

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
    // A new process computes every next fire afresh; a client that followed the old one refetches
    for (const stored of this.read().filter((s) => s.enabled)) this.changed(stored, 'rescheduled');
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
      overlap: stored.overlap ?? 'parallel',
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
      overlap: request.overlap === undefined ? 'parallel' : checkedOverlap(request.overlap),
      createdAt,
      armedAt: createdAt,
    };
    await this.mutate((all) => all.push(stored));
    return this.changed(stored, 'created');
  }

  async update(id: string, request: UpdateScheduleRequest): Promise<Schedule> {
    let action: ScheduleChangeAction = 'updated';
    const updated = await this.mutate((all) => {
      const stored = all.find((s) => s.id === id);
      if (!stored) throw new Error('schedule not found');
      let rearm = false;
      if (request.overlap !== undefined) stored.overlap = checkedOverlap(request.overlap);
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
        // Switching is what the event names even when other fields changed with it: it is the one a
        // person following the list cares about
        if (request.enabled !== stored.enabled) action = request.enabled ? 'enabled' : 'disabled';
        stored.enabled = request.enabled;
      }
      if (rearm) stored.armedAt = new Date(this.clock()).toISOString();
      return { ...stored };
    });
    return this.changed(updated, action);
  }

  async remove(id: string): Promise<void> {
    const removed = await this.mutate((all) => {
      const index = all.findIndex((s) => s.id === id);
      if (index < 0) throw new Error('schedule not found');
      return all.splice(index, 1)[0] as StoredSchedule;
    });
    this.runs.removeAll(id);
    this.bus?.emit({
      type: 'schedule.changed',
      title: `Schedule ${removed.name} deleted`,
      scheduleId: removed.id,
      scheduleName: removed.name,
      action: 'deleted',
      nextRunAt: null,
    });
  }

  // ---------- events ----------

  /** Announces a change to a schedule that still exists, and returns it as the API shows it. */
  private changed(stored: StoredSchedule, action: Exclude<ScheduleChangeAction, 'deleted'>): Schedule {
    const view = this.view(stored);
    const when = view.nextRunAt ? `next run ${view.nextRunAt}` : 'no next run';
    const titles: Record<typeof action, string> = {
      created: `Schedule ${view.name} created`,
      updated: `Schedule ${view.name} edited`,
      enabled: `Schedule ${view.name} switched on`,
      disabled: `Schedule ${view.name} switched off`,
      rescheduled: `Schedule ${view.name}: ${when}`,
    };
    this.bus?.emit({ type: 'schedule.changed', title: titles[action], scheduleId: view.id, scheduleName: view.name, action, nextRunAt: view.nextRunAt });
    return view;
  }

  /** Announces a run row as it now stands: written, started, or set aside. */
  private fired(stored: StoredSchedule, run: ScheduleRun): ScheduleRun {
    const titles: Record<ScheduleRunStatus, string> = {
      started: `Schedule ${stored.name} started its ${stored.target.kind}`,
      failed: `Schedule ${stored.name} could not start: ${run.error ?? 'unknown error'}`,
      skipped: `Schedule ${stored.name} skipped slots missed while Agentry was down`,
      overlapped: `Schedule ${stored.name} did not start a slot: ${run.error ?? 'the last run was still going'}`,
      queued: `Schedule ${stored.name} will start when its last run ends`,
    };
    this.bus?.emit({
      type: 'schedule.fired',
      title: titles[run.status],
      scheduleId: stored.id,
      scheduleName: stored.name,
      runId: run.id,
      status: run.status,
      chatId: run.chatId ?? null,
      orchestrationId: run.orchestrationId ?? null,
    });
    return run;
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
      // A queue that is ready goes first, so a slot due in this same pass finds it started
      await this.drain().catch(() => undefined);
      const now = this.clock();
      for (const stored of this.read().filter((s) => s.enabled)) {
        try {
          if (await this.settle(stored, now)) this.changed(stored, 'rescheduled');
        } catch {
          // a schedule whose expression no longer parses must not stop the others
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Starts every queued run whose predecessor has ended. Called on each tick and whenever a chat or
   * an orchestration stops, so a queued slot does not wait for the next tick to follow its
   * predecessor. A run whose schedule was switched off, or no longer queues, is set aside instead:
   * what it was waiting for is not what the schedule says any more.
   */
  async drain(): Promise<void> {
    if (this.closed) return;
    const queued = this.runs.queued();
    if (queued.length === 0) return;
    const schedules = new Map(this.read().map((s) => [s.id, s]));
    for (const run of queued) {
      const stored = schedules.get(run.scheduleId);
      if (!stored) continue; // deleted: its rows are going with it
      if (!stored.enabled || (stored.overlap ?? 'parallel') !== 'queue') {
        const reason = stored.enabled ? 'The schedule stopped queueing' : 'The schedule was switched off';
        for (const dropped of this.runs.supersede(stored.id, null, `${reason} before this slot could start.`)) this.fired(stored, dropped);
        continue;
      }
      if (this.busy(stored.id)) continue;
      const at = new Date(this.clock()).toISOString();
      if (!this.runs.take(run.id, at)) continue; // another process started it
      await this.launch(stored, { ...run, at, status: 'started' });
    }
  }

  /**
   * Decides what the slots that have come due since the last answer mean. The newest one fires when
   * it is fresh; every older one was passed while nothing was watching, and is recorded once as
   * skipped, not fired: a week of missed slots run at once is never what anyone meant.
   */
  private async settle(stored: StoredSchedule, now: number): Promise<boolean> {
    const spec = parseCron(stored.cron);
    const zone = stored.timezone || serverZone();
    let cursor = Date.parse(this.runs.lastSlot(stored.id) ?? stored.armedAt);
    if (!Number.isFinite(cursor)) return false;
    cursor = Math.max(cursor, Date.parse(stored.armedAt));

    const due: number[] = [];
    for (let i = 0; i < MAX_SLOTS_PER_TICK; i++) {
      const next = nextFire(spec, cursor, zone);
      if (next === null || next > now) break;
      due.push(next);
      cursor = next;
    }
    if (due.length === 0) return false;

    const newest = due[due.length - 1] as number;
    const fresh = now - newest <= SLOT_GRACE_MS;
    const missed = fresh ? due.slice(0, -1) : due;
    if (missed.length > 0) this.skip(stored, missed, now);
    if (fresh) await this.answer(stored, new Date(newest).toISOString());
    return true;
  }

  /** Whether the last run this schedule launched is still going, by what the launcher can see. */
  private busy(scheduleId: string): boolean {
    if (this.launching.has(scheduleId)) return true;
    const last = this.runs.lastLaunched(scheduleId);
    return !!last && !!this.launcher.running?.(last);
  }

  /** A fresh slot, through the schedule's overlap policy. */
  private async answer(stored: StoredSchedule, slot: string): Promise<void> {
    const overlap = stored.overlap ?? 'parallel';
    const replaced = `Replaced by the ${slot} slot before it could start.`;
    if (overlap === 'parallel' || !this.busy(stored.id)) {
      // A queued run still waiting when its predecessor has already ended is older news than this slot
      for (const dropped of this.runs.supersede(stored.id, null, replaced)) this.fired(stored, dropped);
      await this.fire(stored, slot);
      return;
    }
    const run: ScheduleRun = { id: randomUUID(), scheduleId: stored.id, at: new Date(this.clock()).toISOString(), slot, status: 'overlapped' };
    if (overlap === 'skip') {
      run.error = `The ${slot} slot came while the last run was still going, so it was not started.`;
      if (this.runs.claim(run)) this.fired(stored, run);
      return;
    }
    run.status = 'queued';
    if (!this.runs.claim(run)) return;
    // One pending at most: the newest slot is the one that will run
    for (const dropped of this.runs.supersede(stored.id, run.id, replaced)) this.fired(stored, dropped);
    this.fired(stored, run);
  }

  /** One row for the whole outage, keyed by its last slot so the next search starts after it. */
  private skip(stored: StoredSchedule, slots: number[], now: number): void {
    const first = new Date(slots[0] as number).toISOString();
    const last = new Date(slots[slots.length - 1] as number).toISOString();
    const run: ScheduleRun = {
      id: randomUUID(),
      scheduleId: stored.id,
      at: new Date(now).toISOString(),
      slot: last,
      status: 'skipped',
      error:
        slots.length === 1
          ? `The ${first} slot passed while Agentry was not running, so it was skipped, not run late.`
          : `${slots.length} slots between ${first} and ${last} passed while Agentry was not running, so they were skipped, not run late.`,
    };
    if (this.runs.claim(run)) this.fired(stored, run);
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
    return this.launch(stored, run);
  }

  /** Starts the target for a run that is already claimed, and records what came of it. */
  private async launch(stored: StoredSchedule, run: ScheduleRun): Promise<ScheduleRun> {
    this.launching.add(stored.id);
    try {
      const outcome =
        stored.target.kind === 'chat'
          ? { chatId: (await this.launcher.chat(stored.target.chat)).id }
          : { orchestrationId: this.launcher.orchestration(stored.target.spec).id };
      this.runs.finish(run.id, { status: 'started', ...outcome });
      return this.fired(stored, { ...run, ...outcome });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runs.finish(run.id, { status: 'failed', error: message });
      return this.fired(stored, { ...run, status: 'failed', error: message });
    } finally {
      this.launching.delete(stored.id);
    }
  }
}
