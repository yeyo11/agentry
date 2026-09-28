/**
 * The shell's sections as the sidebar, the tab bar and the More sheet list them, and which one is
 * current. Pure, so it is tested without a browser (test/shell-nav.test.ts).
 */
import type { LucideIcon } from 'lucide-react';

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

/**
 * Whether a section is where the person is. A project's page lives at `/` (Home with a project in
 * scope, and its tabs), but it is one of the projects, so Projects is the current section there and
 * Home is not, as every project screen of the reference draws it; on a phone that is "More".
 */
export function isActive(item: NavItem, pathname: string, projectPage = false): boolean {
  if (item.to === '/') return pathname === '/' && !projectPage;
  if (item.to === '/projects' && projectPage && pathname === '/') return true;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
