/**
 * Five-field cron expressions, read in an IANA time zone.
 *
 * Written here instead of pulled in as a dependency: the syntax a person types into a schedule is
 * small (`*`, lists, ranges, steps, month and weekday names), the tricky part is time zones and
 * daylight saving, and `node-cron` and friends would drag in a runtime that fires timers on its own,
 * which is exactly what a scheduler that has to survive a restart must not do. What is needed is a
 * pure function from an expression and an instant to the next instant, and that is testable.
 */

import { describeCronIn, parseCron, type CronSpec, type CronWords } from '@agentry/shared';

// The parser lives in shared so the web reads an expression exactly as the scheduler does
export { parseCron, type CronSpec };

// ---------- time zones ----------

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(zone, format);
  }
  return format;
}

/** The zone the server runs in, which is what a schedule without one is read in. */
export function serverZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function assertZone(zone: string): void {
  try {
    formatFor(zone);
  } catch {
    throw new Error(`"${zone}" is not a time zone this server knows (use an IANA name such as Europe/Madrid)`);
  }
}

/**
 * The wall clock of an instant in a zone, as a UTC timestamp whose fields read like that clock.
 * Working in these "naive" timestamps lets the search below step through days and hours without
 * ever meeting a daylight-saving jump; only the last step converts back to a real instant.
 */
function wallOf(instant: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatFor(zone).formatToParts(new Date(instant))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
}

const offsetAt = (instant: number, zone: string): number => wallOf(instant, zone) - Math.floor(instant / 1000) * 1000;

/**
 * The instant a wall-clock time happens at. A time that occurs twice (the clocks went back) is the
 * first one, so a job fires once; a time that never occurs (they went forward) is shifted on by the
 * length of the gap, so a 02:30 job runs at 03:30 rather than being dropped for the day.
 */
function instantOf(naive: number, zone: string): number {
  const day = 24 * 3600_000;
  const candidates = [...new Set([offsetAt(naive - day, zone), offsetAt(naive + day, zone)])].map((offset) => naive - offset);
  const valid = candidates.filter((c) => wallOf(c, zone) === naive).sort((a, b) => a - b);
  return valid[0] ?? Math.max(...candidates);
}

const MINUTE = 60_000;
/** 29 February is the longest wait an expression can have: eight years across a skipped leap year */
const HORIZON_DAYS = 366 * 9;

function dayMatches(spec: CronSpec, date: Date): boolean {
  const dom = spec.daysOfMonth.has(date.getUTCDate());
  const dow = spec.daysOfWeek.has(date.getUTCDay());
  // Vixie's rule: when both day fields are restricted, either one is enough
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  return dom && dow;
}

/**
 * The first instant strictly after `after` that the expression fires at, in `zone`; null when it
 * never does (30 February). Pure: it holds no timer and reads no clock.
 */
export function nextFire(spec: CronSpec, after: number, zone: string = serverZone()): number | null {
  let wall = Math.floor(wallOf(after, zone) / MINUTE) * MINUTE + MINUTE;
  const limit = wall + HORIZON_DAYS * 24 * 3600_000;
  while (wall <= limit) {
    const date = new Date(wall);
    if (!spec.months.has(date.getUTCMonth() + 1)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    } else if (!dayMatches(spec, date)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    } else if (!spec.hours.has(date.getUTCHours())) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1);
    } else if (!spec.minutes.has(date.getUTCMinutes())) {
      wall += MINUTE;
    } else {
      const instant = instantOf(wall, zone);
      // Inside an hour that repeats, a wall time can map to an instant already gone
      if (instant > after) return instant;
      wall += MINUTE;
    }
  }
  return null;
}

/** The next `count` fires after `after`, for showing a person what an expression will do. */
export function nextFires(spec: CronSpec, after: number, count: number, zone?: string): number[] {
  const out: number[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextFire(spec, cursor, zone);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

// ---------- in words ----------

const pad = (n: number): string => String(n).padStart(2, '0');
const list = (items: readonly string[]): string => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The API has no language of its own, so it says an expression in English; the web says it in the UI's. */
const ENGLISH: CronWords = {
  list,
  range: (_field, from, to) => `${from} to ${to}`,
  weekday: (d) => DAY_NAMES[d] ?? String(d),
  month: (m) => MONTH_NAMES[m - 1] ?? String(m),
  at: (hour, minute) => `At ${pad(hour)}:${pad(minute)}`,
  everyHourOnTheHour: () => 'Every hour, on the hour',
  everyHourAt: (minute) => `Every hour, at minute ${minute}`,
  everyMinute: () => 'Every minute',
  everyMinutes: (step) => `Every ${step} minutes`,
  atMinutes: (minutes) => `At minutes ${minutes}`,
  atMinute: (minute) => `At minute ${minute}`,
  hours: (hours) => `the hours ${hours.text}`,
  ofHours: (every, hours) => `${every} of ${hours}`,
  ofHour: (every, hour) => `${every} of the ${pad(hour)}:00 hour`,
  monthDays: (days) => `on day ${days.text} of the month`,
  weekdays: (days) => `on ${days.text}`,
  months: (months) => `in ${months.text}`,
  eitherDay: (monthDays, weekdays) => `${monthDays}, or ${weekdays}`,
  clauses: (parts) => parts.join(', '),
};

/** A sentence for what an expression does, so a person can check it says what they meant. */
export function describeCron(spec: CronSpec): string {
  return describeCronIn(spec, ENGLISH);
}
