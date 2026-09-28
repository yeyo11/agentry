/**
 * What a screen draws for a query: what it holds, whenever it holds something. A refetch that fails
 * (the fallback poll during an API blip) keeps the last answer in `data` and sets `error` beside it;
 * reading the error first replaced open editors with an error box and lost their unsaved text.
 */
export type QueryView = 'shown' | 'loading' | 'failed' | 'missing';

export function queryView(query: { data: unknown; error: unknown; isLoading: boolean }): QueryView {
  if (query.data !== undefined && query.data !== null) return 'shown';
  if (query.isLoading) return 'loading';
  if (query.error) return 'failed';
  return 'missing';
}
