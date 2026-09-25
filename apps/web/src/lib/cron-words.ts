import { describeCronIn, parseCron, type CronWords } from '@agentry/shared';
import i18n from '../i18n';
import { intlLocale } from '../i18n/language';

/*
 * A cron expression in the UI language. The API describes it too, but only in English: it has no
 * language of its own. The parser and the choice of phrase are shared with the server
 * (`@agentry/shared`'s cron module), so the sentence here says what the scheduler will do; only the
 * words differ. Validity and the next fires still come from the API, which knows the time zones.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

// Any year does: 1 January 2023 was a Sunday, so day d of that week is weekday d
const names = new Map<string, Intl.DateTimeFormat>();
function nameFormat(locale: string, part: 'weekday' | 'month'): Intl.DateTimeFormat {
  const key = `${locale}|${part}`;
  let format = names.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { [part]: 'long', timeZone: 'UTC' });
    names.set(key, format);
  }
  return format;
}

function words(): CronWords {
  const t = i18n.t;
  const locale = intlLocale();
  const list = (items: readonly string[]): string =>
    items.length <= 1 ? (items[0] ?? '') : t('schedules:cron.and', { rest: items.slice(0, -1).join(', '), last: items.at(-1) ?? '' });
  return {
    list,
    range: (field, from, to) => t(`schedules:cron.range.${field}`, { from, to }),
    weekday: (d) => nameFormat(locale, 'weekday').format(Date.UTC(2023, 0, 1 + d)),
    month: (m) => nameFormat(locale, 'month').format(Date.UTC(2023, m - 1, 1)),
    at: (hour, minute) => t('schedules:cron.at', { count: hour, time: `${pad(hour)}:${pad(minute)}` }),
    everyHourOnTheHour: () => t('schedules:cron.everyHourOnTheHour'),
    everyHourAt: (minute) => t('schedules:cron.everyHourAt', { minute }),
    everyMinute: () => t('schedules:cron.everyMinute'),
    everyMinutes: (step) => t('schedules:cron.everyMinutes', { step }),
    atMinutes: (minutes) => t('schedules:cron.atMinutes', { minutes }),
    atMinute: (minute) => t('schedules:cron.atMinute', { minute }),
    hours: (hours) => t('schedules:cron.hours', { count: hours.count, hours: hours.text }),
    ofHours: (every, hours) => t('schedules:cron.ofHours', { every, hours }),
    ofHour: (every, hour) => t('schedules:cron.ofHour', { count: hour, every, time: `${pad(hour)}:00` }),
    monthDays: (days) => (days.hasRange ? t('schedules:cron.monthDaysRange', { days: days.text }) : t('schedules:cron.monthDays', { count: days.count, days: days.text })),
    // Spanish opens a range differently from a list: "de lunes a viernes", "cada lunes y viernes"
    weekdays: (days) => t(days.hasRange ? 'schedules:cron.weekdaysRange' : 'schedules:cron.weekdays', { days: days.text }),
    months: (months) => t(months.hasRange ? 'schedules:cron.monthsRange' : 'schedules:cron.months', { months: months.text }),
    eitherDay: (monthDays, weekdays) => t('schedules:cron.eitherDay', { monthDays, weekdays }),
    clauses: (parts) => parts.join(', '),
  };
}

/** The expression in words in the UI language, or null when it does not parse. */
export function describeCron(expression: string): string | null {
  try {
    return describeCronIn(parseCron(expression), words());
  } catch {
    return null;
  }
}
