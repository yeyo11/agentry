import type { DecisionMode, DecisionPointId, DecisionPointInfo, DecisionPointSettings, DecisionProviderId, DecisionRecord } from '@agentry/shared';

/** Rough size of a request in tokens: the consent dialog says "about", so four bytes a token is enough. */
export const approxTokens = (bytes: number) => Math.ceil(bytes / 4);

/**
 * A point asks for consent until the owner has seen the state it sends now (its version) and agreed
 * for the provider that will receive it: consent given on the CLI does not cover Jev.
 */
export function needsConsent(info: Pick<DecisionPointInfo, 'stateVersion'>, consent: DecisionPointSettings['consent'], provider: DecisionProviderId): boolean {
  return !consent || consent.stateVersion !== info.stateVersion || !consent.providers.includes(provider);
}

/** The providers a new consent covers: what was agreed before for this same state, plus this one. */
export function consentProviders(info: Pick<DecisionPointInfo, 'stateVersion'>, consent: DecisionPointSettings['consent'], provider: DecisionProviderId): DecisionProviderId[] {
  const before = consent && consent.stateVersion === info.stateVersion ? consent.providers : [];
  return before.includes(provider) ? [...before] : [...before, provider];
}

/** An act point changes what happens, so on the CLI (no calibrated confidence) it cannot be active. */
export const activeBlocked = (info: Pick<DecisionPointInfo, 'kind'>, provider: DecisionProviderId) => info.kind === 'act' && provider === 'cli';

export interface BulkPlan {
  /** The mode each point that changes ends up in */
  changes: Array<{ id: DecisionPointId; mode: DecisionMode }>;
  /** Points that already sit in the mode that would result: nothing to do */
  unchanged: DecisionPointId[];
  /** Points that keep a lower mode than the one asked for, because they cannot be active */
  capped: DecisionPointId[];
  /** Changes that leave `off` without consent for what they send now: they wait for the person to see it */
  needConsent: Array<{ id: DecisionPointId; mode: Exclude<DecisionMode, 'off'> }>;
}

/**
 * What setting many points to one mode does, point by point. A point that cannot be active keeps
 * shadow (its allowed maximum) instead of failing the whole batch, and only points that actually
 * change are asked for consent: one already in shadow is not asked again by a batch.
 */
export function planBulk(
  catalogue: readonly DecisionPointInfo[],
  ids: readonly DecisionPointId[],
  mode: DecisionMode,
  current: (id: DecisionPointId) => DecisionMode,
  consentOf: (id: DecisionPointId) => DecisionPointSettings['consent'],
  provider: DecisionProviderId,
): BulkPlan {
  const plan: BulkPlan = { changes: [], unchanged: [], capped: [], needConsent: [] };
  for (const id of ids) {
    const info = catalogue.find((point) => point.id === id);
    if (!info) continue;
    const capped = mode === 'active' && activeBlocked(info, provider);
    const result: DecisionMode = capped ? 'shadow' : mode;
    if (capped) plan.capped.push(id);
    if (current(id) === result) {
      plan.unchanged.push(id);
      continue;
    }
    plan.changes.push({ id, mode: result });
    if (result !== 'off' && needsConsent(info, consentOf(id), provider)) plan.needConsent.push({ id, mode: result });
  }
  return plan;
}

/** A share as a whole percentage, or null while there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

export type HistoryOutcome = 'match' | 'differs' | 'pending' | 'asUsual';

/** What the Result column says: an unavailable request changed nothing, and an answer waits to be compared. */
export function outcomeOf(record: Pick<DecisionRecord, 'status' | 'agreed'>): HistoryOutcome {
  if (record.status === 'unavailable') return 'asUsual';
  if (record.agreed === true) return 'match';
  if (record.agreed === false) return 'differs';
  return 'pending';
}

export interface AnswerLine {
  question: string;
  /** The option label, or the level id; a yes/no answer is a boolean the view words */
  value: string | boolean;
  /** Each option with its probability, most likely first; a yes/no answer uses the ids `yes` and `no` */
  bars: Array<{ id: string; label: string; probability: number }>;
}

/** One line per question that was answered, with the labels the question carried. */
export function answerLines(record: Pick<DecisionRecord, 'questions' | 'answers'>): AnswerLine[] {
  const lines: AnswerLine[] = [];
  for (const question of record.questions) {
    const answer = record.answers?.[question.id];
    if (!answer) continue;
    if (answer.kind === 'noul') {
      const yes = answer.probability;
      lines.push({
        question: question.question,
        value: answer.value,
        bars: yes === null ? [] : [{ id: 'yes', label: 'yes', probability: yes }, { id: 'no', label: 'no', probability: 1 - yes }],
      });
      continue;
    }
    const labels = new Map<string, string>(question.kind === 'choice' ? question.options.map((o) => [o.id, o.label]) : []);
    const label = (id: string) => labels.get(id) ?? id;
    const bars = Object.entries(answer.probabilities ?? {})
      .map(([id, probability]) => ({ id, label: label(id), probability }))
      .sort((a, b) => b.probability - a.probability);
    lines.push({ question: question.question, value: label(answer.value), bars });
  }
  return lines;
}
