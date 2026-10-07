/**
 * How hard a model thinks, as Claude Code's `--effort` takes it. Levels are calibrated per model, so a
 * setting is never carried from one model to another: unset means the recommendation for the model
 * and the use ({@link recommendedEffort}), or the CLI's own default where there is none.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** The two levels that add review rounds and cost: offered, and marked as costly. */
export const COSTLY_EFFORTS: readonly Effort[] = ['xhigh', 'max'];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** What a run is for. Work that is hard or long (a plan, a fix of what fails) is not the same use as a well-specified task. */
export type EffortUse = 'chat' | 'refine' | 'verify' | 'work' | 'worker' | 'assistant' | 'planner' | 'fixer';

/** Why a level is recommended, as a code a client words (and translates) for the tooltip. */
export type EffortReason = 'opus-medium' | 'sonnet-medium' | 'sonnet-high';

export interface EffortRecommendation {
  effort: Effort;
  reason: EffortReason;
}

type KnownModel = 'opus' | 'sonnet';

/**
 * Opus 5.5 and Sonnet 5.5 by alias (`opus`, `sonnet`) or by id (`claude-opus-5-5`, with a date or a
 * `[1m]` suffix); any other model, an older one included, is not known.
 */
function knownModel(model: string | null | undefined): KnownModel | null {
  const match = /^(?:claude-)?(opus|sonnet)(?:-5-5)?(?:-\d{8})?(?:\[[^\]]*\])?$/.exec((model ?? '').trim().toLowerCase());
  return match ? (match[1] as KnownModel) : null;
}

/** The effort to use when none was chosen, with its reason; null for a model it does not know (the CLI default). */
export function effortRecommendation(model: string | null | undefined, use: EffortUse): EffortRecommendation | null {
  const known = knownModel(model);
  if (!known) return null;
  if (known === 'opus') return { effort: 'medium', reason: 'opus-medium' };
  return use === 'planner' || use === 'fixer' ? { effort: 'high', reason: 'sonnet-high' } : { effort: 'medium', reason: 'sonnet-medium' };
}

export function recommendedEffort(model: string | null | undefined, use: EffortUse): Effort | null {
  return effortRecommendation(model, use)?.effort ?? null;
}
