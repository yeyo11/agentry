import { useTranslation } from 'react-i18next';

const KNOWN = {
  five_hour: 'five_hour',
  '5h': 'five_hour',
  seven_day: 'seven_day',
  '7d': 'seven_day',
  primary: 'primary',
  secondary: 'secondary',
} as const;

export type LimitWindowWord = (typeof KNOWN)[keyof typeof KNOWN] | 'other';

/** Which of the windows with words of their own a provider's window name is; `other` for any name else. */
export function limitWindowWord(window: string | null | undefined): LimitWindowWord {
  return window && Object.hasOwn(KNOWN, window) ? KNOWN[window as keyof typeof KNOWN] : 'other';
}

/** Whether a window name has words of its own, so a sentence may name it ("its 5 h limit"). */
export function isKnownLimitWindow(window: string | null | undefined): boolean {
  return limitWindowWord(window) !== 'other';
}

/**
 * A window as the person says it, never as the provider spells it: `five_hour` is "5 h", `primary`
 * "main window", and any name the app does not know a generic "usage limit". The banner, the bars
 * and the status bar all say windows through this.
 */
export function useLimitWindowName(): (window: string | null | undefined) => string {
  const { t } = useTranslation('shell');
  return (window) => t(`limitWindow.${limitWindowWord(window)}`);
}
