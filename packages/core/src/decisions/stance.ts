import type { DecisionPointId } from '@agentry/shared';
import type { DecisionEngine } from './engine.ts';

/** What a call site needs of the engine: the settings in force, and the question */
export type DecisionAsker = Pick<DecisionEngine, 'ask' | 'effective'>;

/**
 * How a call site takes part in a decision: not at all (`off`, or no engine), asking in the
 * background with today's behaviour deciding (`watch`: shadow, or active where the engine reports
 * `limited`: the CLI on an act point, or no consent), or waiting for the answer (`wait`: active and
 * able to clear a threshold). Anything that goes wrong reading the settings is `off`.
 */
export function stanceOf(engine: DecisionAsker | null | undefined, point: DecisionPointId, projectId: string | null): 'off' | 'watch' | 'wait' {
  if (!engine) return 'off';
  try {
    const effective = engine.effective(point, projectId);
    if (effective.mode === 'off') return 'off';
    return effective.mode === 'active' && !effective.limited ? 'wait' : 'watch';
  } catch {
    return 'off';
  }
}
