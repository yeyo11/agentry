import { parseDay, toDay } from './usage-view';

/*
 * The arithmetic behind the DatePicker, kept apart from React so it can be tested without a DOM.
 * Days travel as `YYYY-MM-DD` in the browser's zone, the same strings the usage range uses; a
 * `Date` here is always local midnight.
 */

export { parseDay, toDay };

/** 0 is Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface WeekInfo {
  firstDay: number;
}
type LocaleWithWeekInfo = Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };

/**
 * The first column of the calendar. `Intl.Locale` knows it where the engine has `weekInfo` (it
 * counts Monday as 1 and Sunday as 7); elsewhere the United States, Canada and a few more start on
 * Sunday and most of the world on Monday.
 */
export function firstDayOfWeek(locale: string): Weekday {
  try {
    const info = new Intl.Locale(locale) as LocaleWithWeekInfo;
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) return (firstDay % 7) as Weekday;
  } catch {
    // an unknown tag falls through to the guess below
  }
  const region = locale.split('-')[1]?.toUpperCase();
  return region && SUNDAY_FIRST.has(region) ? 0 : 1;
}

const SUNDAY_FIRST = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'IL', 'PH', 'AU']);

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The same day in another month, clamped to that month's last day (31 January + 1 month = 28/29 February). */
export function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last));
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The weeks shown for the month of `month`: whole rows of seven, starting on `firstDay`, so the
 * first and last rows carry days of the months around it.
 */
export function monthGrid(month: Date, firstDay: Weekday): Date[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -((first.getDay() - firstDay + 7) % 7));
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const weeks: Date[][] = [];
  for (let day = start; day.getTime() <= last.getTime(); ) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** A day outside `[min, max]` (either end optional, both `YYYY-MM-DD`) cannot be picked. */
export function outOfRange(date: Date, min?: string, max?: string): boolean {
  const low = min ? parseDay(min) : null;
  const high = max ? parseDay(max) : null;
  return (low !== null && date.getTime() < low.getTime()) || (high !== null && date.getTime() > high.getTime());
}

export function clampDay(date: Date, min?: string, max?: string): Date {
  const low = min ? parseDay(min) : null;
  const high = max ? parseDay(max) : null;
  if (low && date.getTime() < low.getTime()) return low;
  if (high && date.getTime() > high.getTime()) return high;
  return date;
}

/**
 * Where a key moves the focused day, following the WAI-ARIA date picker pattern: arrows by a day or
 * a week, Home and End to the ends of the week, Page Up and Page Down by a month (a year with
 * Shift). `null` for a key the grid does not handle.
 */
export function moveFocus(date: Date, key: string, shift: boolean, firstDay: Weekday): Date | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(date, -1);
    case 'ArrowRight':
      return addDays(date, 1);
    case 'ArrowUp':
      return addDays(date, -7);
    case 'ArrowDown':
      return addDays(date, 7);
    case 'Home':
      return addDays(date, -((date.getDay() - firstDay + 7) % 7));
    case 'End':
      return addDays(date, 6 - ((date.getDay() - firstDay + 7) % 7));
    case 'PageUp':
      return addMonths(date, shift ? -12 : -1);
    case 'PageDown':
      return addMonths(date, shift ? 12 : 1);
    default:
      return null;
  }
}
