import { formatDate, formatHour, toMs } from '@agentry/ui/lib/format';

/** A reset as a person reads it: the hour when it is today, the day and the hour when it is not. */
export function resetWhen(iso: string, now = Date.now()): string {
  const ms = toMs(iso);
  if (ms === null) return '';
  return new Date(ms).toDateString() === new Date(now).toDateString() ? formatHour(ms) : `${formatDate(ms)} ${formatHour(ms)}`;
}
