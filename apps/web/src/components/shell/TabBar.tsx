import { BookOpen, Ellipsis, Plus, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { Menu, type MenuEntry } from '../controls/Menu';
import { Sheet } from '../controls/Sheet';
import { ICON } from '../icons';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** What the badge counts, for the screen reader */
  count?: { value: number | undefined; what: string };
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
    <span className="tabbar-badge">
      <span aria-hidden>{count.value > 99 ? '99+' : count.value}</span>
      <span className="sr-only">
        {count.value} {count.what}
      </span>
    </span>
  );
}

/**
 * A phone's navigation: the three places a person goes most, a "New" menu and "More" for the rest,
 * at the bottom edge where a thumb reaches. It replaces the slide-over sidebar below 900 px.
 */
export function TabBar({
  pathname,
  tabs,
  more,
  newEntries,
  connection,
}: {
  pathname: string;
  tabs: NavItem[];
  more: NavItem[];
  newEntries: MenuEntry[];
  /** The connection status, as the sidebar's footer shows it */
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
      <Menu
        entries={newEntries}
        label={t('tabbar.newMenu')}
        side="top"
        align="center"
        trigger={
          <button type="button" className="tabbar-tab tabbar-new">
            <span className="tabbar-icon tabbar-new-icon">
              <Plus {...ICON} />
            </span>
            <span className="tabbar-label">{t('tabbar.new')}</span>
          </button>
        }
      />
      <button type="button" className={`tabbar-tab tabbar-more ${moreActive ? 'is-active' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="tabbar-icon">
          <Ellipsis {...ICON} />
          <NavDot label={moreDot} />
        </span>
        <span className="tabbar-label">{t('tabbar.more')}</span>
      </button>

      <Sheet open={open} onOpenChange={setOpen} title={t('tabbar.more')} side="bottom" className="more-sheet">
        <div className="more-nav">
          {more.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={navTarget(item)} className={`nav-link ${isActive(item, pathname) ? 'is-active' : ''}`} onClick={() => setOpen(false)}>
                <span className="nav-icon">
                  <Icon {...ICON} />
                </span>
                <span className="nav-label">{item.label}</span>
                <NavDot label={item.dot} />
              </NavLink>
            );
          })}
          <a href="/docs" target="_blank" rel="noopener noreferrer" className="nav-link">
            <span className="nav-icon">
              <BookOpen {...ICON} />
            </span>
            <span className="nav-label">{t('components:nav.apiReference')}</span>
          </a>
        </div>
        {/* The status is a link to the account settings, which may be the page already open */}
        <div className="more-connection" onClick={() => setOpen(false)}>
          <span className="more-connection-head">{t('tabbar.connection')}</span>
          {connection}
        </div>
      </Sheet>
    </nav>
  );
}
