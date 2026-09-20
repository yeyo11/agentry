import { searchPattern, type TranscriptSearchHit, type TranscriptSearchResult } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
// Direct imports: RunView is in the shell bundle, and the barrel would pull the lazy form controls into it
import { hasOpenLayer } from './controls/layer';
import { Tooltip } from './controls/Tooltip';
import { ICON_SM } from './icons';

/** Typing settles before the whole transcript is read again. */
const DEBOUNCE_MS = 250;

/** How long after a jump the view is still steered to the match: the list takes that to settle. */
const STEER_MS = 1500;

/** Entries loaded above a hit that was on a page not held yet. */
const CONTEXT_ABOVE = 10;

/** Hit to scroll to; a new object for every move, so moving to the same hit scrolls again. */
export interface FindTarget {
  index: number;
}

/**
 * State of the search over a whole transcript: the field, the hits the API found in pages the view
 * may not hold, and which one is current. Hits are walked newest first, the end a reader lands on,
 * so the first Enter goes up the conversation the way scrolling back does.
 */
export function useTranscriptFind({
  scope,
  search,
  keep,
}: {
  /** What is searched; a different scope drops the hits */
  scope: readonly unknown[];
  search: (query: string) => Promise<TranscriptSearchResult>;
  /** Hits the view cannot show right now (hidden kinds of event) are skipped */
  keep?: (hit: TranscriptSearchHit) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<FindTarget | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  const result = useQuery({
    queryKey: ['transcript-search', ...scope, query],
    queryFn: () => search(query),
    enabled: open && query !== '',
    staleTime: 5_000,
  });
  const hits = useMemo(() => {
    const all = result.data?.hits ?? [];
    return keep ? all.filter(keep) : all;
  }, [result.data, keep]);

  // Held as the transcript index, not the position: a refetch that finds new hits keeps the reader
  // on the one they were at.
  const [at, setAt] = useState<number | null>(null);
  const position = at === null ? -1 : hits.findIndex((hit) => hit.index === at);

  const go = useCallback((hit: TranscriptSearchHit | undefined) => {
    if (!hit) return;
    setAt(hit.index);
    setTarget({ index: hit.index });
  }, []);

  // New hits for a new query start at the newest one; a refetch leaves the reader where they are
  const landedFor = useRef<string | null>(null);

  // Another transcript, or the same one counted differently (sidechains): old indices mean nothing
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    landedFor.current = null;
    setAt(null);
    setTarget(null);
  }, [scopeKey]);
  useEffect(() => {
    if (!open || !result.data || result.data.query !== query) return;
    if (landedFor.current === query && position >= 0) return;
    landedFor.current = query;
    if (hits.length === 0) {
      setAt(null);
      setTarget(null);
      return;
    }
    go(hits[hits.length - 1]);
  }, [open, result.data, query, hits, position, go]);

  const step = useCallback(
    (towardsOlder: boolean) => {
      if (hits.length === 0) return;
      if (position < 0) return go(hits[hits.length - 1]);
      go(hits[(position + (towardsOlder ? -1 : 1) + hits.length) % hits.length]);
    },
    [hits, position, go],
  );

  const show = useCallback(() => {
    setOpen(true);
    // The field mounts with this render; focus it once it is there
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setTarget(null);
    setAt(null);
    landedFor.current = null;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
      // A second press in the field is for the browser's own find, which still covers the page around
      if (open && document.activeElement === input.current) return;
      if (hasOpenLayer() || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, show]);

  return {
    open,
    show,
    close,
    text,
    setText,
    query,
    input,
    hits,
    position,
    result,
    target,
    older: () => step(true),
    newer: () => step(false),
  };
}

export type TranscriptFind = ReturnType<typeof useTranscriptFind>;

/**
 * The item a target points at once the page holding it is loaded, as the `focus` a VirtualList
 * scrolls to. Reading back to the hit is the caller's `reach`, started here as soon as a target is set.
 */
export function useFindFocus<T>(target: FindTarget | null, items: T[], from: number, reach: (index: number) => Promise<void>) {
  useEffect(() => {
    // Keyed on the target alone: `reach` changes identity with every page it loads. A few entries
    // above the hit come along, or the list could not centre it and it would sit at the very top.
    if (target) void reach(Math.max(0, target.index - CONTEXT_ABOVE)).catch(() => {});
  }, [target]);
  const item = target && target.index >= from ? items[target.index - from] : undefined;
  return useMemo(() => (target && item !== undefined ? { item } : null), [target, item]);
}

const HIGHLIGHT = 'transcript-find';
const HIGHLIGHT_CURRENT = 'transcript-find-current';

/** The CSS Custom Highlight API, where the browser has it; without it the hit is still outlined. */
function highlights(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
}

function rangesIn(root: Element, pattern: RegExp): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    pattern.lastIndex = 0;
    for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
      if (match[0].length === 0) break;
      const range = new Range();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * Scrolls `range` to the middle of each box that clips it, innermost first: a long tool result
 * scrolls inside its own code block, and scrolling only the page would chase a match that the block
 * keeps out of sight. `covered` is where the page's viewport really starts (the sticky search bar).
 */
function reveal(range: Range, view: Element, covered: number) {
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const outermost = el === view;
    const style = getComputedStyle(el);
    if (outermost || (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(style.overflowY))) {
      const box = range.getBoundingClientRect();
      const port = el.getBoundingClientRect();
      const top = outermost ? Math.max(port.top, covered) : port.top;
      if (box.top < top || box.bottom > port.bottom) el.scrollTop += box.top - (top + (port.bottom - top) / 2);
    }
    // Long lines in a code block scroll sideways
    if (!outermost && el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(style.overflowX)) {
      const box = range.getBoundingClientRect();
      const port = el.getBoundingClientRect();
      if (box.left < port.left || box.right > port.right) el.scrollLeft += box.left - (port.left + port.width / 2);
    }
    if (outermost) return;
  }
}

/**
 * Marks the query in the rows on screen, and the current hit's row more strongly, without touching
 * how rows render: rows mount and unmount as the list scrolls, so the marks are redrawn whenever
 * the DOM under `root` changes. A match inside a closed fold (a tool call, its result, thinking) is
 * not in the DOM at all, so right after a jump the folds of the current hit are opened when
 * nothing visible in it matches. A match split across two text nodes (half a word in bold) is not
 * marked; the row is outlined either way.
 */
export function useFindHighlight(root: RefObject<HTMLElement | null>, find: TranscriptFind) {
  const pattern = useMemo(() => (find.open ? searchPattern(find.query, 'giu') : null), [find.open, find.query]);

  useEffect(() => {
    const registry = highlights();
    const el = root.current;
    if (!el || !pattern) return;
    const target = find.target;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const all: Range[] = [];
      const current: Range[] = [];
      for (const row of el.querySelectorAll('[data-index]')) (row.hasAttribute('data-focused') ? current : all).push(...rangesIn(row, pattern));
      if (registry) {
        registry.set(HIGHLIGHT, new Highlight(...all));
        registry.set(HIGHLIGHT_CURRENT, new Highlight(...current));
      }
      // Only right after a jump: later on, rows re-mount as the reader scrolls, and neither their
      // folds nor their scroll position are ours to change any more
      const row = el.querySelector('[data-focused]');
      if (row && reached === null) reached = performance.now();
      if (!target || !row || !steering()) return;

      // The row re-mounts with its folds closed while the list settles, so this can take twice
      if (current.length === 0) {
        for (const fold of row.querySelectorAll<HTMLElement>('.collapsible-trigger[data-state="closed"]')) fold.click();
      }

      // The list keeps the row in view; a row taller than the screen can still leave the match
      // outside it, or under the search bar
      const first = current[0];
      if (first) {
        // A fold that has just opened is laid out a frame later
        const box = first.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return schedule();
        const bar = document.querySelector('.find-bar')?.getBoundingClientRect().bottom ?? 0;
        reveal(first, view, bar);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const view = el.closest('[data-scroll-root], .main') ?? el;
    // The clock starts once the hit is on the page: reading back to it can take a while
    let reached: number | null = null;
    let released = false;
    const steering = () => !released && (reached === null || performance.now() - reached <= STEER_MS);
    const release = () => {
      released = true;
    };
    view.addEventListener('wheel', release, { passive: true, once: true });
    view.addEventListener('touchmove', release, { passive: true, once: true });
    // Scrolling mounts rows, which the observer sees; this is for the row that was already there
    const steer = () => {
      if (steering()) schedule();
    };
    view.addEventListener('scroll', steer, { passive: true });
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-focused'] });
    return () => {
      observer.disconnect();
      view.removeEventListener('wheel', release);
      view.removeEventListener('touchmove', release);
      view.removeEventListener('scroll', steer);
      if (frame) cancelAnimationFrame(frame);
      registry?.delete(HIGHLIGHT);
      registry?.delete(HIGHLIGHT_CURRENT);
    };
  }, [root, pattern, find.target]);
}

function Snippet({ hit }: { hit: TranscriptSearchHit }) {
  return (
    <span className="find-snippet">
      {hit.snippet.slice(0, hit.start)}
      <mark>{hit.snippet.slice(hit.start, hit.start + hit.length)}</mark>
      {hit.snippet.slice(hit.start + hit.length)}
    </span>
  );
}

/** The button in a page header that opens the search. */
export function FindButton({ find }: { find: TranscriptFind }) {
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return (
    <Tooltip content={`Search the whole transcript (${mac ? '⌘' : 'Ctrl+'}F)`}>
      <button type="button" className="btn" aria-pressed={find.open} onClick={() => (find.open ? find.close() : find.show())}>
        <Search {...ICON_SM} /> Search
      </button>
    </Tooltip>
  );
}

export function FindBar({ find, className = '' }: { find: TranscriptFind; className?: string }) {
  if (!find.open) return null;
  const { hits, position, result } = find;
  const current = position >= 0 ? hits[position] : undefined;
  const pending = find.text.trim() !== find.query || result.isFetching;
  const counter =
    find.query === ''
      ? ''
      : result.isError
        ? 'Search failed'
        : hits.length === 0
          ? pending
            ? 'Searching…'
            : 'No matches'
          : `${position < 0 ? 0 : hits.length - position} of ${hits.length}${result.data?.truncated ? '+' : ''}`;

  return (
    <div className={`find-bar ${className}`} role="search" aria-label="Transcript">
      <div className="find-row">
        <Search {...ICON_SM} className="find-icon" />
        <input
          ref={find.input}
          className="find-input"
          type="text"
          placeholder="Search the whole transcript"
          aria-label="Search the whole transcript"
          value={find.text}
          onChange={(e) => find.setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) find.newer();
              else find.older();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              find.older();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              find.newer();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              find.close();
            }
          }}
        />
        <span className="find-count muted small" aria-live="polite">
          {counter}
        </span>
        <Tooltip content="Older match (Enter)">
          <button type="button" className="icon-btn" aria-label="Older match" disabled={hits.length === 0} onClick={find.older}>
            <ChevronUp {...ICON_SM} />
          </button>
        </Tooltip>
        <Tooltip content="Newer match (Shift+Enter)">
          <button type="button" className="icon-btn" aria-label="Newer match" disabled={hits.length === 0} onClick={find.newer}>
            <ChevronDown {...ICON_SM} />
          </button>
        </Tooltip>
        <Tooltip content="Close (Esc)">
          <button type="button" className="icon-btn" aria-label="Close search" onClick={find.close}>
            <X {...ICON_SM} />
          </button>
        </Tooltip>
      </div>
      {current && (
        <div className="find-context muted small">
          <Snippet hit={current} />
        </div>
      )}
    </div>
  );
}
