import type { AccountSummary, AccountUsageWindow } from '@agentry/shared';
import { currentLanguage, intlLocale } from '../../i18n/language';
import { formatDuration, toMs } from '../../lib/format';

/** A window is spent once it reports its whole share used. */
export const windowExhausted = (win: AccountUsageWindow | null | undefined): boolean => !!win && win.pct >= 100;

/**
 * An account that cannot take a run now: no quota left in its binding window, or one of its
 * account-wide windows spent. A per-model window alone does not stop the account.
 */
export function accountExhausted(account: AccountSummary): boolean {
  return account.headroomPct === 0 || windowExhausted(account.usage?.fiveHour) || windowExhausted(account.usage?.sevenDay);
}

/** The active account first, the exhausted ones last, the rest in slot order between them. */
export function sortAccounts(accounts: readonly AccountSummary[]): AccountSummary[] {
  const rank = (a: AccountSummary) => (a.active ? 0 : accountExhausted(a) ? 2 : 1);
  return [...accounts].sort((a, b) => rank(a) - rank(b) || a.number - b.number);
}

/** The spent window that frees the account last: until then it cannot be used. */
export function bindingReset(account: AccountSummary): AccountUsageWindow | null {
  const spent = [account.usage?.fiveHour, account.usage?.sevenDay].filter(windowExhausted) as AccountUsageWindow[];
  return spent.reduce<AccountUsageWindow | null>((last, win) => ((toMs(win.resetsAt) ?? 0) > (toMs(last?.resetsAt) ?? -1) ? win : last), null);
}

const minutes = () =>
  new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: 'minute', unitDisplay: currentLanguage() === 'en' ? 'narrow' : 'short' });

/**
 * How long until a window resets, to the minute: `19 min`, `4 h 49 min`, `2 d 10 h`. Above an hour
 * it is formatDuration's; below it formatDuration would add seconds a reset countdown has no use for.
 */
export function resetDuration(ms: number): string {
  const whole = Math.max(1, Math.ceil(ms / 60_000));
  return whole < 60 ? minutes().format(whole) : formatDuration(whole * 60_000);
}

/**
 * The time left to a window's reset, or claude-swap's own countdown when it gave no timestamp.
 * `0` when the reset is already due; null when nothing is known.
 */
export function timeToReset(win: AccountUsageWindow, now = Date.now()): string | 0 | null {
  const at = toMs(win.resetsAt);
  if (at === null) return win.countdown;
  return at <= now ? 0 : resetDuration(at - now);
}
