import { Plus } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { fabFor } from '../../lib/shell-live';

/** Scrolled less than this is a finger resting on the list, not a direction */
const SCROLL_SLACK_PX = 8;
/** Near the top the button always shows: there is nothing under it yet */
const TOP_PX = 48;

/**
 * Whether the button steps aside: while the page scrolls down it goes, and it comes back as soon as
 * the page scrolls up or reaches the top, as floating buttons do on iOS and Android. That is what
 * lets the page keep no room for it at its end — at the end the reader has scrolled down, so the
 * button is already out of the way.
 */
export function useHideOnScroll(scroller: RefObject<HTMLElement | null>, resetKey: string): boolean {
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  useEffect(() => {
    setHidden(false);
    const element = scroller.current;
    if (!element) return;
    last.current = element.scrollTop;
    const onScroll = () => {
      const top = element.scrollTop;
      const delta = top - last.current;
      if (top <= TOP_PX) setHidden(false);
      else if (delta > SCROLL_SLACK_PX) setHidden(true);
      else if (delta < -SCROLL_SLACK_PX) setHidden(false);
      else return;
      last.current = top;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [scroller, resetKey]);
  return hidden;
}

/*
 * How many things on the page stand in for the button right now: an empty state whose own primary
 * action is the one the button would start, a form already open for it, or a state where nothing
 * can be started at all. While any is mounted the button is not drawn.
 */
let standIns = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Render it inside a page's empty state (or open form) that already offers what the FAB would
 * start: the same action twice on one screen, one of them floating over the other, is noise.
 */
export function FabStandIn(): null {
  useEffect(() => {
    standIns += 1;
    emit();
    return () => {
      standIns -= 1;
      emit();
    };
  }, []);
  return null;
}

/**
 * The phone's floating "start something" button, in the brand gradient above the tab bar. What it
 * starts depends on the page (`fabFor`); where there is nothing to start from here, it is not
 * there. Always the icon alone, so its name is said for it.
 */
export function Fab({
  pathname,
  scroller,
  onNewChat,
  onNewOrchestration,
}: {
  pathname: string;
  /** The page's scroll container, whose direction hides and shows the button */
  scroller: RefObject<HTMLElement | null>;
  onNewChat: () => void;
  onNewOrchestration: () => void;
}) {
  const { t } = useTranslation(['components', 'shell']);
  const plan = fabFor(pathname);
  const hidden = useHideOnScroll(scroller, pathname);
  const [focused, setFocused] = useState(false);
  const stoodIn = useSyncExternalStore(subscribe, () => standIns > 0);
  if (!plan || stoodIn) return null;
  const label = plan.action === 'chat' ? t('components:shell.newChat') : t('shell:topbar.newOrchestration');
  // A keyboard that reaches it brings it back: a control is never focused while out of sight
  const away = hidden && !focused;
  return (
    <button
      type="button"
      className={`fab ${away ? 'is-away' : ''}`.trim()}
      aria-label={label}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={plan.action === 'chat' ? onNewChat : onNewOrchestration}
    >
      <Plus size={22} strokeWidth={2.2} aria-hidden />
    </button>
  );
}
