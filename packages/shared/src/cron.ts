/**
 * Five-field cron expressions: the parser, and the shape of the sentence that says one in words.
 *
 * Both are pure, so they live here rather than in core: the server parses an expression to schedule
 * it and describes it in English for the API, and the web describes the same expression in the UI
 * language. One parser means the two can never read an expression differently. The words
 * themselves come from the caller (`CronWords`); only the grammar of which phrase applies is here.
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

// ---------- in words ----------

/** The fields whose values are said as runs: consecutive values become a range */
export type CronRunField = 'hour' | 'monthDay' | 'weekday' | 'month';

/**
 * A field's values said as runs: the text, how many values it holds (for plurals) and whether any
 * of them is a range, since some languages introduce a range differently from a list ("de lunes a
 * viernes" but "cada lunes y viernes").
 */
export interface CronRuns {
  text: string;
  count: number;
  hasRange: boolean;
}

/** The words of one language. Numbers arrive as numbers; the sentence around them is the caller's. */
export interface CronWords {
  /** "a", "a and b", "a, b and c" */
  list(items: readonly string[]): string;
  /** "a to b" */
  range(field: CronRunField, from: string, to: string): string;
  /** 0 is Sunday */
  weekday(day: number): string;
  /** 1 is January */
  month(month: number): string;
  /** "At 09:30" */
  at(hour: number, minute: number): string;
  /** "Every hour, on the hour" */
  everyHourOnTheHour(): string;
  /** "Every hour, at minute 5" */
  everyHourAt(minute: number): string;
  /** "Every minute" */
  everyMinute(): string;
  /** "Every 15 minutes" */
  everyMinutes(step: number): string;
  /** "At minutes 0, 20 and 45" */
  atMinutes(minutes: string): string;
  /** "At minute 30" (followed by `ofHours`) */
  atMinute(minute: number): string;
  /** "the hours 9 to 17" */
  hours(hours: CronRuns): string;
  /** "<every> of <the hours …>" */
  ofHours(every: string, hours: string): string;
  /** "<every> of the 09:00 hour" */
  ofHour(every: string, hour: number): string;
  /** "on day 1 of the month" */
  monthDays(days: CronRuns): string;
  /** "on Monday to Friday" */
  weekdays(days: CronRuns): string;
  /** "in December" */
  months(months: CronRuns): string;
  /** "<month days>, or <weekdays>": either one is enough */
  eitherDay(monthDays: string, weekdays: string): string;
  /** The clauses of the sentence, in order */
  clauses(parts: readonly string[]): string;
}

const only = (set: ReadonlySet<number>): number | null => (set.size === 1 ? ([...set][0] ?? null) : null);

/** Consecutive values as "a to b", the rest as a list. */
function runs(values: ReadonlySet<number>, field: CronRunField, label: (n: number) => string, words: CronWords): CronRuns {
  const sorted = [...values].sort((a, b) => a - b);
  const parts: string[] = [];
  let hasRange = false;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (sorted[j + 1] === (sorted[j] as number) + 1) j++;
    if (j - i >= 2) {
      hasRange = true;
      parts.push(words.range(field, label(sorted[i] as number), label(sorted[j] as number)));
    } else parts.push(words.list(sorted.slice(i, j + 1).map(label)));
    i = j + 1;
  }
  return { text: words.list(parts), count: sorted.length, hasRange };
}

/** A sentence for what an expression does, so a person can check it says what they meant. */
export function describeCronIn(spec: CronSpec, words: CronWords): string {
  const minute = only(spec.minutes);
  const hour = only(spec.hours);
  const hoursText = () => words.hours(runs(spec.hours, 'hour', String, words));
  const everyHour = spec.hours.size === 24;
  let when: string;
  if (minute !== null && hour !== null) when = words.at(hour, minute);
  else if (minute !== null && everyHour) when = minute === 0 ? words.everyHourOnTheHour() : words.everyHourAt(minute);
  else if (spec.minutes.size === 60) when = everyHour ? words.everyMinute() : words.ofHours(words.everyMinute(), hoursText());
  else if (minute !== null) when = words.ofHours(words.atMinute(minute), hoursText());
  else {
    const values = [...spec.minutes].sort((a, b) => a - b);
    const step = (values[1] ?? 0) - (values[0] ?? 0);
    const even = values.length > 2 && values.every((v, i) => v === (values[0] as number) + i * step);
    const every = even && values[0] === 0 && 60 % step === 0 ? words.everyMinutes(step) : words.atMinutes(words.list(values.map(String)));
    when = hour !== null ? words.ofHour(every, hour) : everyHour ? every : words.ofHours(every, hoursText());
  }
  const weekdays = () => words.weekdays(runs(spec.daysOfWeek, 'weekday', (d) => words.weekday(d), words));
  const monthDays = () => words.monthDays(runs(spec.daysOfMonth, 'monthDay', String, words));
  const days =
    spec.domRestricted && spec.dowRestricted
      ? words.eitherDay(monthDays(), weekdays())
      : spec.domRestricted
        ? monthDays()
        : spec.dowRestricted
          ? weekdays()
          : '';
  const months = spec.months.size < 12 ? words.months(runs(spec.months, 'month', (m) => words.month(m), words)) : '';
  return words.clauses([when, days, months].filter(Boolean));
}
