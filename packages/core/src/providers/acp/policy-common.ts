import type { CommandRule, PolicyPart } from '@agentry/shared';

/** A text a native rule can carry: no parenthesis (it closes the rule), no comma, no control character. */
export function carriable(text: string): boolean {
  return text.length > 0 && !/[,()\u0000-\u001f\u007f]/.test(text);
}

/**
 * The words in front of one trailing `*` (`npm test*`, `git log *`), when that is all the wildcard
 * does. A pattern with a wildcard anywhere else is not a prefix: a native rule that cannot say it
 * leaves the decision to the judge instead of guessing.
 */
export function prefixOf(pattern: string): string | null {
  const text = pattern.trim();
  if (!text.endsWith('*')) return null;
  const words = text.slice(0, -1).trim();
  return words.length > 0 && !words.includes('*') ? words : null;
}

/** The parts a policy leaves to the judge, in the order they were added and without repeats. */
export class HostParts {
  private readonly parts: PolicyPart[] = [];
  add(...parts: PolicyPart[]): void {
    for (const part of parts) if (!this.parts.includes(part)) this.parts.push(part);
  }
  list(): PolicyPart[] | undefined {
    return this.parts.length > 0 ? [...this.parts] : undefined;
  }
}

export const isPatternRule = (rule: CommandRule): rule is { pattern: string } => 'pattern' in rule;
