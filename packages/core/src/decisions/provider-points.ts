import type { DatabaseSync } from 'node:sqlite';
import type { LimitAction, ProviderId } from '@agentry/shared';
import type { DecisionOutcome } from './engine.ts';
import type { DecisionAsker } from './stance.ts';

/*
 * The three provider points (docs/plans/multi-provider.md, phase 4, "The decision points"). The
 * rotation, the launches of automated work and the mapping editor hand a subject to the method of the
 * point and get back what the person's settings allow: a call site decides by arithmetic which options
 * are feasible and allowed, and the point only chooses among them. Every answer is checked against
 * those options here, so a point can never name an action, a provider or a model outside them.
 */

/** A provider's readiness as the question states it: the first three candidates are sent */
export interface CandidateSummary {
  id: ProviderId;
  label: string;
  /** The model the work would run on there, after mapping */
  model: string;
  /** 0..100, or null when the provider reports none */
  utilization: number | null;
  resetsInMin: number | null;
}

export type WorkKind = 'flow-run' | 'task' | 'assistant';

/** The kinds of subject the rotation and the launches decide about; a person's chat never is one (P4-2) */
export type WorkSubjectKind = 'flow_run' | 'task' | 'assistant_run';

export interface WorkSubject {
  kind: WorkSubjectKind;
  /** The run's id, or `<orchestration id>:<task id>` for a task, as the resolvers read it */
  id: string;
  projectId: string | null;
  work: { kind: WorkKind; name: string };
}

export interface OnLimitSubject extends WorkSubject {
  /** The chat that hit the limit: one answer per limit hit */
  chatId: string;
  progress: { checklistDone: number; checklistTotal: number; filesChanged: number; turns: number; minutes: number };
  from: { provider: ProviderId; model: string | null; resetsInMin: number | null };
  candidates: CandidateSummary[];
  /** The feasible actions the person allowed; the options are these and nothing else */
  allowed: LimitAction[];
}

/** What a candidate did in this project over the last 30 days for this stage or kind of work */
export interface PickCandidate extends CandidateSummary {
  history?: { passed: number; failed: number };
}

export interface PickSubject extends WorkSubject {
  title: string;
  sizeEstimate?: string | null;
  model: string | null;
  candidates: PickCandidate[];
}

export interface ModelMapSubject {
  from: { provider: ProviderId; model: string; name?: string; tier?: string | null; description?: string | null };
  target: ProviderId;
  /** The target's catalog; the point sees at most 40 */
  targets: Array<{ id: string; name: string; tier?: string | null; description?: string | null; efforts?: string[] }>;
}

export interface ProviderPointsDeps {
  decisions: DecisionAsker;
  sql: DatabaseSync;
  now?: () => number;
}

/** A model-map question is asked at most once per pair a day */
const MODEL_MAP_EVERY_MS = 24 * 60 * 60 * 1000;
const SUMMARIES = 3;

const ACTIONS: readonly LimitAction[] = ['handoff', 'restart', 'wait'];

export const modelMapSubjectId = (provider: ProviderId, model: string, target: ProviderId): string => `${provider}:${model}→${target}`;

export class ProviderPoints {
  private readonly pending = new Set<Promise<unknown>>();
  /** `<chat>`: a limit hit already put to the point in this process */
  private readonly askedLimits = new Set<string>();
  private readonly askedPairs = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ProviderPointsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Resolves when every question under way has finished; for tests and a clean shutdown */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * What `provider.on-limit` chooses for automated work that hit its provider's limit, among the
   * feasible actions the person allowed. Null leaves the setting's action in force: the point is off,
   * shadow (the answer is recorded and `watch` asks in the background), unavailable, below its
   * threshold, or there was nothing to choose between. `decisionId` goes on the move row.
   */
  async onLimit(stance: 'off' | 'watch' | 'wait', subject: OnLimitSubject): Promise<{ action: LimitAction; decisionId: string } | null> {
    if (stance === 'off') return null;
    const allowed = ACTIONS.filter((a) => subject.allowed.includes(a));
    // A point is not asked when there is only one option, and one limit hit is asked once
    if (allowed.length < 2 || this.askedLimits.has(subject.chatId)) return null;
    this.askedLimits.add(subject.chatId);
    const data = {
      work: { kind: subject.work.kind, name: subject.work.name },
      progress: subject.progress,
      from: subject.from,
      candidates: subject.candidates.slice(0, SUMMARIES).map(summarize),
      allowed,
    };
    const asked = this.ask('provider.on-limit', { kind: subject.kind, id: subject.id, data }, subject.projectId);
    if (stance === 'watch') {
      this.track(asked);
      return null;
    }
    const outcome = await asked;
    const answer = outcome?.act ? outcome.answers?.action : undefined;
    if (!outcome?.decisionId || answer?.kind !== 'choice') return null;
    const action = allowed.find((a) => a === answer.value);
    return action ? { action, decisionId: outcome.decisionId } : null;
  }

  /**
   * What `provider.pick` chooses for work about to start, among the candidates that passed the filter.
   * Null leaves the first candidate in the order, which is what the setting picks.
   */
  async pick(stance: 'off' | 'watch' | 'wait', subject: PickSubject): Promise<{ provider: ProviderId; decisionId: string } | null> {
    if (stance === 'off' || subject.candidates.length < 2) return null;
    const data = {
      work: { kind: subject.work.kind, name: subject.work.name, title: subject.title, sizeEstimate: subject.sizeEstimate ?? null },
      model: subject.model,
      candidates: subject.candidates.map((c) => ({ ...summarize(c), ...(c.history ? { history: c.history } : {}) })),
    };
    const asked = this.ask('provider.pick', { kind: subject.kind, id: subject.id, data }, subject.projectId);
    if (stance === 'watch') {
      this.track(asked);
      return null;
    }
    const outcome = await asked;
    const answer = outcome?.act ? outcome.answers?.provider : undefined;
    if (!outcome?.decisionId || answer?.kind !== 'choice') return null;
    // An answer outside the candidates is dropped, whatever the engine validated
    const chosen = subject.candidates.find((c) => c.id === answer.value);
    return chosen ? { provider: chosen.id, decisionId: outcome.decisionId } : null;
  }

  /**
   * Asks `provider.model-map` for a counterpart of a model that has none on the target. A limit or a
   * pick that finds `no-mapping` asks at most once per pair a day; a person pressing Suggest passes
   * `force`. The answer is a suggestion, never a mapping: it returns as a decision row for the editor
   * to show, and only a person's accept writes an entry. Returns the suggested model, or null.
   */
  async suggestMapping(stance: 'off' | 'watch' | 'wait', subject: ModelMapSubject, opts: { force?: boolean } = {}): Promise<string | null> {
    if (stance === 'off' || subject.targets.length === 0) return null;
    const id = modelMapSubjectId(subject.from.provider, subject.from.model, subject.target);
    const now = this.now();
    if (!opts.force && this.askedToday(id, now)) return null;
    this.askedPairs.set(id, now);
    const data = {
      model: { provider: subject.from.provider, id: subject.from.model, name: subject.from.name ?? subject.from.model, tier: subject.from.tier ?? null, description: subject.from.description ?? null },
      target: subject.target,
      targets: subject.targets.slice(0, 40).map((t) => ({ id: t.id, name: t.name, tier: t.tier ?? null, description: t.description ?? null, efforts: t.efforts ?? [] })),
    };
    const asked = this.ask('provider.model-map', { kind: 'model', id, data }, null);
    if (stance === 'watch') {
      this.track(asked);
      return null;
    }
    const outcome = await asked;
    const answer = outcome?.act ? outcome.answers?.counterpart : undefined;
    if (answer?.kind !== 'choice') return null;
    return subject.targets.some((t) => t.id === answer.value) ? answer.value : null;
  }

  /** The pair was asked less than a day ago, in this process or (a restart) in the decisions' history */
  private askedToday(id: string, now: number): boolean {
    const last = this.askedPairs.get(id);
    if (last !== undefined && now - last < MODEL_MAP_EVERY_MS) return true;
    try {
      const since = new Date(now - MODEL_MAP_EVERY_MS).toISOString();
      return !!this.deps.sql.prepare("SELECT 1 FROM decisions WHERE point = 'provider.model-map' AND subject_id = ? AND at >= ? LIMIT 1").get(id, since);
    } catch {
      return false;
    }
  }

  private async ask(point: 'provider.on-limit' | 'provider.pick' | 'provider.model-map', subject: { kind: 'flow_run' | 'task' | 'assistant_run' | 'model'; id: string; data: Record<string, unknown> }, projectId: string | null): Promise<DecisionOutcome | null> {
    try {
      return await this.deps.decisions.ask(point, subject, { projectId });
    } catch {
      // A decision is an aid: the setting decides without it
      return null;
    }
  }

  private track(work: Promise<unknown>): void {
    const run = work.catch(() => undefined);
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }
}

function summarize(c: CandidateSummary): CandidateSummary {
  return { id: c.id, label: c.label, model: c.model, utilization: c.utilization, resetsInMin: c.resetsInMin };
}
