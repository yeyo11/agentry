import type {
  CandidateView,
  Exclusion,
  ModelOption,
  PolicyTranslation,
  ProjectProvidersSettings,
  ProviderCapability,
  ProviderId,
  ProviderStatus,
  ProvidersSettings,
  ToolPolicy,
} from '@agentry/shared';
import { mapModel } from './model-map.ts';

/** What a run needs from the provider that takes it. */
export interface RunNeeds {
  kind: 'chat' | 'flow-run' | 'task' | 'assistant' | 'decision';
  /** The provider and model the work is on now; null when it has not started */
  from: { provider: ProviderId; model: string | null } | null;
  /** The model the work asks for, and the provider whose catalog it comes from */
  model: { provider: ProviderId; id: string; names?: string[] } | null;
  /** `structuredOutput` for a schema, `budgetLimit` for a budget, `workflowTool` for the workflow engine… */
  needs: ProviderCapability[];
  /** null only for a person's chat with custom native rules */
  policy: ToolPolicy | null;
  /** The chat runs on rules typed for one provider: they cannot be translated */
  nativeRules: boolean;
  /** Agentry started it: `git push` must be denied and enforced */
  automated: boolean;
  /** Providers this run already left in its chain; free again once their reset has passed */
  exclude: ProviderId[];
  /** The effort the run asks for; carried over when the candidate declares `effort` and lists the level */
  effort?: string | null;
  /** Moves the run has made so far, against `rotation.onLimit.maxMoves` */
  moves?: number;
}

/** What a provider offers, as the caller read it from the registry and the detector. */
export interface CandidateProvider {
  status: ProviderStatus;
  hasDriver: boolean;
  capabilities: ProviderCapability[];
  /** The driver's pure translation; null when none is registered */
  translate: ((policy: ToolPolicy) => PolicyTranslation) | null;
  models: ModelOption[];
  /** The effort levels the provider lists; empty when it lists none */
  efforts?: string[];
}

export interface CandidateContext {
  settings: ProvidersSettings;
  /** The project's overrides; null for work with no project */
  project: ProjectProvidersSettings | null;
  providers: Readonly<Record<ProviderId, CandidateProvider | undefined>>;
  /** Epoch ms */
  now: number;
}

export interface CandidateResult {
  /** In order, the first being what the setting picks */
  /** `effort` is the level the move carries over, null for the candidate's own default */
  candidates: Array<Extract<CandidateView, { model: string | null }> & { effort: string | null }>;
  excluded: Extract<CandidateView, { excluded: Exclusion }>[];
  /** The run has made `maxMoves` moves: it cannot move again, whatever the candidates are */
  movesCapped: boolean;
}

const DEFAULT_MAX_MOVES = 2;

/**
 * Flow stages stay off these two until their native `git push` rule is confirmed against a real
 * recording (phase 3): the translation exists, the proof does not.
 */
const UNCONFIRMED_FOR_FLOW: readonly ProviderId[] = ['copilot', 'gemini'];

/** The order work picks providers in: the project's when it sets one, else the global one. */
export function effectiveOrder(settings: Pick<ProvidersSettings, 'order'>, project: ProjectProvidersSettings | null): ProviderId[] {
  return project?.order && project.order.length > 0 ? project.order : settings.order;
}

/** Whether a translation enforces `git push` denial, in every layer the driver has. */
export function enforcesGitPush(translation: PolicyTranslation): boolean {
  if (translation.unsupported.includes('gitPush')) return false;
  const inRules = translation.rules.disallowedTools.some((rule) => rule.includes('git push'));
  const inSettings = (translation.settings ?? []).some((s) => s.part === 'gitPush');
  const host = translation.host ?? [];
  // where the driver has a judge, the rules alone are not enough: both layers (conformance 11 and 16)
  if (host.length > 0) return host.includes('gitPush') && (inRules || inSettings);
  return inRules || inSettings;
}

/** Still at its limit: exhausted, with the reset ahead or unknown. */
function atLimit(provider: CandidateProvider, now: number): boolean {
  const limit = provider.status.limit;
  if (!limit || limit.state !== 'exhausted') return false;
  return limit.resetsAt === null || Date.parse(limit.resetsAt) > now;
}

function readyFor(provider: CandidateProvider, automated: boolean): boolean {
  const { state, reason } = provider.status;
  if (state === 'ready') return true;
  if (state === 'degraded') return reason !== 'limit-reached';
  // Copilot has no probe that spends nothing: a person's chat may try it, automated work needs proof
  return state === 'unknown' && reason === 'no-probe' && !automated;
}

/** The provider whose own rules a run without a portable policy was written for. */
export const NATIVE_RULES_PROVIDER: ProviderId = 'claude-code';

function policyExclusion(run: RunNeeds, id: ProviderId, provider: CandidateProvider): Exclusion | null {
  if (run.policy === null) {
    if (!run.nativeRules && !run.automated) return null;
    // Nothing to translate means nothing proves `git push` is denied on another provider: automated
    // work without a policy, and rules typed for Claude Code, stay where those rules were written
    return id === NATIVE_RULES_PROVIDER ? null : 'policy-not-portable';
  }
  if (!provider.translate) return 'policy';
  const translation = provider.translate(run.policy);
  if (translation.unsupported.length > 0) return 'policy';
  if (run.automated) {
    if (run.policy.gitPush !== 'deny' || !enforcesGitPush(translation)) return 'policy';
    if (run.kind === 'flow-run' && UNCONFIRMED_FOR_FLOW.includes(id)) return 'policy';
  }
  return null;
}

/**
 * Which providers can take a run, and why each of the others cannot. Pure: starting work
 * (`from: null`) and moving it use the same function.
 */
export function candidatesFor(run: RunNeeds, context: CandidateContext): CandidateResult {
  const { settings, project, providers, now } = context;
  const order = effectiveOrder(settings, project);
  const maxMoves = project?.onLimit?.maxMoves ?? settings.rotation?.onLimit.maxMoves ?? DEFAULT_MAX_MOVES;
  const result: CandidateResult = {
    candidates: [],
    excluded: [],
    movesCapped: run.from !== null && (run.moves ?? 0) >= maxMoves,
  };
  const modelMap = settings.rotation?.modelMap ?? [];

  const ids = [...order, ...Object.keys(providers).filter((id) => !order.includes(id))];
  for (const id of ids) {
    const provider = providers[id];
    const exclude = (excluded: Exclusion): void => {
      result.excluded.push({ provider: id, excluded });
    };
    if (!order.includes(id)) {
      exclude('not-in-order');
      continue;
    }
    if (!provider || settings.providers[id]?.enabled === false) {
      exclude('disabled');
      continue;
    }
    if (!readyFor(provider, run.automated)) {
      exclude('not-ready');
      continue;
    }
    if (!provider.hasDriver) {
      exclude('no-driver');
      continue;
    }
    if (run.needs.some((need) => !provider.capabilities.includes(need))) {
      exclude('capability');
      continue;
    }
    const policy = policyExclusion(run, id, provider);
    if (policy) {
      exclude(policy);
      continue;
    }
    let model: string | null = null;
    if (run.model) {
      const mapped = mapModel(modelMap, run.model, id, provider.models);
      if (mapped === undefined) {
        exclude('no-mapping');
        continue;
      }
      model = mapped;
    }
    if (atLimit(provider, now)) {
      exclude('exhausted');
      continue;
    }
    // The provider the run is on is the one it leaves; one it left earlier stays out until its reset passes
    const resetsAt = provider.status.limit?.resetsAt ?? null;
    const resetPassed = resetsAt !== null && Date.parse(resetsAt) <= now;
    if (id === run.from?.provider || (run.exclude.includes(id) && !resetPassed)) {
      exclude('left-already');
      continue;
    }
    const limit = provider.status.limit;
    const effort = run.effort && provider.capabilities.includes('effort') && provider.efforts?.includes(run.effort) ? run.effort : null;
    result.candidates.push({ provider: id, model, effort, utilization: limit?.utilization ?? null, resetsAt: limit?.resetsAt ?? null });
  }
  if (result.movesCapped) result.candidates = [];
  return result;
}
