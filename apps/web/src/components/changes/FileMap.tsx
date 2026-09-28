import type { ChangedFile } from '@agentry/shared';
import { Check, ChevronDown, PanelLeft, Search } from 'lucide-react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Tooltip } from '../controls';
import { ICON_SM } from '../icons';
import { Spinner } from '../Spinner';
import { groupByDir, splitPath, statusLetter } from './review-model';

// The file map of the review screen (design system §5): the tree by directory, each file a row with
// its status letter, name, counts, and what is true of it now (not committed yet, seen, being
// edited). Folded, it is a 48 px rail of status letters.

export interface MapFile {
  file: ChangedFile;
  uncommitted: boolean;
  seen: boolean;
  live: boolean;
}

export function Counts({ additions, deletions, binary = false }: { additions: number; deletions: number; binary?: boolean }) {
  const { t } = useTranslation('changes');
  if (binary) return <span className="changes-counts">{t('status.binary')}</span>;
  return (
    <span className="changes-counts">
      <span className="sr-only">{t('meta.counts', { additions, deletions })}</span>
      <span aria-hidden className="is-add">
        {additions > 0 ? `+${additions}` : ''}
      </span>{' '}
      <span aria-hidden className="is-del">
        {deletions > 0 ? `−${deletions}` : ''}
      </span>
    </span>
  );
}

export function StatusLetter({ file }: { file: ChangedFile }) {
  const letter = statusLetter(file);
  return (
    <span className={`changes-st is-${letter.toLowerCase()}`} aria-hidden>
      {letter}
    </span>
  );
}

/** What a row says in words, for its title and a screen reader: status, not committed, seen, live */
export function useRowWords() {
  const { t } = useTranslation('changes');
  return (m: MapFile) =>
    [
      m.file.path,
      t(m.file.binary ? 'status.binary' : `status.${m.file.status}`),
      m.file.previousPath ? t('row.renamedFrom', { path: m.file.previousPath }) : null,
      m.uncommitted ? t('row.uncommitted') : null,
      m.seen ? t('row.seen') : null,
      m.live ? t('row.live') : null,
    ]
      .filter(Boolean)
      .join(' · ');
}

export function FileMap({
  files,
  current,
  to,
  filter,
  onFilter,
  filterRef,
  folded,
  onFold,
  seenCount,
  total,
  onPointer,
}: {
  files: MapFile[];
  current: string | null;
  to: (path: string) => string;
  filter: string;
  onFilter: (value: string) => void;
  filterRef: RefObject<HTMLInputElement | null>;
  folded: boolean;
  /** Absent where the map cannot unfold (Side by side) */
  onFold?: () => void;
  seenCount: number;
  total: number;
  /** The pointer came in or went out: the rows must not move while it is over them */
  onPointer: (inside: boolean) => void;
}) {
  const { t } = useTranslation('changes');
  const words = useRowWords();

  if (folded)
    return (
      <aside className="changes-map is-folded" aria-label={t('map.label')} onPointerEnter={() => onPointer(true)} onPointerLeave={() => onPointer(false)}>
        {onFold && (
          <Tooltip content={t('map.unfold')}>
            <button type="button" className="icon-btn" aria-label={t('map.unfold')} aria-keyshortcuts="[" onClick={onFold}>
              <PanelLeft {...ICON_SM} />
            </button>
          </Tooltip>
        )}
        <nav className="changes-tree" aria-label={t('map.label')}>
          {files.map((m) => (
            <Link
              key={m.file.path}
              to={to(m.file.path)}
              replace
              className={`changes-rail-file changes-st is-${statusLetter(m.file).toLowerCase()}${m.file.path === current ? ' is-current' : ''}${m.live ? ' is-live' : ''}`}
              aria-current={m.file.path === current ? 'page' : undefined}
              aria-label={words(m)}
              title={words(m)}
            >
              <span aria-hidden>{statusLetter(m.file)}</span>
            </Link>
          ))}
        </nav>
      </aside>
    );

  const pct = total > 0 ? Math.round((seenCount / total) * 100) : 0;
  return (
    <aside className="changes-map" aria-label={t('map.label')}>
      <div className="changes-map-head">
        {/* Folding is `[`, and the file's ⋯ menu for a pointer: the reference keeps this row to the count */}
        <span className="section-label">{t('map.title')}</span>
        <span className="count">{total}</span>
        <span className="changes-seen-of">{t('map.seenOf', { seen: seenCount, total })}</span>
        <span className="meter-track meter-thin changes-seen-bar" aria-hidden>
          <span className="meter-fill" style={{ display: 'block', width: `${pct}%` }} />
        </span>
      </div>
      <div className="changes-filter">
        <label className="list-toolbar-search">
          <Search {...ICON_SM} />
          <input ref={filterRef} type="search" value={filter} placeholder={t('map.filter')} aria-label={t('map.filter')} aria-keyshortcuts="/" onChange={(e) => onFilter(e.target.value)} />
          <span className="palette-kbd" aria-hidden>
            /
          </span>
        </label>
      </div>
      <nav className="changes-tree" aria-label={t('map.label')} onPointerEnter={() => onPointer(true)} onPointerLeave={() => onPointer(false)}>
        {files.length === 0 && filter && <p className="changes-empty-map">{t('map.noMatch')}</p>}
        {groupByDir(files.map((m) => ({ ...m, path: m.file.path }))).map((group) => (
          <div key={group.dir || '.'} role="group" aria-label={group.dir || '/'}>
            {group.dir && (
              <div className="changes-dir" aria-hidden>
                <ChevronDown size={12} strokeWidth={1.75} />
                {group.dir}
              </div>
            )}
            {group.files.map((m) => (
              <FileRow key={m.file.path} m={m} current={m.file.path === current} to={to(m.file.path)} words={words(m)} />
            ))}
          </div>
        ))}
      </nav>
      <MapLegend />
    </aside>
  );
}

function FileRow({ m, current, to, words }: { m: MapFile; current: boolean; to: string; words: string }) {
  const { name } = splitPath(m.file.path);
  const cls = ['changes-file', current ? 'is-current' : '', m.seen ? 'is-seen' : '', m.live ? 'is-live' : ''].filter(Boolean).join(' ');
  return (
    <Link to={to} replace className={cls} title={words} aria-label={words} aria-current={current ? 'page' : undefined}>
      <StatusLetter file={m.file} />
      <span className="changes-file-main">
        <span className="changes-file-name">{name}</span>
        {m.uncommitted && <span className="changes-dot" aria-hidden />}
      </span>
      <span className="changes-file-end" aria-hidden>
        {m.seen && <Check size={14} strokeWidth={2.2} />}
        {m.live && <Spinner />}
        <Counts additions={m.file.additions} deletions={m.file.deletions} binary={m.file.binary} />
      </span>
    </Link>
  );
}

export function MapLegend({ keys = true }: { keys?: boolean }) {
  const { t } = useTranslation('changes');
  return (
    <div className="changes-map-foot">
      <span className="changes-legend">
        <span className="changes-dot" aria-hidden />
        {t('map.legendUncommitted')}
        <span className="changes-legend-gap" />
        <Spinner />
        {t('map.legendLive')}
      </span>
      {keys && (
        <span className="changes-legend" aria-hidden>
          <span className="palette-kbd">j</span>
          <span className="palette-kbd">k</span>
          {t('map.blocks')}
          <span className="changes-legend-gap" />
          <span className="palette-kbd">n</span>
          <span className="palette-kbd">p</span>
          {t('map.files')}
        </span>
      )}
    </div>
  );
}
