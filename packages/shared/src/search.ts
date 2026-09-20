import {
  TRANSCRIPT_SEARCH_MAX_HITS,
  type TranscriptEntry,
  type TranscriptSearchHit,
  type TranscriptSearchResult,
} from './types.ts';

/** A longer query is almost certainly a paste gone wrong, and would only make the pattern slow. */
export const SEARCH_QUERY_MAX = 200;

const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 80;

/**
 * The pattern a plain-text query becomes: case-insensitive, and any run of whitespace in it matches
 * any run in the text. Rendered markdown and pretty-printed JSON both fold line breaks and indents
 * into what reads as one space, so that is what someone copying a phrase off the screen types.
 * The same pattern finds the hit on the server and marks it in the browser.
 */
export function searchPattern(query: string, flags = 'iu'): RegExp | null {
  const words = query.trim().slice(0, SEARCH_QUERY_MAX).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), flags);
}

/** What the transcript view shows of an entry, collapsed folds included: they open on a click. */
export function entrySearchText(entry: TranscriptEntry): string {
  const parts: string[] = [];
  for (const block of entry.blocks) {
    switch (block.type) {
      case 'text':
      case 'thinking':
        parts.push(block.text);
        break;
      case 'tool_use':
        parts.push(block.name, JSON.stringify(block.input, null, 2) ?? '');
        break;
      case 'tool_result':
        parts.push(block.content);
        break;
      case 'image':
      case 'document':
        if (block.name) parts.push(block.name);
        break;
    }
  }
  return parts.join('\n');
}

const collapse = (text: string) => text.replace(/\s+/g, ' ');

function hitAt(index: number, text: string, match: RegExpExecArray): TranscriptSearchHit {
  const end = match.index + match[0].length;
  let before = collapse(text.slice(Math.max(0, match.index - CONTEXT_BEFORE * 2), match.index)).trimStart();
  let after = collapse(text.slice(end, end + CONTEXT_AFTER * 2)).trimEnd();
  if (before.length > CONTEXT_BEFORE || match.index > CONTEXT_BEFORE * 2) before = `…${before.slice(-CONTEXT_BEFORE).trimStart()}`;
  if (after.length > CONTEXT_AFTER || end + CONTEXT_AFTER * 2 < text.length) after = `${after.slice(0, CONTEXT_AFTER).trimEnd()}…`;
  const found = collapse(match[0]);
  return { index, snippet: `${before}${found}${after}`, start: before.length, length: found.length };
}

/**
 * Collects hits as a transcript is walked once, in order. Past the cap the oldest hits are dropped:
 * a search starts from the newest one, the end a reader lands on.
 */
export class TranscriptSearch {
  private readonly hits: TranscriptSearchHit[] = [];
  private dropped = false;
  private total = 0;

  constructor(
    private readonly query: string,
    private readonly pattern: RegExp,
    private readonly max = TRANSCRIPT_SEARCH_MAX_HITS,
  ) {}

  /** The next entry, in index order; null text still takes up its index. */
  add(text: string | null): void {
    const index = this.total++;
    if (!text) return;
    const match = this.pattern.exec(text);
    if (!match) return;
    this.hits.push(hitAt(index, text, match));
    if (this.hits.length > this.max) {
      this.hits.shift();
      this.dropped = true;
    }
  }

  result(): TranscriptSearchResult {
    return { query: this.query, hits: this.hits, total: this.total, truncated: this.dropped };
  }
}
