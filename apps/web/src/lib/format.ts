import i18n from '../i18n';
import { intlLocale } from '../i18n/language';

// Everything here follows the active UI language through Intl. The English output is the text
// these helpers produced by hand before (5s ago, 2h 5m, $0.12, 1.5 KB), which the e2e specs and
// the tests in test/format.test.ts pin down.

// Lists call these once per row: building an Intl formatter is far dearer than using one.
type Formatter = Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.DateTimeFormat;
const formatters = new Map<string, Formatter>();
function cached<T extends Formatter>(key: string, make: (locale: string) => T): T {
  const locale = intlLocale();
  const id = `${locale}|${key}`;
  let formatter = formatters.get(id);
  if (!formatter) {
    formatter = make(locale);
    formatters.set(id, formatter);
  }
  return formatter as T;
}

type Unit = 'second' | 'minute' | 'hour' | 'day';

// The fields `toLocaleDateString`, `toLocaleTimeString` and `toLocaleString` print by default,
// through one formatter each instead of the one those methods build on every call
const DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', second: 'numeric' };
const dateTime = (key: string, options: Intl.DateTimeFormatOptions) => cached(`dt:${key}`, (l) => new Intl.DateTimeFormat(l, options));

// English keeps its narrow `2h 5m`; Spanish's narrow units run into the number (`5min`), so it
// gets the short ones, which are just as brief there (`2 h 5 min`).
const unit = (value: number, u: Unit) =>
  cached(`unit:${u}`, (l) =>
    new Intl.NumberFormat(l, { style: 'unit', unit: u, unitDisplay: l.startsWith('en') ? 'narrow' : 'short' }),
  ).format(value);

const ago = (value: number, u: Unit) =>
  cached('ago', (l) => new Intl.RelativeTimeFormat(l, { style: 'narrow', numeric: 'always' })).format(-value, u);

export function toMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return unit(s, 'second');
  const m = Math.floor(s / 60);
  if (m < 60) return `${unit(m, 'minute')} ${unit(s % 60, 'second')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${unit(h, 'hour')} ${unit(m % 60, 'minute')}`;
  return `${unit(Math.floor(h / 24), 'day')} ${unit(h % 24, 'hour')}`;
}

export function timeAgo(value: string | number | null | undefined): string {
  const ms = toMs(value);
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 5000) return i18n.t('common:time.justNow');
  const s = Math.round(diff / 1000);
  if (s < 60) return ago(s, 'second');
  const m = Math.floor(s / 60);
  if (m < 60) return ago(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return ago(h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 30) return ago(d, 'day');
  return dateTime('date', DATE).format(ms);
}

export function timeUntil(epochSeconds: number | undefined): string {
  if (!epochSeconds) return '—';
  const diff = epochSeconds * 1000 - Date.now();
  return diff <= 0 ? i18n.t('common:time.now') : i18n.t('common:time.in', { duration: formatDuration(diff) });
}

export function durationBetween(start: string | number | null, end: string | number | null): string {
  const a = toMs(start);
  if (a == null) return '—';
  return formatDuration((toMs(end) ?? Date.now()) - a);
}

export function formatDate(value: string | number | null | undefined): string {
  const ms = toMs(value);
  return ms == null ? '—' : dateTime('date', DATE).format(ms);
}

export function formatDateTime(value: string | number | null | undefined): string {
  const ms = toMs(value);
  return ms == null ? '—' : dateTime('datetime', { ...DATE, ...TIME }).format(ms);
}

export function formatClock(value: string | null | undefined): string {
  const ms = toMs(value);
  return ms == null ? '' : dateTime('time', TIME).format(ms);
}

export function formatCost(usd: number | null | undefined): string {
  const digits = usd && usd < 0.01 ? 4 : 2;
  return cached(`usd:${digits}`, (l) =>
    new Intl.NumberFormat(l, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }),
  ).format(usd || 0);
}

/** A plain number in the active language: 1,500 in English, 1.500 in Spanish. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return cached(`number:${JSON.stringify(options ?? {})}`, (l) => new Intl.NumberFormat(l, options)).format(value);
}

export function formatBytes(bytes: number): string {
  // Ungrouped, as before: 2048.0 MB, never 2,048.0 MB
  const decimal = (value: number, digits: number) =>
    formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
  if (bytes < 1024) return `${decimal(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${decimal(bytes / 1024, 1)} KB`;
  return `${decimal(bytes / 1024 / 1024, 1)} MB`;
}

export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = path.split('/').filter(Boolean);
  let out = parts.pop() ?? path;
  while (parts.length > 0) {
    const next = `${parts[parts.length - 1]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
    parts.pop();
  }
  return `…/${out}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function errorMessage(error: unknown): string {
  if (!error) return '';
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    return typeof detail === 'string' && detail ? `${error.message} — ${detail}` : error.message;
  }
  return String(error);
}
