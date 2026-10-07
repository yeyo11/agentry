import { isEffort, recommendedEffort, type Effort, type EffortUse } from '@agentry/shared';

/**
 * The effort a run starts with: the first level someone chose, in the order given (the task's, then
 * the graph's…), else the recommendation for the model and the use. Undefined is the CLI's own
 * default, which is also what a provider that does not declare `effort` gets whatever this says (the
 * chat drops it where it cannot be passed).
 */
export function resolveEffort(use: EffortUse, model: string | null | undefined, ...chosen: Array<string | null | undefined>): Effort | undefined {
  for (const level of chosen) if (isEffort(level)) return level;
  return recommendedEffort(model, use) ?? undefined;
}

/** `{ effort }` when there is one, to spread into the options of a run. */
export function effortOption(effort: string | null | undefined): { effort?: string } {
  return effort ? { effort } : {};
}

/** The effort a chat's latest execution started with: what the run records, so it is what was passed and not what was asked. */
export function usedEffort(chat: { executions: ReadonlyArray<{ effort?: Effort | null }> }): Effort | null {
  return chat.executions[chat.executions.length - 1]?.effort ?? null;
}
