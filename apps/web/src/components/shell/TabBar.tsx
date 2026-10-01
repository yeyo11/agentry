import { BookOpen, ChevronRight, Menu as MenuIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { MenuItem } from '@agentry/ui/components/controls/Menu';
import { Sheet } from '@agentry/ui/components/controls/Sheet';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { Tag } from '@agentry/ui/components/ui';
import { formatCost, formatNumber } from '@agentry/ui/lib/format';
import type { MoreNote } from '../../lib/shell-live';
import { isActive, navTarget, type NavItem } from './nav';
import { useMoreNotes } from './more-notes';

export { isActive, navTarget, type NavItem } from './nav';

/** A dot with words for the screen reader; never a count, never colour alone (it is there or not) */
export function NavDot({ label }: { label: string | undefined }) {
  if (!label) return null;
  return (
    <span className="nav-dot">
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Badge({ count }: { count: NavItem['count'] }) {
  if (!count?.value) return null;
  return (
    <span className={`tabbar-badge ${count.live ? 'is-live' : ''}`.trim()}>
      <span aria-hidden>{count.value > 99 ? '99+' : count.value}</span>
      <span className="sr-only">
        {count.value} {count.what}
      </span>
    </span>
  );
}

/** A section's figure: a count or a cost in mono, a problem as a badge with its word and icon */
function CellNote({ note }: { note: MoreNote | undefined }) {
  const { t } = useTranslation('shell');
  if (!note) return null;
  switch (note.kind) {
    case 'exhausted':
      return <Tag tone="bad">{t('tabbar.exhausted', { count: note.value })}</Tag>;
    case 'pending':
      return <Tag tone="warn">{t('tabbar.pending', { count: note.value })}</Tag>;
    case 'cost':
      return <span className="more-cell-note">{note.value === null ? t('statusbar.todayNone') : t('statusbar.today', { cost: formatCost(note.value) })}</span>;
    case 'count':
      return <span className="more-cell-note">{formatNumber(note.value)}</span>;
    case 'open':
      return <span className="more-cell-note">{t('tasks.openCount', { count: note.value, n: formatNumber(note.value) })}</span>;
  }
}

/**
 * The sheet's sections, a component of their own so that their figures are read only while the
 * sheet is open: its content is not mounted while it is closed.
 */
function MoreSections({ items, pathname, projectPage, label }: { items: NavItem[]; pathname: string; projectPage: boolean; label: string }) {
  const notes = useMoreNotes();
  return (
    <nav className="more-nav" aria-label={label}>
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(item, pathname, projectPage);
        return (
          <Link key={item.to} to={navTarget(item)} aria-current={active ? 'page' : undefined} className={`more-cell ${active ? 'is-active' : ''}`}>
            <span className="more-cell-icon">
              <Icon {...ICON} />
            </span>
            <span className="more-cell-label">{item.label}</span>
            <CellNote note={notes[item.to]} />
            <NavDot label={item.dot} />
            <ChevronRight {...ICON_SM} className="more-cell-chevron" aria-hidden />
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A phone's navigation: the three places a person goes most and "More" for the rest, at the bottom
 * edge where a thumb reaches. It replaces the sidebar below 900 px. Starting something is the
 * floating button's job (`Fab`), and the rest of what can be started is in the More sheet.
 */
export function TabBar({
  pathname,
  projectPage = false,
  tabs,
  more,
  start,
  account,
  connection,
}: {
  pathname: string;
  /** `/` is a project's page (`isActive`): its section is behind "More" */
  projectPage?: boolean;
  tabs: NavItem[];
  more: NavItem[];
  /** What else a person can start, besides the floating button's own action */
  start: MenuItem[];
  /** The account and its limits, first in the sheet */
  account: ReactNode;
  /** The connection status, as the status bar shows it on a desktop */
  connection: ReactNode;
}) {
  const { t } = useTranslation(['shell', 'components']);
  const [open, setOpen] = useState(false);
  // Following a link closes the sheet; the page takes focus from there
  useEffect(() => setOpen(false), [pathname]);
  const moreActive = more.some((item) => isActive(item, pathname, projectPage));
  // Settings lives behind "More" on a phone, so its dot shows on the button that leads there
  const moreDot = more.find((item) => item.dot)?.dot;

  return (
    <nav className="tabbar" aria-label={t('tabbar.label')}>
      {tabs.map((item) => {
        const Icon = item.icon;
        const active = isActive(item, pathname, projectPage);
        return (
          <Link key={item.to} to={navTarget(item)} aria-current={active ? 'page' : undefined} className={`tabbar-tab ${active ? 'is-active' : ''}`}>
            <span className="tabbar-icon">
              <Icon {...ICON} />
              <Badge count={item.count} />
              <NavDot label={item.dot} />
            </span>
            <span className="tabbar-label">{item.label}</span>
          </Link>
        );
      })}
      <button type="button" className={`tabbar-tab tabbar-more ${moreActive || open ? 'is-active' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="tabbar-icon">
          <MenuIcon {...ICON} />
          <NavDot label={moreDot} />
        </span>
        <span className="tabbar-label">{t('tabbar.more')}</span>
      </button>

      <Sheet open={open} onOpenChange={setOpen} title={t('tabbar.more')} side="bottom" className="more-sheet">
        {/* Every link in here leads away, and one may be to the page already open */}
        <div className="more-body" onClick={(event) => (event.target as HTMLElement).closest('a') && setOpen(false)}>
          {account}
          <MoreSections items={more} pathname={pathname} projectPage={projectPage} label={t('tabbar.sections')} />
          {start.length > 0 && (
            <div className="more-group" role="group" aria-labelledby="more-start-head">
              <span id="more-start-head" className="more-group-head">
                {t('tabbar.start')}
              </span>
              <div className="more-nav">
                {start.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className="more-cell"
                      onClick={() => {
                        setOpen(false);
                        entry.onSelect?.();
                      }}
                    >
                      <span className="more-cell-icon">{Icon && <Icon {...ICON} />}</span>
                      <span className="more-cell-label">{entry.label}</span>
                      <ChevronRight {...ICON_SM} className="more-cell-chevron" aria-hidden />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <a href="/docs" target="_blank" rel="noopener noreferrer" className="more-link">
            <BookOpen {...ICON} aria-hidden />
            {t('components:nav.apiReference')}
          </a>
          <div className="more-group">
            <span className="more-group-head">{t('tabbar.connection')}</span>
            {connection}
          </div>
        </div>
      </Sheet>
    </nav>
  );
}
