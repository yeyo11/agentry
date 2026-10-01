// ---------- the pages of a transcript read further back, kept as one run ----------
import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';

/** The last part of the cache key every run is kept under, which is how they are told from the rest. */
export const RUN_TAG = 'earlier';

/** A contiguous run of a transcript: `items[i]` is entry `from + i` of the whole. */
export interface Run<T> {
  items: T[];
  from: number;
}

/**
 * `run` with `page` in it, by index: the page is the newer read and wins wherever they overlap.
 * A page that does not touch the run replaces it. That is what makes the run honest after the
 * newest page slid past it (the chat grew by more than a tail read while the stream was down and
 * the page was read whole again): the run no longer meets the newest page, the next page read
 * ends where the newest one starts, and it either bridges the gap in one read or takes the run's
 * place. Keeping the run because it started earlier, as this once did, threw that page away and
 * left nothing to click but a button that did nothing.
 */
export function joinRun<T>(run: Run<T> | null | undefined, page: Run<T>): Run<T> {
  if (!run || page.items.length === 0) return run ?? page;
  const runEnd = run.from + run.items.length;
  const pageEnd = page.from + page.items.length;
  if (pageEnd < run.from || page.from > runEnd) return page;
  const before = page.from > run.from ? run.items.slice(0, page.from - run.from) : [];
  const after = pageEnd < runEnd ? run.items.slice(pageEnd - run.from) : [];
  return { from: Math.min(run.from, page.from), items: [...before, ...page.items, ...after] };
}

/** The newest `max` entries of `run`: what is dropped is the oldest, which is furthest from the end being followed. */
export function trimRun<T>(run: Run<T>, max: number): Run<T> {
  const drop = run.items.length - max;
  if (drop <= 0) return run;
  return { from: run.from + drop, items: run.items.slice(drop) };
}

/** `run` joined onto the page after it, when they meet; the page alone when they do not. */
export function joinToPage<T>(run: Run<T> | null | undefined, page: Run<T>): Run<T> {
  if (!run || run.from + run.items.length < page.from) return page;
  return { from: run.from, items: [...run.items.slice(0, page.from - run.from), ...page.items] };
}

/**
 * Keeps what every chat holds back under `max` entries between them: the runs least recently
 * read go first, and never `keep`, the one on the page, nor one something is still showing. A cap
 * per chat is not one per browser, and a phone that opened a few long chats in a row would be
 * holding all of them.
 */
export function evictRuns(client: QueryClient, keep: QueryKey, max: number): void {
  const runs = client
    .getQueryCache()
    .findAll({ predicate: (query) => query.queryKey.at(-1) === RUN_TAG && query.state.data !== undefined })
    .map((query) => ({ query, size: (query.state.data as Run<unknown>).items.length }));
  let held = runs.reduce((sum, run) => sum + run.size, 0);
  const kept = hashKey(keep);
  const spare = runs.filter(({ query }) => query.queryHash !== kept && query.getObserversCount() === 0).sort((a, b) => a.query.state.dataUpdatedAt - b.query.state.dataUpdatedAt);
  for (const { query, size } of spare) {
    if (held <= max) return;
    client.removeQueries({ queryKey: query.queryKey, exact: true });
    held -= size;
  }
}
