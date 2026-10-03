import { randomUUID } from 'node:crypto';
import type { LimitAction, ModelOption, ProjectProvidersSettings, ProviderId, ProviderLimit, ProviderMove, ProviderMoveDecider, ProvidersSettings, ProviderStatus, RotationSettings } from '@agentry/shared';
import { effortsOf, type ChatService, type ChatWork } from './chat-service.ts';
import type { ChatManager, ChatRuntime } from './chats.ts';
import { LEGACY_PROVIDER } from './chat-records.ts';
import type { Db } from './db.ts';
import { modelMapSubject, type OnLimitSubject, type ProviderPoints, type WorkKind, type WorkSubjectKind } from './decisions/provider-points.ts';
import { stanceOf, type DecisionAsker } from './decisions/stance.ts';
import type { AgentryEventInput } from './events.ts';
import { runRef } from './event-sources.ts';
import type { CandidateContext, CandidateProvider, CandidateResult } from './providers/candidates.ts';
import { defaultRotationSettings } from './providers/settings.ts';

/*
 * What happens when a provider reaches its usage limit (docs/plans/multi-provider.md, phase 4,
 * "What happens at a limit"). The chat manager announces `limit-hit` once per attempt; this decides.
 *
 * - A person's chat is left alone (decision P4-2): it gets a banner, and nothing spends on another
 *   vendor without a click. `waitFor` and `cancel` are what that click calls for a wait.
 * - Automated work follows the effective setting (the project's, else the global one), and
 *   `provider.on-limit` may choose among the feasible actions the person allowed. `wait` is the floor:
 *   it stands in for any action that cannot happen, and it needs nothing but the chat.
 * - A wait is a row in `provider_moves`. A timer in the process that owns the chat claims it at the
 *   reset with a guarded update, so two processes on one data directory replay the turn once, and
 *   `recover()` re-arms the timers of a restarted process.
 */

/** A reset is taken as passed a moment late: the provider's own clock may differ from ours */
const RESET_SLACK_MS = 5_000;
/** With no known reset the wait looks again this often: a reading from another chat may end it */
const POLL_MS = 5 * 60_000;
/** How long a claim holds a wait before another process may take it again */
const CLAIM_MS = 2 * 60_000;
/** `setTimeout` takes a signed 32-bit number */
const MAX_TIMER_MS = 2 ** 31 - 1;
const HOUR_MS = 3_600_000;

/** What a chat is told once its wait has ended and no turn of its own is left to replay */
const CONTINUE_TEXT = "The provider's usage limit has reset. Continue the work you were doing where you left off.";

export type WaitEnd = 'resumed' | 'failed' | 'cancelled';

export interface RotationDeps {
  db: Pick<Db, 'insertProviderMove' | 'providerMove' | 'claimProviderMove' | 'closeProviderMove' | 'openProviderMoves'>;
  runtime: Pick<ChatManager, 'on' | 'off' | 'get' | 'limits' | 'providers' | 'replayLastTurn' | 'send' | 'notice' | 'heldToSchema' | 'limitComing'>;
  chats: Pick<ChatService, 'candidates' | 'continueOn'>;
  /** `providers.json`, as it stands now */
  settings: () => ProvidersSettings;
  /** A project's own providers settings; null when it sets none */
  projectProviders: (projectId: string) => ProjectProvidersSettings | null;
  /** The project a directory belongs to */
  projectOf: (dir: string) => string | null;
  decisions: DecisionAsker | null;
  points: ProviderPoints | null;
  emit: (event: AgentryEventInput) => void;
  /**
   * The run, task or item a chat works for; null for a person's chat. Automated work moves only with
   * this and `repoint`: a move needs somebody to point the run at the new chat.
   */
  work?: (chatId: string) => ChatWork | null;
  /** Called after automated work moved: re-points the run or the task at the new chat */
  repoint?: (move: ProviderMove) => void;
  /** A run held to a schema is waited on only when whoever started it waits for the chat (a flow run) */
  awaiting?: (chatId: string) => boolean;
  /** A wait is over: the turn was replayed, it could not be, or a person stopped waiting */
  ended?: (move: ProviderMove, end: WaitEnd, reason: string | null) => void;
  now?: () => number;
  /** How often a wait with no known reset looks again; five minutes by default */
  pollMs?: number;
  /** How long after a reset the turn is replayed; five seconds by default */
  slackMs?: number;
}

/** What the rotation settings say for one project: its overrides on the global block. */
export function effectiveOnLimit(settings: Pick<ProvidersSettings, 'rotation'>, project: ProjectProvidersSettings | null): RotationSettings['onLimit'] {
  const base = (settings.rotation ?? defaultRotationSettings()).onLimit;
  return { ...base, ...(project?.onLimit ?? {}) };
}

/** What the registry, the detector and the limits say of every provider, in the shape the candidates read. */
export function candidateContext(
  runtime: Pick<ChatManager, 'providers' | 'limits'>,
  input: { settings: ProvidersSettings; project: ProjectProvidersSettings | null; statuses: readonly ProviderStatus[]; now?: number },
): CandidateContext {
  const providers: Record<ProviderId, CandidateProvider | undefined> = {};
  for (const manifest of runtime.providers.list()) {
    const status = input.statuses.find((s) => s.id === manifest.id);
    if (!status) continue;
    const driver = runtime.providers.driverFor(manifest.id);
    providers[manifest.id] = {
      status: { ...status, limit: runtime.limits.get(manifest.id) ?? status.limit ?? null },
      hasDriver: driver !== null,
      capabilities: runtime.providers.capabilities(manifest.id),
      translate: driver ? (policy) => driver.translatePolicy(policy) : null,
      models: driver?.models() ?? [],
      efforts: effortsOf(manifest.id, runtime.providers.capabilities(manifest.id)),
    };
  }
  return { settings: input.settings, project: input.project, providers, now: input.now ?? Date.now() };
}

const WORK_KIND: Record<WorkSubjectKind, WorkKind> = { flow_run: 'flow-run', task: 'task', assistant_run: 'assistant' };

export class ProviderRotation {
  /** Move id → its timer */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Chat id → the open wait it is in */
  private readonly waits = new Map<string, string>();
  /** Chats whose limit is being decided now */
  private readonly handling = new Set<string>();
  /** A reset learned from a later reading, for a wait that began without one: move id → ISO time */
  private readonly learned = new Map<string, string>();
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly slackMs: number;
  private readonly listener = (run: ChatRuntime, limit: ProviderLimit | null): void => {
    void this.onLimitHit(run, limit);
  };
  private started = false;

  constructor(private readonly deps: RotationDeps) {
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? POLL_MS;
    this.slackMs = deps.slackMs ?? RESET_SLACK_MS;
  }

  /** Starts listening for `limit-hit`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.runtime.on('limit-hit', this.listener);
  }

  close(): void {
    if (this.started) this.deps.runtime.off('limit-hit', this.listener);
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.waits.clear();
  }

  /**
   * Whether the rotation has taken over a chat's limit: a decision under way, a wait, or a limit
   * about to be announced for automated work. What a flow run waits on rather than fail.
   */
  holds(chatId: string): boolean {
    if (this.handling.has(chatId) || this.waits.has(chatId)) return true;
    const run = this.deps.runtime.get(chatId);
    return !!run && this.deps.runtime.limitComing(chatId) && this.isAutomated(run, this.deps.work?.(chatId) ?? null);
  }

  /** The open wait a chat is in, if any. */
  waitOf(chatId: string): string | null {
    return this.waits.get(chatId) ?? null;
  }

  // ---------- at a limit ----------

  /** A person's chat is not automated work: it asks (P4-2). The decision engine's own chats never move. */
  private isAutomated(run: ChatRuntime, work: ChatWork | null): boolean {
    if (work) return true;
    if (run.origin === 'internal') return false;
    if (run.orchestrationId) return true;
    return this.deps.runtime.heldToSchema(run.id);
  }

  /** Announces the limit and, for automated work, acts on it. Never throws: it runs from an event. */
  async onLimitHit(run: ChatRuntime, limit: ProviderLimit | null): Promise<void> {
    const provider = run.provider ?? LEGACY_PROVIDER;
    this.deps.emit({ type: 'run.rateLimited', title: `${run.name} hit its rate limit`, ...runRef(run), provider, resetsAt: limit?.resetsAt ?? null });
    const work = this.deps.work?.(run.id) ?? null;
    if (!this.isAutomated(run, work)) return;
    this.handling.add(run.id);
    try {
      // A run held to a schema that nobody waits for already handed its result over: replaying the
      // turn would spend for nobody. The flow registers its wait just after the limit is announced.
      if (!work && (run.orchestrationId || this.deps.runtime.heldToSchema(run.id))) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (run.orchestrationId || !this.deps.awaiting?.(run.id)) {
          this.deps.runtime.notice(run.id, `${provider} reached its usage limit; this turn is not replayed.`);
          return;
        }
      }
      await this.act(run, work, limit);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.deps.runtime.notice(run.id, `Handling the usage limit failed: ${why}`);
      // Flows and tasks keep the run open while the rotation holds it: with neither a move nor a
      // wait behind it, nothing would ever end it. Waiting is the floor every action falls back to.
      if (!this.waits.has(run.id)) {
        try {
          this.startWait(run, work, { decidedBy: 'setting', decisionId: null, reason: `handling the limit failed: ${why}`, resetsAt: limit?.resetsAt ?? null, projectId: null });
        } catch {
          /* the notice above is all that is left to say */
        }
      }
    } finally {
      this.handling.delete(run.id);
    }
  }

  private async act(run: ChatRuntime, work: ChatWork | null, limit: ProviderLimit | null): Promise<void> {
    const projectId = this.deps.projectOf(run.workingDir ?? run.cwd);
    const settings = this.deps.settings();
    const onLimit = effectiveOnLimit(settings, projectId ? this.deps.projectProviders(projectId) : null);
    const movable = work !== null && this.deps.repoint !== undefined;
    let candidates: CandidateResult | null = null;
    if (movable) {
      try {
        candidates = this.deps.chats.candidates(run.id);
      } catch {
        candidates = null;
      }
    }
    const canMove = !!candidates && candidates.candidates.length > 0 && !candidates.movesCapped;
    // `wait` is the floor, and an action the person did not allow is never taken
    const allowed = onLimit.allowed.filter((a) => a === 'wait' || canMove);
    let action: LimitAction = allowed.includes(onLimit.action) ? onLimit.action : 'wait';
    let decidedBy: ProviderMoveDecider = 'setting';
    let decisionId: string | null = null;
    let reason: string | null = onLimit.action !== 'wait' && !canMove ? this.whyNoMove(candidates, movable) : null;

    const stance = stanceOf(this.deps.decisions, 'provider.on-limit', projectId);
    if (work && candidates && stance !== 'off' && allowed.length >= 2 && this.deps.points && work.subjectKind !== 'chat') {
      // A decision that cannot be had leaves the setting in charge, as an unanswered one does
      const answer = await this.deps.points.onLimit(stance, this.onLimitSubject(run, work, projectId, limit, candidates, allowed)).catch(() => null);
      if (answer) {
        action = answer.action;
        decidedBy = 'decision';
        decisionId = answer.decisionId;
      }
    }

    if (action !== 'wait' && candidates && canMove) {
      const first = candidates.candidates[0];
      if (first) {
        try {
          const { move } = await this.deps.chats.continueOn(run.id, { provider: first.provider, action, ...(first.model ? { model: first.model } : {}) }, { decidedBy, decisionId, reason: null, resetsAt: limit?.resetsAt ?? null });
          try {
            this.deps.repoint?.(move);
          } catch (error) {
            // The work already lives on in the new chat: waiting on the old one would run it twice
            this.deps.runtime.notice(run.id, `The work moved to ${first.provider}, but pointing it at the new chat failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        } catch (error) {
          // The floor: a move that cannot happen waits instead of failing the run
          reason = `the move to ${first.provider} failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    if (candidates) this.suggestMappings(run, candidates);
    this.startWait(run, work, { decidedBy, decisionId, reason, resetsAt: limit?.resetsAt ?? null, projectId });
  }

  private whyNoMove(candidates: CandidateResult | null, movable: boolean): string {
    if (!movable) return 'this work cannot be moved from here';
    if (!candidates) return 'no provider could be asked';
    if (candidates.movesCapped) return 'the work has made all the moves it may';
    const missing = candidates.excluded.find((e) => e.excluded === 'no-mapping');
    if (missing) return `no counterpart is mapped for its model on ${missing.provider}`;
    return 'no other provider can take it';
  }

  private onLimitSubject(run: ChatRuntime, work: ChatWork, projectId: string | null, limit: ProviderLimit | null, candidates: CandidateResult, allowed: LimitAction[]): OnLimitSubject {
    const subjectKind = work.subjectKind as WorkSubjectKind;
    const minutesTo = (iso: string | null | undefined): number | null => (iso ? Math.max(0, Math.round((Date.parse(iso) - this.now()) / 60_000)) : null);
    const label = (id: ProviderId): string => this.deps.runtime.providers.list().find((m) => m.id === id)?.label ?? id;
    return {
      kind: subjectKind,
      id: work.subjectId,
      projectId,
      work: { kind: WORK_KIND[subjectKind], name: run.name },
      chatId: run.id,
      progress: { checklistDone: 0, checklistTotal: 0, filesChanged: 0, turns: run.turns, minutes: Math.max(0, Math.round((this.now() - Date.parse(run.createdAt)) / 60_000)) },
      from: { provider: run.provider ?? LEGACY_PROVIDER, model: run.model, resetsInMin: minutesTo(limit?.resetsAt) },
      candidates: candidates.candidates.slice(0, 3).map((c) => ({
        id: c.provider,
        label: label(c.provider),
        model: c.model ?? '',
        utilization: c.utilization === null ? null : Math.round(c.utilization * 100),
        resetsInMin: minutesTo(c.resetsAt),
      })),
      allowed,
    };
  }

  /** A run that waits for want of a counterpart asks the model-map point, once per pair a day. */
  private suggestMappings(run: ChatRuntime, candidates: CandidateResult): void {
    const points = this.deps.points;
    const model = run.model;
    if (!points || !model) return;
    const stance = stanceOf(this.deps.decisions, 'provider.model-map', null);
    if (stance === 'off') return;
    const from = run.provider ?? LEGACY_PROVIDER;
    const own: ModelOption[] = this.deps.runtime.providers.driverFor(from)?.models() ?? [];
    for (const excluded of candidates.excluded) {
      if (excluded.excluded !== 'no-mapping') continue;
      const subject = modelMapSubject({ provider: from, model }, excluded.provider, own, this.deps.runtime.providers.driverFor(excluded.provider)?.models() ?? []);
      void points.suggestMapping(stance, subject).catch(() => undefined);
    }
  }

  // ---------- waiting ----------

  /**
   * Starts a wait for the chat's provider to reset: what a person's click on "Wait for the reset"
   * does, and the floor of automated work. Null when the chat already has an open wait.
   */
  waitFor(chatId: string, decidedBy: ProviderMoveDecider = 'person'): ProviderMove | null {
    const run = this.deps.runtime.get(chatId);
    if (!run) throw new Error('chat not found');
    const limit = this.deps.runtime.limits.get(run.provider ?? LEGACY_PROVIDER);
    const work = this.deps.work?.(chatId) ?? null;
    const projectId = this.deps.projectOf(run.workingDir ?? run.cwd);
    return this.startWait(run, work, { decidedBy, decisionId: null, reason: null, resetsAt: limit?.resetsAt ?? null, projectId });
  }

  private startWait(run: ChatRuntime, work: ChatWork | null, opts: { decidedBy: ProviderMoveDecider; decisionId: string | null; reason: string | null; resetsAt: string | null; projectId: string | null }): ProviderMove | null {
    const at = new Date(this.now()).toISOString();
    const provider = run.provider ?? LEGACY_PROVIDER;
    const move: ProviderMove = {
      id: randomUUID(),
      at,
      subjectKind: work?.subjectKind ?? 'chat',
      subjectId: work?.subjectId ?? run.id,
      projectId: opts.projectId,
      fromChat: run.id,
      toChat: null,
      fromProvider: provider,
      toProvider: null,
      fromModel: run.model,
      toModel: null,
      action: 'wait',
      state: 'waiting',
      decidedBy: opts.decidedBy,
      decisionId: opts.decisionId,
      resetsAt: opts.resetsAt,
      reason: opts.reason,
      updatedAt: at,
    };
    if (!this.deps.db.insertProviderMove(move)) return null;
    this.waits.set(run.id, move.id);
    this.arm(move);
    const label = this.deps.runtime.providers.list().find((m) => m.id === provider)?.label ?? provider;
    this.deps.runtime.notice(
      run.id,
      move.resetsAt
        ? `${label} reached its usage limit. Waiting for it to reset at ${move.resetsAt}; the turn goes on then.${opts.reason ? ` (${opts.reason})` : ''}`
        : `${label} reached its usage limit and gave no reset time. Waiting up to ${this.maxWaitHours(move)} h; the turn goes on when it does.${opts.reason ? ` (${opts.reason})` : ''}`,
    );
    this.deps.emit({ type: 'run.limitWaiting', title: `${run.name} waits for ${label}'s limit to reset`, ...runRef(run), provider, resetsAt: move.resetsAt });
    return move;
  }

  private maxWaitHours(move: ProviderMove): number {
    const project = move.projectId ? this.deps.projectProviders(move.projectId) : null;
    return effectiveOnLimit(this.deps.settings(), project).maxWaitHours;
  }

  /** Sets the timer of a wait: the reset when it is known, otherwise the next look. */
  private arm(move: ProviderMove): void {
    const existing = this.timers.get(move.id);
    if (existing) clearTimeout(existing);
    const now = this.now();
    const reset = move.resetsAt ?? this.learned.get(move.id) ?? null;
    const cap = Date.parse(move.at) + this.maxWaitHours(move) * HOUR_MS;
    const due = reset ? Date.parse(reset) + this.slackMs : Math.min(now + this.pollMs, cap);
    const timer = setTimeout(() => void this.tick(move.id), Math.min(Math.max(0, due - now), MAX_TIMER_MS));
    timer.unref();
    this.timers.set(move.id, timer);
  }

  private drop(move: Pick<ProviderMove, 'id' | 'fromChat'>): void {
    const timer = this.timers.get(move.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(move.id);
    this.learned.delete(move.id);
    if (this.waits.get(move.fromChat) === move.id) this.waits.delete(move.fromChat);
  }

  private async tick(id: string): Promise<void> {
    try {
      const row = this.deps.db.providerMove(id);
      if (!row || (row.state !== 'waiting' && row.state !== 'resuming')) {
        this.drop(row ?? { id, fromChat: '' });
        return;
      }
      const now = this.now();
      const reset = row.resetsAt ?? this.learned.get(id) ?? null;
      if (reset) {
        if (now >= Date.parse(reset) + this.slackMs) await this.resume(row);
        else this.arm(row);
        return;
      }
      // No reset is known: a later reading (another chat's, another process's) may say when it is, or that it is over
      const limit = this.deps.runtime.limits.get(row.fromProvider);
      if (limit?.resetsAt) {
        this.learned.set(id, limit.resetsAt);
        this.arm(row);
        return;
      }
      if (limit && limit.state !== 'exhausted' && Date.parse(limit.observedAt) > Date.parse(row.at)) {
        await this.resume(row);
        return;
      }
      if (now >= Date.parse(row.at) + this.maxWaitHours(row) * HOUR_MS) this.end(row, 'failed', 'limit-wait-expired');
      else this.arm(row);
    } catch {
      // A closed database (shutting down) is not the wait's to report
    }
  }

  /** Claims the wait and replays the turn on the same chat and provider. Only the claim's winner replays. */
  private async resume(row: ProviderMove): Promise<void> {
    const run = this.deps.runtime.get(row.fromChat);
    if (!run) {
      // Not this process's chat: whoever owns it arms its own timer
      this.drop(row);
      return;
    }
    const claimedAt = this.now();
    if (!this.deps.db.claimProviderMove(row.id, new Date(claimedAt).toISOString(), new Date(claimedAt + CLAIM_MS).toISOString())) {
      this.drop(row);
      return;
    }
    let replayed = false;
    let reason: string | null = null;
    try {
      replayed = await this.deps.runtime.replayLastTurn(run.id);
      // A restart forgot the turn that was cut off: the session resumes with a nudge instead
      if (!replayed) {
        this.deps.runtime.send(run.id, CONTINUE_TEXT);
        replayed = true;
      }
    } catch (error) {
      reason = `its turn could not be resumed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (replayed) this.deps.runtime.notice(run.id, 'The usage limit reset: the turn goes on.');
    else this.deps.runtime.notice(run.id, 'The usage limit reset, but the turn could not be resumed automatically; send it again.');
    this.end(row, replayed ? 'resumed' : 'failed', replayed ? null : reason);
  }

  private end(row: ProviderMove, end: WaitEnd, reason: string | null): boolean {
    const state = end === 'resumed' ? 'resumed' : end === 'failed' ? 'failed' : 'cancelled';
    const closed = this.deps.db.closeProviderMove(row.id, state, new Date(this.now()).toISOString(), { reason });
    this.drop(row);
    if (!closed) return false;
    if (end === 'failed') this.deps.runtime.notice(row.fromChat, reason === 'limit-wait-expired' ? 'The wait for the usage limit to reset ran out.' : `The wait ended: ${reason ?? 'it failed'}.`);
    this.deps.ended?.({ ...row, state, reason: reason ?? row.reason }, end, reason);
    return true;
  }

  /**
   * A person moved a waiting chat to another provider: the wait closes into the move, quietly. The
   * work goes on in the new chat, so nothing is told it ended. False when the wait was not open.
   */
  supersede(moveId: string, by: Pick<ProviderMove, 'toChat' | 'toProvider' | 'toModel'>): boolean {
    const row = this.deps.db.providerMove(moveId);
    if (!row || (row.state !== 'waiting' && row.state !== 'resuming')) return false;
    const closed = this.deps.db.closeProviderMove(moveId, 'cancelled', new Date(this.now()).toISOString(), { ...by, reason: 'moved' });
    this.drop(row);
    return closed;
  }

  /** A person stops waiting; the run or task it belonged to then ends stopped. False when the wait was not open. */
  cancel(moveId: string): boolean {
    const row = this.deps.db.providerMove(moveId);
    if (!row || (row.state !== 'waiting' && row.state !== 'resuming')) return false;
    return this.end(row, 'cancelled', 'stopped waiting');
  }

  /**
   * Arms the timers of the waits whose chat this process restored, after a start-up. A claim whose
   * time ran out is taken again; a wait whose reset passed while the process was down resumes now.
   */
  recover(): void {
    const nowIso = new Date(this.now()).toISOString();
    for (const row of this.deps.db.openProviderMoves(nowIso)) {
      if (!this.deps.runtime.get(row.fromChat) || this.timers.has(row.id)) continue;
      this.waits.set(row.fromChat, row.id);
      this.arm(row);
    }
  }
}
