import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { useProjectScope } from '../../lib/project-scope';
import { MoreActions } from '@agentry/ui/components/controls/MoreActions';
import type { MenuEntry } from '@agentry/ui/components/controls/Menu';
import { ICON } from '@agentry/ui/components/icons';
import { BackButton } from './BackButton';
import { phoneHeaderOf, type PhoneHeaderMark } from './phone-header';

/** Inside the desktop app the top bar is the window's title bar, so it stays at any width. */
const inDesktopApp = () => typeof document !== 'undefined' && document.documentElement.classList.contains('is-desktop');

/** Who heads the current route on a phone (phone-header.ts), with a project's page resolved from the scope. */
export function usePhoneHeaderMark(): PhoneHeaderMark {
  const { pathname } = useLocation();
  const { project } = useProjectScope();
  return phoneHeaderOf(pathname, pathname === '/' && Boolean(project));
}

/**
 * Whether this page heads itself right now: a phone, in a browser, on a route the shell marked
 * `phoneHeader: 'page'` (phone-header.ts). The shell hides its top bar from this same hook, so a
 * page that draws `PhoneHeader` when this is true is never headed twice, nor left without a head.
 */
export function useOwnPhoneHeader(): boolean {
  const narrow = useMediaQuery(NARROW);
  const mark = usePhoneHeaderMark();
  return narrow && !inDesktopApp() && mark === 'page';
}

/** How a modal flow is left: "Cancelar" as a word (a new task, editing a document), or "Cerrar" as ✕ (the wizard). */
export type PhoneHeaderDismiss = { kind: 'cancel' | 'close'; to: string; label?: string } | { kind: 'cancel' | 'close'; onDismiss: () => void; label?: string };

function Dismiss({ dismiss }: { dismiss: PhoneHeaderDismiss }) {
  const { t } = useTranslation('shell');
  const label = dismiss.label ?? t(`phoneHeader.${dismiss.kind}`);
  const className = dismiss.kind === 'cancel' ? 'btn btn-ghost phone-head-cancel' : 'icon-btn phone-head-back';
  const content = dismiss.kind === 'cancel' ? label : <X {...ICON} />;
  const a11y = dismiss.kind === 'close' ? { 'aria-label': label } : {};
  return 'to' in dismiss ? (
    <Link to={dismiss.to} className={className} {...a11y}>
      {content}
    </Link>
  ) : (
    <button type="button" className={className} onClick={dismiss.onDismiss} {...a11y}>
      {content}
    </button>
  );
}

/**
 * A phone screen's own header, as Night Shift draws every detail screen (`.m-head`): the way back,
 * the title with a mono line under it, the screen's own buttons, and "⋯" opening a sheet of big
 * buttons through `MoreActions`. A modal flow has `dismiss` in place of the arrow. Drawn where
 * `useOwnPhoneHeader()` is true: the shell has hidden the top bar there.
 */
export function PhoneHeader({
  title,
  subtitle,
  lead,
  back,
  dismiss,
  actions,
  more,
  moreLabel,
  moreTitle,
  className = '',
}: {
  title: ReactNode;
  /** One mono line under the title: a path, the project and its key, "paso 2 de 4" */
  subtitle?: ReactNode;
  /** Before the title: a project's monogram, an item's key */
  lead?: ReactNode;
  /** The back arrow's name and where it goes when the screen was opened first */
  back?: { label?: string; fallback?: string };
  /** A modal flow's way out, instead of the back arrow */
  dismiss?: PhoneHeaderDismiss;
  /** The screen's own icon buttons, 44 px, before "⋯" */
  actions?: ReactNode;
  /** What "⋯" offers; no button when there is nothing to offer */
  more?: MenuEntry[];
  moreLabel?: string;
  /** The sheet's heading; defaults to the title when it is text */
  moreTitle?: string;
  className?: string;
}) {
  const { t } = useTranslation('shell');
  return (
    <header className={`phone-head ${dismiss?.kind === 'cancel' ? 'is-modal' : ''} ${className}`.replace(/\s+/g, ' ').trim()}>
      {dismiss ? <Dismiss dismiss={dismiss} /> : <BackButton label={back?.label ?? t('phoneHeader.back')} fallback={back?.fallback} className="phone-head-back" />}
      {lead && <span className="phone-head-lead">{lead}</span>}
      <div className="phone-head-text">
        <h1 className="ellipsis">{title}</h1>
        {subtitle && <span className="phone-head-sub ellipsis">{subtitle}</span>}
      </div>
      {actions && <div className="phone-head-actions">{actions}</div>}
      {more && more.length > 0 && (
        <MoreActions
          entries={more}
          label={moreLabel ?? t('phoneHeader.more')}
          title={moreTitle ?? (typeof title === 'string' ? title : undefined)}
          className="phone-head-more"
        />
      )}
    </header>
  );
}
