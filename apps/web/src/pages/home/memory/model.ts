import type { JournalEntry, MemoryFile } from '@agentry/shared';

/** A local calendar day, `YYYY-MM-DD`: the journal groups by the person's day, not UTC's. */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface DayGroup<T> {
  /** `today`, `yesterday`, or the local day `YYYY-MM-DD` */
  day: string;
  entries: T[];
}

/** Entries, already newest first, cut into days: today, yesterday, then each earlier day. */
export function dayGroups<T extends Pick<JournalEntry, 'createdAt'>>(entries: readonly T[], now: Date): DayGroup<T>[] {
  const today = localDay(now);
  const before = new Date(now);
  before.setDate(before.getDate() - 1);
  const yesterday = localDay(before);
  const groups: DayGroup<T>[] = [];
  for (const entry of entries) {
    const local = localDay(new Date(entry.createdAt));
    const day = local === today ? 'today' : local === yesterday ? 'yesterday' : local;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

/** `12:40`: a time of day without its seconds, in `locale`, for a list already grouped by day. */
export function hourMinute(value: string, locale: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? '' : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ms);
}

/** The size of a text as written to disk, in UTF-8 bytes. */
export const byteSize = (text: string): number => new TextEncoder().encode(text).length;

/** The CLI's memory directory, from the path of any of its files; null with none. */
export function memoryDir(files: readonly Pick<MemoryFile, 'path'>[]): string | null {
  const first = files[0];
  if (!first) return null;
  const cut = first.path.lastIndexOf('/');
  return cut > 0 ? first.path.slice(0, cut) : null;
}

/** The index first, then the rest by name: the order the CLI's memory reads in. */
export function sortMemoryFiles<T extends Pick<MemoryFile, 'name' | 'isIndex'>>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => Number(b.isIndex) - Number(a.isIndex) || a.name.localeCompare(b.name));
}
