/**
 * How the web names a code host's change request. GitHub calls it a pull request and numbers it
 * `#12`; GitLab calls it a merge request and numbers it `!12`. Every screen that says "PR" takes
 * the word, the number's prefix and the host's own name from here, so none writes "GitHub" for a
 * project that lives elsewhere. No React: tested without a browser (test/code-hosts.test.ts).
 */
import type { CodeHostId } from '@agentry/shared';

export interface ChangeRequestWords {
  /** `tasks` namespace: the short noun, "PR" or "MR" */
  nounKey: 'pr.noun.pr' | 'pr.noun.mr';
  /** `tasks` namespace: the noun spelled out, "pull request" or "merge request", for a sentence */
  longKey: 'pr.long.pr' | 'pr.long.mr';
  /** How the host writes a number: `#` or `!` */
  prefix: '#' | '!';
  /** The host's own name, a proper noun that is never translated */
  label: string;
}

const WORDS: Readonly<Record<CodeHostId, ChangeRequestWords>> = {
  github: { nounKey: 'pr.noun.pr', longKey: 'pr.long.pr', prefix: '#', label: 'GitHub' },
  gitlab: { nounKey: 'pr.noun.mr', longKey: 'pr.long.mr', prefix: '!', label: 'GitLab' },
};

/** A host this version does not know reads as GitHub's words, the only ones that existed before hosts. */
export function changeRequestWords(host: CodeHostId | string | null | undefined): ChangeRequestWords {
  return host === 'gitlab' ? WORDS.gitlab : WORDS.github;
}

/** The number as its host writes it (`#12`, `!7`); the server's own `ref` wins when it sends one. */
export function changeRequestRef(host: CodeHostId | string | null | undefined, number: number | null, ref?: string | null): string | null {
  if (ref) return ref;
  return number === null ? null : `${changeRequestWords(host).prefix}${number}`;
}
