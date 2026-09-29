import { MAX_CONTINUATIONS } from '@agentry/shared';

/**
 * What an unattended run still owes when its turn ended: a turn that ends with text while work is
 * owed is a report, not the end of the work (the Opus 5.5 guide). The flow and the orchestrator read
 * it off the run's result and send the run back to its own chat, naming what is open, at most
 * {@link MAX_CONTINUATIONS} times. Pure, so each case can be pinned on its own.
 */

/**
 * Whether a turn was cut by the output token limit (`stop_reason` in the CLI's stream-json): what it
 * wrote may parse and still be incomplete, so a structured result from it is not trusted.
 */
export function stoppedOnMaxTokens(result: { stopReason?: string | null | undefined }): boolean {
  return result.stopReason === 'max_tokens';
}

/** The error a structured-output run that stopped on the token limit fails with. */
export const MAX_TOKENS_ERROR = 'its last turn stopped on max_tokens (the output token limit), so its result may be cut short and was not used';

export interface OpenItemsInput {
  /** The run was held to a `--json-schema` */
  schema: boolean;
  /** A structured result came back that the caller could read */
  structured: boolean;
  /** Paths with changes nobody committed, in the place the run should have committed its work */
  uncommitted: readonly string[];
  /** The text the run's last turn ended with */
  finalText: string;
}

/** Paths named in an open item at most; the rest are counted */
const PATHS_NAMED = 20;
/** The end of the final text the phrases are looked for in: where a turn says what comes next */
const TAIL_CHARS = 600;

const OFFERS = [
  /\blet me know if\b/i,
  /\b(would|do) you (like|want) me to\b/i,
  /\bshall i\b/i,
  /\bshould i (go on|continue|proceed|carry on)\b/i,
  /\bif you('d| would)? (like|want|prefer),? i (can|could|will|'ll)\b/i,
  /\bi can (also |now |then )?(continue|go on|proceed|carry on|do that next)\b/i,
  /\b(happy|glad) to (continue|go on|proceed|keep going)\b/i,
  /\bunless you (tell|say|want|prefer)\b/i,
];

const NEXT_STEPS = [
  /\bnext,? i('ll| will| am going to|'m going to)\b/i,
  /\bnow i('ll| will| am going to|'m going to)\b/i,
  /\bi('ll| will) now\b/i,
  /\blet me now\b/i,
  /\b(the )?next step (is|will be)\b/i,
  /\bnext steps?:/i,
  /\bi('m| am) (now )?going to\b/i,
];

/** The last paragraph of a text, where it asks or announces something. */
function tailOf(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.slice(-TAIL_CHARS);
  const paragraphs = end.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.at(-1) ?? '';
}

/** Each thing the run still owes, as a sentence addressed to it; empty when nothing is open. */
export function openItems(input: OpenItemsInput): string[] {
  const items: string[] = [];
  if (input.schema && !input.structured) items.push('You have not returned the structured result this run asks for. Finish the work, then return it.');
  if (input.uncommitted.length) {
    const named = input.uncommitted.slice(0, PATHS_NAMED).map((p) => `\`${p}\``);
    const more = input.uncommitted.length - named.length;
    items.push(
      `These paths have changes that are not committed: ${named.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}. Commit what belongs to the work on this branch, and restore what does not.`,
    );
  }
  const last = tailOf(input.finalText);
  if (last) {
    if (OFFERS.some((re) => re.test(last))) {
      items.push('Your last message offers to continue instead of continuing. Nobody will answer it: carry on with the work.');
    } else if (/\?\s*$/.test(last)) {
      items.push('Your last message asks a question nobody will answer. If it does not block you, choose, say in your report what you chose and why, and carry on; if it does block you, say what you need and stop.');
    }
    if (NEXT_STEPS.some((re) => re.test(last))) items.push('Your last message announces a next step without taking it. Take it now.');
  }
  return items;
}

/**
 * What the run is told when it goes back to its chat: what is open, which continuation this is, and
 * what the caller adds (how the run ends, a time signal).
 */
export function continuationPrompt(items: readonly string[], count: number, extra: readonly string[] = []): string {
  return [
    `Your turn ended, but the work is not finished (continuation ${String(count)} of ${String(MAX_CONTINUATIONS)}):`,
    ...items.map((i) => `- ${i}`),
    '',
    'Carry on from where you are; everything you did is still in place. Ask only before a risky or destructive action.',
    ...extra.flatMap((e) => ['', e]),
  ].join('\n');
}
