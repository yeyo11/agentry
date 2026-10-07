import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ICON } from '@agentry/ui/components/icons';

/**
 * The way back at the head of a phone screen that has no top bar (lib/shell-live.ts, hidesTopBar):
 * to where the person came from in the app, or Home when the screen was opened first.
 */
export function BackButton({
  label,
  fallback = '/',
  onBack,
  className = '',
}: {
  label: string;
  fallback?: string;
  /** Replaces the history back: a screen inside a page (a Settings tab) goes back through its leave guard */
  onBack?: () => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const back = () => {
    if (onBack) return onBack();
    // The router numbers the entries it pushed: 0 is the one the app was opened on
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) navigate(-1);
    else navigate(fallback);
  };
  return (
    <button type="button" className={`icon-btn page-back ${className}`.trim()} aria-label={label} onClick={back}>
      <ChevronLeft {...ICON} />
    </button>
  );
}
