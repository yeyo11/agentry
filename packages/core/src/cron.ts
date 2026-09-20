/**
 * Five-field cron expressions, read in an IANA time zone.
 *
 * Written here instead of pulled in as a dependency: the syntax a person types into a schedule is
 * small (`*`, lists, ranges, steps, month and weekday names), the tricky part is time zones and
 * daylight saving, and `node-cron` and friends would drag in a runtime that fires timers on its own,
 * which is exactly what a scheduler that has to survive a restart must not do. What is needed is a
 * pure function from an expression and an instant to the next instant, and that is testable.
 */

interface Field {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  /** Index in `names` of the first name, when it is not `min` */
  nameBase?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const FIELDS: readonly Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  // 7 is Sunday too, as in every cron since Vixie's
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export interface CronSpec {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0-6, Sunday is 0 */
  daysOfWeek: ReadonlySet<number>;
  /** A field written as `*` does not restrict, which decides how the two day fields combine */
  domRestricted: boolean;
  dowRestricted: boolean;
  /** The expression with the aliases expanded, as parsed */
  source: string;
}

function parseValue(text: string, field: Field): number {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) return named + (field.nameBase ?? 0);
  if (!/^\d+$/.test(text)) throw new Error(`${field.name}: "${text}" is not a number${field.names ? ' or a name' : ''}`);
  const value = Number(text);
  if (value < field.min || value > field.max) throw new Error(`${field.name}: ${text} is outside ${field.min}-${field.max}`);
  return value;
}

function parseField(text: string, field: Field): Set<number> {
  const out = new Set<number>();
  if (!text) throw new Error(`${field.name} is empty`);
  for (const part of text.split(',')) {
    const [range = '', stepText, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`${field.name}: "${part}" has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`${field.name}: the step in "${part}" must be a positive number`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === '*') {
      from = field.min;
      to = field.max;
    } else if (range.includes('-')) {
      const [a = '', b = '', more] = range.split('-');
      if (more !== undefined) throw new Error(`${field.name}: "${range}" is not a range`);
      from = parseValue(a, field);
      to = parseValue(b, field);
      if (from > to) throw new Error(`${field.name}: the range "${range}" runs backwards`);
    } else {
      from = parseValue(range, field);
      // `5/15` means from 5 to the end, every 15, like everywhere else
      to = stepText === undefined ? from : field.max;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Throws an `Error` whose message says which field is wrong; the API shows it as it is. */
export function parseCron(expression: string): CronSpec {
  const trimmed = expression.trim();
  const source = ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`a cron expression has five fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = parts;
  const [minutes, hours, daysOfMonth, months, weekdays] = [minute, hour, dom, month, dow].map((text, i) => parseField(text, FIELDS[i] as Field)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const daysOfWeek = new Set([...weekdays].map((d) => d % 7));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: !dom.startsWith('*'),
    dowRestricted: !dow.startsWith('*'),
    source,
  };
}

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
const only = (set: ReadonlySet<number>): number | null => (set.size === 1 ? ([...set][0] ?? null) : null);
const list = (items: string[]): string => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Consecutive values as "a to b", the rest as a list. */
function runs(values: ReadonlySet<number>, label: (n: number) => string): string {
  const sorted = [...values].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (sorted[j + 1] === (sorted[j] as number) + 1) j++;
    parts.push(j - i >= 2 ? `${label(sorted[i] as number)} to ${label(sorted[j] as number)}` : sorted.slice(i, j + 1).map(label).join(' and '));
    i = j + 1;
  }
  return list(parts);
}

/** A sentence for what an expression does, so a person can check it says what they meant. */
export function describeCron(spec: CronSpec): string {
  const minute = only(spec.minutes);
  const hour = only(spec.hours);
  const hoursText = `the hours ${runs(spec.hours, String)}`;
  const everyHour = spec.hours.size === 24;
  let when: string;
  if (minute !== null && hour !== null) when = `At ${pad(hour)}:${pad(minute)}`;
  else if (minute !== null && everyHour) when = minute === 0 ? 'Every hour, on the hour' : `Every hour, at minute ${minute}`;
  else if (spec.minutes.size === 60) when = everyHour ? 'Every minute' : `Every minute of ${hoursText}`;
  else if (minute !== null) when = `At minute ${minute} of ${hoursText}`;
  else {
    const values = [...spec.minutes].sort((a, b) => a - b);
    const step = (values[1] ?? 0) - (values[0] ?? 0);
    const even = values.length > 2 && values.every((v, i) => v === (values[0] as number) + i * step);
    const every = even && values[0] === 0 && 60 % step === 0 ? `Every ${step} minutes` : `At minutes ${list(values.map(String))}`;
    when = hour !== null ? `${every} of the ${pad(hour)}:00 hour` : everyHour ? every : `${every} of ${hoursText}`;
  }
  const weekdays = () => `on ${runs(spec.daysOfWeek, (d) => DAY_NAMES[d] ?? String(d))}`;
  const monthDays = () => `on day ${runs(spec.daysOfMonth, String)} of the month`;
  const days =
    spec.domRestricted && spec.dowRestricted
      ? `${monthDays()}, or ${weekdays()}`
      : spec.domRestricted
        ? monthDays()
        : spec.dowRestricted
          ? weekdays()
          : '';
  const months = spec.months.size < 12 ? `in ${runs(spec.months, (m) => MONTH_NAMES[m - 1] ?? String(m))}` : '';
  return [when, days, months].filter(Boolean).join(', ');
}
