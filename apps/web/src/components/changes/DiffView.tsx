import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronsUpDown } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  readingRows,
  splitRows,
  unifiedRows,
  type DiffLine,
  type DiffRow,
  type Gap,
  type GapRow,
  type ParsedDiff,
  type Pill,
  type SplitCell,
  type SplitRow,
} from '../../lib/diff';
import { Lru } from '../../lib/lru';
import { wordDiff, type Range, type WordDiff } from '../../lib/word-diff';
import { highlightRoles, languageOfPath, SYNTAX_CLASS, type Role, type RoleLine } from '../highlight';
import { ICON_SM } from '../icons';

// One file's diff, drawn the three ways of design system §5: Reading (the file as it is now, what
// was removed folded into pills), Unified and Side by side. Everything it draws comes from
// lib/diff; this only paints rows.

export type DiffMode = 'reading' | 'unified' | 'split';

/** Each side's lines as role runs, by line number */
export interface DiffSyntax {
  old: Map<number, RoleLine>;
  new: Map<number, RoleLine>;
}

/** Past this many rows only the ones near the viewport are in the DOM */
const VIRTUAL_OVER = 400;

const MODE_CLASS: Record<DiffMode, string> = { reading: 'diff-read', unified: 'diff-uni', split: 'diff-split' };

export interface DiffViewProps {
  diff: ParsedDiff;
  mode: DiffMode;
  /** The file's path, which picks the language its syntax is read in */
  path?: string;
  /** Blocks whose removed lines are open (Reading). Without it the view keeps its own. */
  opened?: ReadonlySet<number>;
  onToggleBlock?: (block: number) => void;
  /** "Show" on a gap; without it the gaps say their size and offer nothing */
  onOpenGap?: (gap: Gap) => void;
  /** Wrap long lines at 19 px rows instead of scrolling sideways (a phone) */
  wrap?: boolean;
  /** The block `j`/`k` are on: it is scrolled into view when it changes */
  currentBlock?: number | null;
  /** Only these hunks (Step by step shows one patch) */
  hunks?: ReadonlySet<number>;
  /** The two sides' names over Side by side: a commit, a base */
  refs?: { before?: string; after?: string };
  /** Syntax worked out beforehand; by default the view reads it itself, after the first paint */
  syntax?: DiffSyntax | null;
  /** The element that scrolls the diff, for the rows of a long one; the nearest scroll root otherwise */
  scrollRef?: RefObject<HTMLElement | null>;
  className?: string;
}

export function DiffView({
  diff,
  mode,
  path,
  opened,
  onToggleBlock,
  onOpenGap,
  wrap = false,
  currentBlock = null,
  hunks,
  refs,
  syntax: given,
  scrollRef,
  className,
}: DiffViewProps) {
  const { t } = useTranslation('components');
  const [ownOpened, setOwnOpened] = useState<ReadonlySet<number>>(() => new Set());
  const open = opened ?? ownOpened;
  const toggle = (block: number) => {
    if (onToggleBlock) onToggleBlock(block);
    if (!opened)
      setOwnOpened((held) => {
        const next = new Set(held);
        if (!next.delete(block)) next.add(block);
        return next;
      });
  };
  const syntax = useSyntax(diff, path ? languageOfPath(path) : null, given);
  const rows = useMemo(
    () => (mode === 'split' ? splitRows(diff, { hunks }) : mode === 'unified' ? unifiedRows(diff, { hunks }) : readingRows(diff, open, { hunks })),
    [diff, mode, open, hunks],
  );
  const host = useRef<HTMLDivElement>(null);
  const cls = ['diff', MODE_CLASS[mode], wrap ? 'diff-wrap' : '', className ?? ''].filter(Boolean).join(' ');

  const virtual = rows.length > VIRTUAL_OVER;
  const currentIndex = currentBlock === null ? -1 : rows.findIndex((r) => r.type !== 'gap' && r.blockStart && r.block === currentBlock);
  useEffect(() => {
    if (virtual || currentBlock === null) return;
    host.current?.querySelector(`[data-block-start="${currentBlock}"]`)?.scrollIntoView({ block: 'center' });
  }, [currentBlock, virtual]);

  if (diff.binary || diff.tooLarge || (diff.hunks.length === 0 && !diff.truncated)) {
    const note = diff.binary ? t('diff.binary') : diff.tooLarge ? t('diff.tooLarge') : diff.status === 'renamed' ? t('diff.onlyRenamed') : t('diff.noChanges');
    return (
      <div className={cls}>
        <p className="diff-note">{note}</p>
      </div>
    );
  }

  const draw = (row: DiffRow | SplitRow): ReactNode => {
    if (row.type === 'gap') return <GapLine row={row} onOpen={onOpenGap} />;
    if (row.type === 'split') return <SplitLine row={row} syntax={syntax} current={row.block !== null && row.block === currentBlock} />;
    if (row.type === 'seam') return <Seam pill={row.pill} onToggle={toggle} />;
    return <Line row={row} mode={mode} syntax={syntax} onToggle={toggle} current={row.block !== null && row.block === currentBlock} />;
  };

  return (
    <div className={cls} ref={host} data-mode={mode}>
      {mode === 'split' && (
        <div className="diff-row diff-split-head">
          <span />
          <span />
          <span />
          <span>
            {t('diff.before')}
            {refs?.before && <span className="diff-split-ref">{refs.before}</span>}
          </span>
          <span className="diff-split-seam" />
          <span />
          <span />
          <span />
          <span>
            {t('diff.after')}
            {refs?.after && <span className="diff-split-ref">{refs.after}</span>}
          </span>
        </div>
      )}
      {virtual ? (
        <VirtualRows rows={rows} draw={draw} scrollRef={scrollRef} wrap={wrap} currentIndex={currentIndex} />
      ) : (
        rows.map((row) => <Fragment key={row.key}>{draw(row)}</Fragment>)
      )}
      {diff.truncated && <p className="diff-note is-cut">{t('diff.truncated')}</p>}
    </div>
  );
}

function VirtualRows({
  rows,
  draw,
  scrollRef,
  wrap,
  currentIndex,
}: {
  rows: (DiffRow | SplitRow)[];
  draw: (row: DiffRow | SplitRow) => ReactNode;
  scrollRef?: RefObject<HTMLElement | null>;
  wrap: boolean;
  currentIndex: number;
}) {
  // Its own box, not the diff's: a parent's ref is attached only after its children's layout
  // effects have run, so on the first mount the diff's element is not there to measure yet
  const box = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // The rows rarely start at the top of their scroller: a header and a why line sit above them
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const found = scrollRef?.current ?? el.closest<HTMLElement>('[data-scroll-root], .main');
    setScroller(found);
    if (found) setMargin(el.getBoundingClientRect().top - found.getBoundingClientRect().top + found.scrollTop);
  }, [scrollRef]);
  // Stable callbacks: the virtualizer measures every row again whenever one of them changes, which
  // on a 20 000-line diff is the whole frame budget of every scroll
  const estimateSize = useCallback((i: number) => rowHeight(rows[i], wrap), [rows, wrap]);
  const getItemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);
  const getScrollElement = useCallback(() => scroller, [scroller]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: 20,
    scrollMargin: margin,
  });
  useEffect(() => {
    if (currentIndex >= 0) virtualizer.scrollToIndex(currentIndex, { align: 'center' });
  }, [currentIndex, virtualizer]);
  return (
    <div ref={box} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          // Only a wrapped row's height depends on its text; the others are what rowHeight says
          ref={wrap ? virtualizer.measureElement : undefined}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flow-root', transform: `translateY(${item.start - margin}px)` }}
        >
          {draw(rows[item.index]!)}
        </div>
      ))}
    </div>
  );
}

function rowHeight(row: DiffRow | SplitRow | undefined, wrap: boolean): number {
  if (row?.type === 'gap') return 38;
  if (row?.type === 'seam') return 12;
  return wrap ? 19 : 20;
}

// ---------------------------------------------------------------------------------------------
// Rows

function Line({
  row,
  mode,
  syntax,
  onToggle,
  current,
}: {
  row: Extract<DiffRow, { type: 'line' }>;
  mode: DiffMode;
  syntax: DiffSyntax | null;
  onToggle: (block: number) => void;
  current: boolean;
}) {
  const { t } = useTranslation('components');
  const { line, kind } = row;
  const marks = marksOf(line, row.pair);
  const code = <Code text={line.text} roles={rolesOf(syntax, line)} marks={marks} />;
  const said = describe(t, line, kind);
  const start = row.blockStart ? { 'data-block-start': row.block ?? undefined } : {};
  const cls = `diff-row is-${kind}${current ? ' is-current' : ''}`;
  if (mode === 'unified') {
    return (
      <div className={cls} {...start}>
        <span className="sr-only">{said}</span>
        <span className="diff-num" aria-hidden="true">
          {line.old ?? ''}
        </span>
        <span className="diff-num" aria-hidden="true">
          {line.new ?? ''}
        </span>
        <span className="diff-line-rail" aria-hidden="true" />
        <span className="diff-sign" aria-hidden="true">
          {kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}
        </span>
        <span className="diff-code">{code}</span>
      </div>
    );
  }
  return (
    <div className={cls} {...start}>
      <span className="sr-only">{said}</span>
      <span className="diff-num" aria-hidden="true">
        {kind === 'del' ? line.old : line.new}
      </span>
      <span className="diff-line-rail" aria-hidden="true" />
      <span className="diff-code">{code}</span>
      {row.pill && <PillButton pill={row.pill} onToggle={onToggle} />}
    </div>
  );
}

function Seam({ pill, onToggle }: { pill: Pill; onToggle: (block: number) => void }) {
  return (
    <div className="diff-seam" data-block-start={pill.block}>
      <PillButton pill={pill} onToggle={onToggle} />
    </div>
  );
}

function PillButton({ pill, onToggle }: { pill: Pill; onToggle: (block: number) => void }) {
  const { t } = useTranslation('components');
  return (
    <button type="button" className="diff-fold-pill" aria-expanded={pill.open} aria-label={t('diff.removed', { count: pill.count })} onClick={() => onToggle(pill.block)}>
      −{pill.count}
    </button>
  );
}

function GapLine({ row, onOpen }: { row: GapRow; onOpen?: (gap: Gap) => void }) {
  const { t } = useTranslation('components');
  const { gap } = row;
  return (
    <div className="diff-gap">
      <ChevronsUpDown {...ICON_SM} />
      <span>{t('diff.unchanged', { count: gap.size })}</span>
      {gap.where && (
        <span className="diff-gap-in">
          <Trans t={t} i18nKey="diff.inWhere" values={{ where: gap.where }} components={{ where: <span className="diff-gap-where" /> }} />
        </span>
      )}
      {onOpen && (
        <button type="button" className="btn btn-small" onClick={() => onOpen(gap)}>
          {t('diff.show')}
        </button>
      )}
    </div>
  );
}

function SplitLine({ row, syntax, current }: { row: SplitRow; syntax: DiffSyntax | null; current: boolean }) {
  const { t } = useTranslation('components');
  const { left, right } = row;
  const said =
    left?.kind === 'ctx' ? describe(t, left.line, 'ctx') : [left && describe(t, left.line, left.kind), right && describe(t, right.line, right.kind)].filter(Boolean).join(', ');
  return (
    <div className={`diff-row${current ? ' is-current' : ''}`} {...(row.blockStart ? { 'data-block-start': row.block ?? undefined } : {})}>
      <span className="sr-only">{said}</span>
      <Side cell={left} syntax={syntax} />
      <span className="diff-split-seam" aria-hidden="true" />
      <Side cell={right} syntax={syntax} />
    </div>
  );
}

function Side({ cell, syntax }: { cell: SplitCell | null; syntax: DiffSyntax | null }) {
  const kind = cell ? cell.kind : 'pad';
  const no = cell ? (cell.kind === 'del' ? cell.line.old : cell.line.new) : null;
  return (
    <>
      <span className={`diff-num is-${kind}`} aria-hidden="true">
        {no ?? ''}
      </span>
      <span className={`diff-line-rail is-${kind}`} aria-hidden="true" />
      <span className={`diff-sign diff-cell is-${kind}`} aria-hidden="true">
        {kind === 'add' ? '+' : kind === 'del' ? '−' : ''}
      </span>
      <span className={`diff-code diff-cell is-${kind}`}>
        {cell ? <Code text={cell.line.text} roles={rolesOf(syntax, cell.line)} marks={marksOf(cell.line, cell.pair)} /> : ' '}
      </span>
    </>
  );
}

type T = TFunction<'components'>;

function describe(t: T, line: DiffLine, kind: 'ctx' | 'add' | 'del' | 'mod'): string {
  if (kind === 'del') return t('diff.lineRemoved', { n: line.old });
  if (kind === 'add') return t('diff.lineAdded', { n: line.new });
  if (kind === 'mod') return t('diff.lineChanged', { n: line.new });
  return t('diff.lineUnchanged', { n: line.new });
}

// ---------------------------------------------------------------------------------------------
// Code: syntax runs, with the changed phrases marked across them

const words = new Lru<string, WordDiff>(2000);

/** The changed spans of a line against the line it was paired with; nothing when unpaired */
function marksOf(line: DiffLine, pair: DiffLine | null): Range[] {
  if (!pair || line.kind === 'ctx') return [];
  const [before, after] = line.kind === 'del' ? [line.text, pair.text] : [pair.text, line.text];
  const key = `${before}\u0000${after}`;
  let found = words.get(key);
  if (!found) {
    found = wordDiff(before, after);
    words.set(key, found);
  }
  return line.kind === 'del' ? found.old : found.new;
}

function rolesOf(syntax: DiffSyntax | null, line: DiffLine): RoleLine | undefined {
  if (!syntax) return undefined;
  return line.new !== null ? syntax.new.get(line.new) : line.old !== null ? syntax.old.get(line.old) : undefined;
}

/**
 * The class a run is painted with. The GitHub themes colour operators as keywords (`=`, `:`, `*`
 * in red); in the comparator's muted palette they would sprinkle every line, so a keyword run with
 * no letter in it stays in the foreground, as the reference draws it.
 */
export function classOf(text: string, role: Role | null): string | null {
  if (!role) return null;
  if (role === 'keyword' && !/\p{L}/u.test(text)) return null;
  return SYNTAX_CLASS[role];
}

/**
 * A line as spans: runs of plain text grouped, and each changed phrase one `.diff-word` holding its
 * syntax runs. Roles that no longer spell the line (a live diff moved on) are dropped for plain text.
 */
export function Code({ text, roles, marks }: { text: string; roles?: RoleLine; marks: Range[] }) {
  const runs: RoleLine = roles && roles.map((r) => r[0]).join('') === text ? roles : [[text, null]];
  const groups: { marked: boolean; pieces: RoleLine }[] = [];
  let at = 0;
  for (const [run, role] of runs) {
    let from = 0;
    while (from < run.length) {
      const pos = at + from;
      const mark = marks.find(([s, e]) => pos >= s && pos < e);
      // The piece ends where the run, the mark it is in, or the next mark ends first
      const next = mark ? mark[1] : Math.min(...marks.filter(([s]) => s > pos).map(([s]) => s), Number.POSITIVE_INFINITY);
      const to = Math.min(run.length, next - at);
      const piece: [string, typeof role] = [run.slice(from, to), role];
      const last = groups[groups.length - 1];
      if (last && last.marked === !!mark) last.pieces.push(piece);
      else groups.push({ marked: !!mark, pieces: [piece] });
      from = to;
    }
    at += run.length;
  }
  if (groups.length === 0) return <span> </span>;
  return (
    <>
      {groups.map((g, k) => (
        <span key={k} className={g.marked ? 'diff-word' : undefined}>
          {g.pieces.map(([piece, role], n) => {
            const cls = classOf(piece, role);
            return cls ? (
              <span key={n} className={cls}>
                {piece}
              </span>
            ) : (
              piece
            );
          })}
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Syntax

const syntaxCache = new WeakMap<ParsedDiff, Promise<DiffSyntax | null>>();

/**
 * Both sides of the diff as role runs. Each side is read a stretch at a time, the stretch being
 * lines that follow each other in the file, so a comment opened three lines up is still one.
 */
export async function diffSyntax(diff: ParsedDiff, lang: string | null): Promise<DiffSyntax | null> {
  if (!lang) return null;
  const stretches: DiffLine[][] = [];
  let stretch: DiffLine[] = [];
  diff.hunks.forEach((hunk, i) => {
    const gap = diff.gaps[i];
    if (gap?.lines) stretch.push(...gap.lines);
    else if (gap && stretch.length) {
      stretches.push(stretch);
      stretch = [];
    }
    stretch.push(...hunk.lines);
  });
  stretch.push(...(diff.gaps[diff.hunks.length]?.lines ?? []));
  if (stretch.length) stretches.push(stretch);
  const out: DiffSyntax = { old: new Map(), new: new Map() };
  let any = false;
  for (const part of stretches) {
    for (const side of ['old', 'new'] as const) {
      const lines = part.filter((l) => l[side] !== null);
      if (!lines.length) continue;
      const roles = await highlightRoles(lines.map((l) => l.text).join('\n'), lang);
      if (!roles) continue;
      any = true;
      lines.forEach((l, k) => {
        const r = roles[k];
        if (r) out[side].set(l[side]!, r);
      });
    }
  }
  return any ? out : null;
}

/** The diff's syntax, read after the first paint; the last one read stays up while the next is */
function useSyntax(diff: ParsedDiff, lang: string | null, given: DiffSyntax | null | undefined): DiffSyntax | null {
  const [read, setRead] = useState<DiffSyntax | null>(null);
  useEffect(() => {
    if (given !== undefined || !lang) return;
    let live = true;
    let pending = syntaxCache.get(diff);
    if (!pending) {
      pending = diffSyntax(diff, lang).catch(() => null);
      syntaxCache.set(diff, pending);
    }
    void pending.then((s) => {
      if (live) setRead(s);
    });
    return () => {
      live = false;
    };
  }, [diff, lang, given]);
  return given !== undefined ? given : lang ? read : null;
}
