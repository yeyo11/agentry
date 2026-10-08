import type { ChangedFile, EditStep } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { AlignJustify, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Columns2, Copy, Link2, Sparkle, TextQuote } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { blockStarts, diffHash, foldFull, openGap, parseUnified, type Gap, type ParsedDiff } from '../../lib/diff';
import { formatDateTime } from '@agentry/ui/lib/format';
import type { ReviewMode } from '../../lib/review-state';
import { Checkbox, MoreActions, type MenuEntry } from '@agentry/ui/components/controls';
import { ICON_SM } from '@agentry/ui/components/icons';
import { ErrorBox, Segmented, Skeleton, Tag } from '@agentry/ui/components/ui';
import { ScrollingBlockRail } from './BlockRail';
import { DiffView } from './DiffView';
import { DraftsChip, useDraftNotes } from './DraftNotes';
import { Counts } from './FileMap';
import { Intent } from './Intent';
import { FileThreadsFold, ThreadsChip, threadLayer, useFileThreads, useReviewThreads } from './ReviewThreads';
import { hourMinute, reviewKey, scopeQuery, splitPath, type ReviewScope } from './review-model';
import { LIVE_REFRESH_MS, type ReviewSource } from './source';
import { plainIntent } from './steps/steps-model';
import { copyText } from '@agentry/ui/lib/clipboard';

// One file of the review: its header, the why line, and the diff with its block rail. It reads the
// diff in the review's scope, and the whole file (`context=full`) once, when a gap is opened that the
// loaded diff cannot open by itself.

/** Past this many lines a file is never asked for whole, and its gaps stay shut */
export const FULL_LIMIT = 5_000;

const MODE_ICON: Record<ReviewMode, typeof AlignJustify> = { reading: TextQuote, unified: AlignJustify, split: Columns2 };

const copy = (text: string): Promise<boolean> => copyText(text);

const linesOf = (d: ParsedDiff) => d.hunks.reduce((n, h) => n + h.lines.length, 0);

export interface FileNav {
  prev: ChangedFile | null;
  next: ChangedFile | null;
  to: (path: string) => string;
  go: (path: string) => void;
  /** `[`: fold or unfold the file map, where it can */
  toggleMap?: () => void;
  /** `/`: the map's filter */
  focusFilter?: () => void;
}

export function FileReview({
  source,
  file,
  scope,
  mode,
  modes,
  onMode,
  seen,
  onSeen,
  onHash,
  steps,
  stepHref,
  phone,
  nav,
  back,
  refs,
  paneLabel,
  review,
}: {
  source: ReviewSource;
  file: ChangedFile;
  scope: ReviewScope;
  /** The mode drawn: what was asked for, as far as the room and the file allow */
  mode: ReviewMode;
  /** The modes offered here */
  modes: ReviewMode[];
  onMode: (mode: ReviewMode) => void;
  seen: boolean;
  /** Toggle "seen"; `andNext` when it came from `v`, which moves on to the next file */
  onSeen: (on: boolean, hash: string | null, andNext: boolean) => void;
  /** The diff's hash once read, so a file that changed since it was seen reads as unseen */
  onHash: (hash: string) => void;
  /** The steps that touched this file, oldest first; null where the source has no transcript */
  steps: EditStep[] | null;
  stepHref: (stepId: string) => string;
  phone: boolean;
  nav: FileNav;
  /** The phone's way back to the list of files */
  back?: string;
  refs?: { before?: string; after?: string };
  paneLabel?: string;
  /**
   * The change request this diff belongs to: its threads are drawn on their lines and its file-level
   * ones above the diff, and a line offers a note for the draft review. Absent where the source has no
   * change request (a chat, a task), and then nothing of the review is drawn or offered. `notes` is whether
   * the page can send the draft review: where it cannot, threads are read and no note is offered.
   */
  review?: { changeRequestId: string; notes: boolean };
}) {
  const { t, i18n } = useTranslation('changes');
  const live = source.live;
  const scoped = scopeQuery(scope);

  // ---- the diff, and the whole file once a gap needs it ----
  const main = source.diff(file.path, scoped);
  const q = useQuery({ ...main, refetchInterval: live ? LIVE_REFRESH_MS : false });
  const [wantFull, setWantFull] = useState(false);
  const whole = source.diff(file.path, { ...scoped, context: 'full' });
  const fullQ = useQuery({ ...whole, enabled: wantFull, refetchInterval: live && wantFull ? LIVE_REFRESH_MS : false });
  const base = useMemo(() => (q.data ? parseUnified(q.data.diff) : null), [q.data]);
  const fullParsed = useMemo(() => (fullQ.data?.full ? foldFull(parseUnified(fullQ.data.diff, true)) : null), [fullQ.data]);
  const tooBig = base ? linesOf(base) > FULL_LIMIT || base.newLength > FULL_LIMIT || file.additions + file.deletions > FULL_LIMIT : false;
  // The new-file lines of the gaps opened so far: a position survives the diff being read again
  const [openAt, setOpenAt] = useState<number[]>([]);
  const shown = useMemo(() => {
    let d = fullParsed ?? base;
    if (!d) return null;
    for (const at of openAt) {
      const gap = d.gaps.find((g): g is Gap => !!g && !!g.lines && at >= g.newStart && at < g.newStart + Math.max(g.size, 1));
      if (gap) d = openGap(d, gap.index);
    }
    return d;
  }, [base, fullParsed, openAt]);
  const refused = fullQ.data !== undefined && !fullQ.data.full;
  const canAsk = !tooBig && !refused;
  const anyOpenable = shown?.gaps.some((g) => g && (g.lines || canAsk)) ?? false;
  const onOpenGap = (gap: Gap) => {
    if (!gap.lines && !canAsk) return;
    setOpenAt((held) => [...held, gap.newStart]);
    if (!gap.lines) setWantFull(true);
  };

  const hash = q.data ? diffHash(q.data.diff) : null;
  const onHashRef = useRef(onHash);
  onHashRef.current = onHash;
  useEffect(() => {
    if (hash) onHashRef.current(hash);
  }, [hash]);

  // ---- the review's threads on this file ----
  const threadsQ = useReviewThreads(review?.changeRequestId);
  const mine = useFileThreads(threadsQ.data, file.path);
  const notes = useDraftNotes({ changeRequestId: review?.notes ? review.changeRequestId : undefined, path: file.path, diff: shown, head: threadsQ.data?.headSha });
  // The layer follows the notes' state (the composer, the drafts), so it is built on every render
  const layer = review ? threadLayer({ changeRequestId: review.changeRequestId, file: mine.file, phone, extra: notes.extra, onAddNote: notes.onAddNote }) : undefined;

  // ---- blocks ----
  const marks = useMemo(() => (shown ? blockStarts(shown) : []), [shown]);
  const [current, setCurrent] = useState<number | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const toggleBlock = (block: number) =>
    setOpened((held) => {
      const next = new Set(held);
      if (!next.delete(block)) next.add(block);
      return next;
    });
  const step = (delta: 1 | -1) => {
    if (marks.length === 0) return;
    setCurrent((c) => (c === null ? (delta > 0 ? 0 : marks.length - 1) : Math.min(marks.length - 1, Math.max(0, c + delta))));
  };

  // ---- keyboard: j/k blocks, o the removed lines, v seen and next ----
  const keyed = useRef({ step, toggle: () => {}, seen: () => {} });
  keyed.current = {
    step,
    toggle: () => {
      if (mode !== 'reading' || current === null) return;
      const m = marks[current];
      if (m && m.dels > 0) toggleBlock(current);
    },
    seen: () => onSeen(!seen, hash, true),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = reviewKey(e);
      if (key === 'j') keyed.current.step(1);
      else if (key === 'k') keyed.current.step(-1);
      else if (key === 'o') keyed.current.toggle();
      else if (key === 'v') keyed.current.seen();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const { dir, name } = splitPath(file.path);
  const latest = steps && steps.length > 0 ? steps[steps.length - 1]! : null;

  const modeOptions = modes.map((m) => {
    const Icon = MODE_ICON[m];
    return {
      value: m,
      title: t(`mode.${m}Hint`),
      label: (
        <>
          <Icon {...ICON_SM} />
          <span className="changes-mode-name">{t(`mode.${m}`)}</span>
        </>
      ),
    };
  });

  const blocks = (
    <span className="changes-blocks">
      <button type="button" className="icon-btn" aria-label={t('block.prev')} aria-keyshortcuts="k" disabled={marks.length === 0} onClick={() => step(-1)}>
        <ChevronUp {...ICON_SM} />
      </button>
      <span className="changes-blocks-count" aria-live="polite">
        <span aria-hidden>
          {current === null ? '–' : current + 1} / {marks.length}
        </span>
        <span className="sr-only">{marks.length === 0 ? t('block.none') : t('block.counter', { n: current === null ? 0 : current + 1, total: marks.length })}</span>
      </span>
      <button type="button" className="icon-btn" aria-label={t('block.next')} aria-keyshortcuts="j" disabled={marks.length === 0} onClick={() => step(1)}>
        <ChevronDown {...ICON_SM} />
      </button>
    </span>
  );

  const seenChip = (
    <Checkbox className="check changes-seen" checked={seen} onChange={(on) => onSeen(on, hash, false)}>
      {t('seen')}
      {!phone && (
        <span className="palette-kbd" aria-hidden>
          v
        </span>
      )}
    </Checkbox>
  );

  const menu: MenuEntry[] = [
    { id: 'path', label: t('more.copyPath'), icon: Link2, onSelect: () => void copy(file.path) },
    { id: 'diff', label: t('more.copyDiff'), icon: Copy, disabled: !q.data, onSelect: () => q.data && void copy(q.data.diff) },
  ];
  if (!phone)
    menu.push({ id: 'sep', separator: true }, {
      id: 'keys',
      label: t('more.keys'),
      items: [
        { id: 'j', label: t('keys.nextBlock'), shortcut: 'j', onSelect: () => step(1) },
        { id: 'k', label: t('keys.prevBlock'), shortcut: 'k', onSelect: () => step(-1) },
        { id: 'n', label: t('keys.nextFile'), shortcut: 'n', disabled: !nav.next, onSelect: () => nav.next && nav.go(nav.next.path) },
        { id: 'p', label: t('keys.prevFile'), shortcut: 'p', disabled: !nav.prev, onSelect: () => nav.prev && nav.go(nav.prev.path) },
        { id: 'v', label: t('keys.seenNext'), shortcut: 'v', onSelect: () => onSeen(!seen, hash, true) },
        { id: 'm', label: t('keys.mode'), shortcut: 'm', onSelect: () => onMode(modes[(modes.indexOf(mode) + 1) % modes.length] ?? 'reading') },
        { id: 'o', label: t('keys.fold'), shortcut: 'o', disabled: mode !== 'reading', onSelect: () => keyed.current.toggle() },
        { id: '[', label: t('keys.map'), shortcut: '[', disabled: !nav.toggleMap, onSelect: nav.toggleMap },
        { id: '/', label: t('keys.filter'), shortcut: '/', disabled: !nav.focusFilter, onSelect: nav.focusFilter },
      ],
    });

  const why = latest && (latest.intent || latest.at) && (
    <div className="changes-why">
      <Sparkle {...ICON_SM} fill="currentColor" className="changes-why-spark" />
      <span className="sr-only">{t('why.label')}</span>
      {phone ? (
        // A phone has no room for a line of its own: the count follows the sentence
        <span className="changes-why-text">
          {latest.intent && <Intent text={latest.intent} />} <span className="changes-why-when">{t('why.latest', { count: steps?.length ?? 1 })}</span>
        </span>
      ) : (
        <>
          {latest.intent && (
            <span className="changes-why-text" title={plainIntent(latest.intent)}>
              <Intent text={latest.intent} />
            </span>
          )}
          <span className="changes-why-when" title={latest.at ? formatDateTime(latest.at) : undefined}>
            {t('why.latest', { count: steps?.length ?? 1 })}
            {latest.at ? ` · ${hourMinute(latest.at, i18n.language)}` : ''}
          </span>
        </>
      )}
      {!phone && (
        <Link className="changes-why-link" to={stepHref(latest.id)}>
          {t('why.seeSteps')}
        </Link>
      )}
    </div>
  );

  let body: ReactNode;
  if (q.error) body = <div className="changes-pane-state"><ErrorBox error={q.error} /></div>;
  else if (!shown) body = <div className="changes-pane-state"><Skeleton rows={8} height={14} /></div>;
  else
    body = (
      <div className="changes-diff-box">
        <div className="changes-diff-scroll" ref={scrollRef} data-scroll-root>
          {tooBig && <p className="changes-diff-note">{t('blocksOnly')}</p>}
          <div className="changes-diff-content" ref={contentRef}>
            {review && mine.file && <FileThreadsFold changeRequestId={review.changeRequestId} file={mine.file} phone={phone} />}
            <DiffView
              diff={shown}
              mode={mode}
              path={file.path}
              opened={opened}
              onToggleBlock={toggleBlock}
              onOpenGap={anyOpenable ? onOpenGap : undefined}
              wrap={phone}
              currentBlock={current}
              refs={refs}
              scrollRef={scrollRef}
              layer={layer}
            />
          </div>
        </div>
        {!phone && marks.length > 0 && (
          <ScrollingBlockRail scroller={scrollRef} content={contentRef} marks={marks} total={Math.max(shown.newLength, 1)} current={current} onJump={(b) => setCurrent(b)} />
        )}
      </div>
    );

  const badge = file.binary ? 'binary' : file.status !== 'modified' ? file.status : null;
  // Nothing to compare line by line (binary, too large, only renamed): no mode and no blocks to offer.
  // While the diff loads, the controls stay, so the header does not jump
  const textual = !shown || (!shown.binary && !shown.tooLarge && shown.hunks.length > 0);

  if (phone)
    return (
      <section className="changes-phone-file changes-pane" aria-label={paneLabel ?? file.path}>
        <header className="changes-phone-head">
          {back && (
            <Link to={back} className="icon-btn" aria-label={t('phone.backToFiles')}>
              <ChevronLeft size={20} strokeWidth={1.75} aria-hidden />
            </Link>
          )}
          <div className="changes-head-text">
            <span className="changes-phone-name">{name}</span>
            <span className="changes-phone-sub">
              {dir && <span className="changes-phone-dir">{dir}</span>}
              {dir && <span aria-hidden>·</span>}
              <Counts additions={file.additions} deletions={file.deletions} binary={file.binary} />
            </span>
          </div>
          {seenChip}
          <MoreActions entries={menu} label={t('more.label')} />
        </header>
        {(mine.threads.length > 0 || notes.count > 0) && (
          <div className="changes-phone-modes">
            <ThreadsChip threads={mine.threads} />
            <DraftsChip count={notes.count} />
          </div>
        )}
        {textual && (
          <div className="changes-phone-modes">
            <Segmented value={mode} options={modes.map((m) => ({ value: m, label: t(`mode.${m}`) }))} onChange={onMode} label={t('mode.label')} />
            {mode === 'reading' && marks.some((m) => m.dels > 0) && (
              <span className="changes-phone-hint">
                <Trans t={t} i18nKey="phone.tapPill" components={{ pill: <span className="diff-fold-pill" aria-hidden /> }} />
              </span>
            )}
          </div>
        )}
        {why}
        {body}
        <nav className="changes-phone-bar" aria-label={t('map.label')}>
          {nav.prev ? (
            <Link to={nav.to(nav.prev.path)} replace className="changes-phone-step" aria-label={t('phone.prevFile', { name: splitPath(nav.prev.path).name })}>
              <ChevronLeft {...ICON_SM} />
              <span>{splitPath(nav.prev.path).name}</span>
            </Link>
          ) : (
            <span className="changes-phone-step" />
          )}
          {blocks}
          {nav.next ? (
            <Link to={nav.to(nav.next.path)} replace className="changes-phone-step is-next" aria-label={t('phone.nextFile', { name: splitPath(nav.next.path).name })}>
              <span>{splitPath(nav.next.path).name}</span>
              <ChevronRight {...ICON_SM} />
            </Link>
          ) : (
            <span className="changes-phone-step" />
          )}
        </nav>
      </section>
    );

  return (
    <section className="changes-pane" aria-label={paneLabel ?? file.path}>
      <div className="changes-file-head">
        <span className="changes-path" title={file.path}>
          {dir && <span className="changes-path-dir">{dir}/</span>}
          <span className="changes-path-name">{name}</span>
        </span>
        {badge && (
          <span className="changes-badge">
            <Tag>{t(`status.${badge}`)}</Tag>
          </span>
        )}
        {!file.binary && <Counts additions={file.additions} deletions={file.deletions} />}
        <ThreadsChip threads={mine.threads} />
        <DraftsChip count={notes.count} />
        {textual && (
          <>
            <span className="changes-sep" aria-hidden />
            <span className="changes-modes">
              <Segmented value={mode} options={modeOptions} onChange={onMode} label={t('mode.label')} />
            </span>
            {blocks}
          </>
        )}
        {seenChip}
        <MoreActions entries={menu} label={t('more.label')} />
      </div>
      {why}
      {body}
    </section>
  );
}
