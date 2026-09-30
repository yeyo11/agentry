import { randomUUID } from 'node:crypto';
import type {
  DecisionAnswer,
  DecisionMode,
  DecisionPointId,
  DecisionPointInfo,
  DecisionProviderId,
  DecisionQuestion,
  DecisionRecord,
  DecisionResolution,
  DecisionSettings,
  DecisionUnavailableReason,
  ProjectDecisionSettings,
} from '@agentry/shared';
import type { Db } from '../db.ts';
import { decisionPoint, DECISION_POINTS, type DecisionPointDefinition, type DecisionSubject } from './points.ts';
import { redactState, stateBytes } from './redact.ts';
import { DEFAULT_THRESHOLD, JEV_MODEL, type DecisionSettingsStore } from './settings.ts';

/** What a provider is asked: the redacted state and the typed questions, one batch, one call */
export interface DecisionRequest {
  point: DecisionPointId;
  state: Record<string, unknown>;
  questions: ReadonlyArray<DecisionQuestion>;
}

export type ProviderResult =
  | { status: 'answered'; answers: Record<string, DecisionAnswer>; latencyMs: number; inputTokens: number | null; costUsd: number | null; model: string }
  | { status: 'unavailable'; reason: DecisionUnavailableReason; latencyMs: number };

export interface DecisionProvider {
  readonly id: DecisionProviderId;
  /** True when a call can be made now (the CLI is found and has quota; a Jev key is saved) */
  available(): boolean;
  /** Why `available()` is false; the engine falls back to a per-provider default when absent */
  whyUnavailable?(): DecisionUnavailableReason;
  ask(request: DecisionRequest, opts: { deadlineMs: number; signal: AbortSignal }): Promise<ProviderResult>;
}

export interface DecisionOutcome {
  /** Null when the point is off, or nothing was asked */
  decisionId: string | null;
  /** The mode in force after project, then global, then the default */
  mode: DecisionMode;
  /** True only when the caller should act on `answers` */
  act: boolean;
  /** Set only when `act` is true: a shadow answer never reaches a call site's behaviour */
  answers: Record<string, DecisionAnswer> | null;
}

export interface DecisionEngineDeps {
  settings: DecisionSettingsStore;
  db: Pick<Db, 'insertDecision' | 'resolveDecision' | 'lastDecisionOf' | 'pruneDecisions'>;
  /** A project's own overrides, read from its settings document */
  projectDecisions: (projectId: string) => ProjectDecisionSettings | null;
  now?: () => Date;
}

/** A provider that has not answered by then is unavailable; Jev is fast, the CLI is background work */
export const DEADLINE_MS: Readonly<Record<DecisionProviderId, number>> = { jev: 1_500, cli: 30_000 };

export interface EffectiveDecision {
  mode: DecisionMode;
  threshold: number;
  provider: DecisionProviderId;
  consent: NonNullable<DecisionSettings['points'][DecisionPointId]>['consent'];
  /** Active in name only: an act point on `cli` never clears a threshold, and a point without consent asks nothing */
  limited: boolean;
}

const OUTCOME_OFF = (mode: DecisionMode = 'off'): DecisionOutcome => ({ decisionId: null, mode, act: false, answers: null });

/**
 * The one door every decision goes through. It resolves the settings, gates on consent, builds and
 * redacts the state, asks a provider under a deadline, records the row and says whether the caller
 * should act. It never throws into the caller: whatever goes wrong is today's behaviour.
 */
export class DecisionEngine {
  private readonly providers = new Map<DecisionProviderId, DecisionProvider>();
  private readonly deps: DecisionEngineDeps;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(deps: DecisionEngineDeps) {
    this.deps = deps;
  }

  register(provider: DecisionProvider): void {
    this.providers.set(provider.id, provider);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Project override, then global, then the point's own default (D8); consent is always global */
  effective(point: DecisionPointId, projectId: string | null, settings: DecisionSettings = this.deps.settings.get()): EffectiveDecision {
    const def = decisionPoint(point);
    const global = settings.points[point];
    const project = def?.scope === 'project' && projectId ? this.deps.projectDecisions(projectId) : null;
    const override = project?.points?.[point];
    const provider = project?.provider && project.provider !== 'inherit' ? project.provider : settings.provider;
    const mode = override?.mode ?? global?.mode ?? 'off';
    const threshold = override?.threshold ?? global?.threshold ?? def?.defaultThreshold ?? DEFAULT_THRESHOLD;
    const consent = global?.consent ?? null;
    const consented = !!def && !!consent && consent.stateVersion === def.stateVersion && consent.providers.includes(provider);
    // The CLI has no calibrated confidence, and the palette needs a provider that answers in a blink
    const limited = mode === 'active' && (!consented || (def?.kind === 'act' && provider === 'cli'));
    return { mode, threshold, provider, consent, limited };
  }

  /** The catalogue with the settings in force for a scope (`GET /decisions/points`) */
  catalogue(projectId: string | null): DecisionPointInfo[] {
    const settings = this.deps.settings.get();
    return DECISION_POINTS.map((def) => ({
      id: def.id,
      kind: def.kind,
      scope: def.scope,
      primitives: [...def.primitives],
      defaultThreshold: def.defaultThreshold,
      savesRun: def.savesRun,
      needsLowLatency: def.needsLowLatency,
      stateVersion: def.stateVersion,
      effective: this.effective(def.id, projectId, settings),
    }));
  }

  /** The state a subject would send, built and redacted locally and never sent (D12) */
  async previewState(point: DecisionPointId, subject: DecisionSubject): Promise<{ state: Record<string, unknown>; bytes: number } | null> {
    const def = decisionPoint(point);
    if (!def) return null;
    const state = redactState(await def.buildState(subject), def.maxStateBytes);
    return { state, bytes: stateBytes(state) };
  }

  /** The state of the point's latest request, exactly as it was sent */
  lastState(point: DecisionPointId): { state: Record<string, unknown>; bytes: number; provider: DecisionProviderId } | null {
    const last = this.deps.db.lastDecisionOf(point);
    return last ? { state: last.state, bytes: stateBytes(last.state), provider: last.provider } : null;
  }

  async ask(point: DecisionPointId, subject: DecisionSubject, scope: { projectId: string | null }): Promise<DecisionOutcome> {
    try {
      return await this.run(point, subject, scope.projectId);
    } catch {
      // A decision is an aid: a bug in one must leave the caller on today's behaviour
      return OUTCOME_OFF();
    }
  }

  private async run(point: DecisionPointId, subject: DecisionSubject, projectId: string | null): Promise<DecisionOutcome> {
    const def = decisionPoint(point);
    if (!def) return OUTCOME_OFF();
    const settings = this.deps.settings.get();
    const eff = this.effective(point, projectId, settings);
    if (eff.mode === 'off') return OUTCOME_OFF();
    // No consent for this state shape and provider: nothing is built, nothing is asked (D12)
    const consent = eff.consent;
    if (!consent || consent.stateVersion !== def.stateVersion || !consent.providers.includes(eff.provider)) return OUTCOME_OFF();
    if (def.needsLowLatency && eff.provider !== 'jev') return OUTCOME_OFF();

    const questions = def.questions(subject);
    if (questions.length === 0 || !questionsValid(questions)) return OUTCOME_OFF(eff.mode);
    const state = redactState(await def.buildState(subject), def.maxStateBytes);
    const mode: 'shadow' | 'active' = eff.mode === 'active' ? 'active' : 'shadow';

    const provider = this.providers.get(eff.provider);
    const model = eff.provider === 'jev' ? JEV_MODEL : settings.cli.model;
    let result: ProviderResult;
    if (!provider || !provider.available()) {
      result = { status: 'unavailable', reason: provider?.whyUnavailable?.() ?? (eff.provider === 'jev' ? 'no-key' : 'server-error'), latencyMs: 0 };
    } else {
      result = await this.call(provider, { point, state, questions }, DEADLINE_MS[eff.provider]);
      if (result.status === 'answered' && !answersValid(questions, result.answers)) {
        result = { status: 'unavailable', reason: 'invalid-answer', latencyMs: result.latencyMs };
      }
    }

    const answered = result.status === 'answered';
    const answers = result.status === 'answered' ? result.answers : null;
    const confidence = answers ? lowestConfidence(answers) : null;
    // An act point acts above its threshold, and a null confidence never clears one. A suggestion
    // is prepared for a person to decide, so an answer is enough
    const act = answered && mode === 'active' && (def.kind === 'suggest' || (confidence !== null && confidence >= eff.threshold));

    const id = randomUUID();
    const row: DecisionRecord = {
      id,
      point,
      kind: def.kind,
      projectId: def.scope === 'project' ? projectId : null,
      subjectKind: subject.kind,
      subjectId: subject.id,
      provider: eff.provider,
      model: result.status === 'answered' ? result.model : model,
      mode,
      status: result.status,
      unavailable: result.status === 'unavailable' ? result.reason : null,
      state,
      questions: [...questions],
      answers,
      confidence,
      threshold: def.kind === 'act' ? eff.threshold : null,
      acted: act,
      visible: act && def.visible,
      savedRun: act && def.savesRun,
      latencyMs: Math.round(result.latencyMs),
      inputTokens: result.status === 'answered' ? result.inputTokens : null,
      costUsd: result.status === 'answered' ? result.costUsd : null,
      outcome: null,
      agreed: null,
      resolvedAt: null,
      feedback: null,
      feedbackAt: null,
      at: this.now().toISOString(),
    };
    try {
      this.deps.db.insertDecision(row);
    } catch {
      // A history row that cannot be written is not a reason to change what happens
      return { decisionId: null, mode: eff.mode, act, answers: act ? answers : null };
    }
    return { decisionId: id, mode: eff.mode, act, answers: act ? answers : null };
  }

  /** Runs the provider under the deadline; whatever it does short of answering is unavailable */
  private async call(provider: DecisionProvider, request: DecisionRequest, deadlineMs: number): Promise<ProviderResult> {
    const started = Date.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<ProviderResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: 'unavailable', reason: 'timeout', latencyMs: Date.now() - started });
      }, deadlineMs);
    });
    try {
      const asked = provider.ask(request, { deadlineMs, signal: controller.signal }).catch(
        (): ProviderResult => ({ status: 'unavailable', reason: 'server-error', latencyMs: Date.now() - started }),
      );
      return await Promise.race([asked, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Called by the point when what happened becomes known (shadow accuracy) */
  resolve(decisionId: string, outcome: DecisionResolution): void {
    try {
      this.deps.db.resolveDecision(decisionId, outcome, this.now().toISOString());
    } catch {
      // The database may be closed at shutdown
    }
  }

  /** Drops the rows older than `historyDays`; returns how many went */
  prune(): number {
    const days = this.deps.settings.get().historyDays;
    return this.deps.db.pruneDecisions(new Date(this.now().getTime() - days * 86_400_000).toISOString());
  }

  /** Prunes now and once a day (D9) */
  startPruning(): void {
    if (this.pruneTimer) return;
    const tick = (): void => {
      try {
        this.prune();
      } catch {
        // Closed database: the next start prunes
      }
    };
    tick();
    this.pruneTimer = setInterval(tick, 86_400_000);
    this.pruneTimer.unref();
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }
}

/** The lowest confidence of the batch; null when any answer has none (the CLI) */
export function lowestConfidence(answers: Record<string, DecisionAnswer>): number | null {
  let lowest: number | null = null;
  for (const answer of Object.values(answers)) {
    if (answer.confidence === null) return null;
    lowest = lowest === null ? answer.confidence : Math.min(lowest, answer.confidence);
  }
  return lowest;
}

function questionsValid(questions: ReadonlyArray<DecisionQuestion>): boolean {
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q.id || seen.has(q.id)) return false;
    seen.add(q.id);
    if (q.kind === 'choice' && (q.options.length < 2 || q.options.length > 255)) return false;
    if (q.kind === 'score' && (q.levels.length < 2 || q.levels.length > 10)) return false;
  }
  return true;
}

/** Every question answered, with the right kind, a value that is one of its options or levels, and a confidence in range */
function answersValid(questions: ReadonlyArray<DecisionQuestion>, answers: Record<string, DecisionAnswer>): boolean {
  for (const q of questions) {
    const a = answers[q.id];
    if (!a || a.kind !== q.kind) return false;
    if (a.confidence !== null && !(a.confidence >= 0 && a.confidence <= 1)) return false;
    if (q.kind === 'choice' && !q.options.some((o) => o.id === a.value)) return false;
    if (q.kind === 'score' && !q.levels.some((l) => l.id === a.value)) return false;
    if (q.kind === 'noul' && typeof a.value !== 'boolean') return false;
  }
  return true;
}

export type { DecisionPointDefinition, DecisionSubject };
