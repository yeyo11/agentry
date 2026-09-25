import { BookOpen, ChevronRight, Menu as MenuIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import type { MenuItem } from '../controls/Menu';
import { Sheet } from '../controls/Sheet';
import { ICON, ICON_SM } from '../icons';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** What the badge counts, for the screen reader */
  count?: { value: number | undefined; what: string; live?: boolean };
  /** Something here wants a look (a newer Agentry): shown as a dot, and this is what it says to a screen reader */
  dot?: string;
  /** Where the link lands inside the page, e.g. the settings tab the dot is about */
  search?: string;
}

/** The link's target: the page, plus the tab its dot points at */
export function navTarget(item: NavItem): string | { pathname: string; search: string } {
  return item.search ? { pathname: item.to, search: item.search } : item.to;
}

/** A dot with words for the screen reader; never a count, never colour alone (it is there or not) */
export function NavDot({ label }: { label: string | undefined }) {
  if (!label) return null;
  return (
    <span className="nav-dot">
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/';
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
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

/**
 * A phone's navigation: the three places a person goes most and "More" for the rest, at the bottom
 * edge where a thumb reaches. It replaces the sidebar below 900 px. Starting something is the
 * floating button's job (`Fab`), and the rest of what can be started is in the More sheet.
 */
export function TabBar({
  pathname,
  tabs,
  more,
  start,
  account,
  connection,
}: {
  pathname: string;
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
  const moreActive = more.some((item) => isActive(item, pathname));
  // Settings lives behind "More" on a phone, so its dot shows on the button that leads there
  const moreDot = more.find((item) => item.dot)?.dot;

  return (
    <nav className="tabbar" aria-label={t('tabbar.label')}>
      {tabs.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink key={item.to} to={navTarget(item)} end={item.to === '/'} className={`tabbar-tab ${isActive(item, pathname) ? 'is-active' : ''}`}>
            <span className="tabbar-icon">
              <Icon {...ICON} />
              <Badge count={item.count} />
              <NavDot label={item.dot} />
            </span>
            <span className="tabbar-label">{item.label}</span>
          </NavLink>
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
          <nav className="more-nav" aria-label={t('tabbar.sections')}>
            {more.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink key={item.to} to={navTarget(item)} className={`more-cell ${isActive(item, pathname) ? 'is-active' : ''}`}>
                  <span className="more-cell-icon">
                    <Icon {...ICON} />
                  </span>
                  <span className="more-cell-label">{item.label}</span>
                  <NavDot label={item.dot} />
                  <ChevronRight {...ICON_SM} className="more-cell-chevron" aria-hidden />
                </NavLink>
              );
            })}
          </nav>
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
