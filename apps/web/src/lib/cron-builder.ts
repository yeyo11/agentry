/**
 * The handful of timetables people actually want, as form fields. The expression itself stays the
 * source of truth: anything the builder cannot say is `custom` and edited as text, so opening a
 * schedule written by hand never rewrites it into something else.
 */
export type CronMode = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export interface CronParts {
  mode: CronMode;
  /** `minutes`: every N minutes */
  every: number;
  minute: number;
  hour: number;
  /** 0 is Sunday, as in cron */
  weekday: number;
  /** Day of the month */
  day: number;
  /** `custom`: the expression as typed */
  text: string;
}

export const CRON_MODES: readonly CronMode[] = ['minutes', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'];

export const DEFAULT_PARTS: CronParts = { mode: 'daily', every: 15, minute: 0, hour: 9, weekday: 1, day: 1, text: '0 9 * * *' };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(Number.isFinite(n) ? n : min)));

export function buildCron(parts: CronParts): string {
  const minute = clamp(parts.minute, 0, 59);
  const hour = clamp(parts.hour, 0, 23);
  switch (parts.mode) {
    case 'minutes':
      return `*/${clamp(parts.every, 1, 59)} * * * *`;
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${clamp(parts.weekday, 0, 6)}`;
    case 'monthly':
      return `${minute} ${hour} ${clamp(parts.day, 1, 31)} * *`;
    case 'custom':
      return parts.text.trim();
  }
}

const NUM = '(\\d{1,2})';

/** Reads an expression back into the fields, or into `custom` when it is not one of the shapes above. */
export function parseCron(cron: string): CronParts {
  const text = cron.trim().replace(/\s+/g, ' ');
  const custom: CronParts = { ...DEFAULT_PARTS, mode: 'custom', text: cron.trim() };
  const shapes: Array<[RegExp, (m: RegExpExecArray) => Partial<CronParts>]> = [
    [/^\*\/(\d{1,2}) \* \* \* \*$/, (m) => ({ mode: 'minutes', every: Number(m[1]) })],
    [new RegExp(`^${NUM} \\* \\* \\* \\*$`), (m) => ({ mode: 'hourly', minute: Number(m[1]) })],
    [new RegExp(`^${NUM} ${NUM} \\* \\* \\*$`), (m) => ({ mode: 'daily', minute: Number(m[1]), hour: Number(m[2]) })],
    [new RegExp(`^${NUM} ${NUM} \\* \\* 1-5$`), (m) => ({ mode: 'weekdays', minute: Number(m[1]), hour: Number(m[2]) })],
    [new RegExp(`^${NUM} ${NUM} \\* \\* ([0-6])$`), (m) => ({ mode: 'weekly', minute: Number(m[1]), hour: Number(m[2]), weekday: Number(m[3]) })],
    [new RegExp(`^${NUM} ${NUM} ${NUM} \\* \\*$`), (m) => ({ mode: 'monthly', minute: Number(m[1]), hour: Number(m[2]), day: Number(m[3]) })],
  ];
  for (const [re, read] of shapes) {
    const match = re.exec(text);
    if (!match) continue;
    const parts: CronParts = { ...DEFAULT_PARTS, ...read(match), text: cron.trim() };
    // A shape whose numbers are out of range is not one the builder can say: keep it as text
    return buildCron(parts) === text ? parts : custom;
  }
  return custom;
}

/** The IANA zones the browser knows, for the picker; empty where `Intl.supportedValuesOf` is missing. */
export function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}
