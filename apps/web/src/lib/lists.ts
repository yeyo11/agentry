import type { Project, Schedule } from '@agentry/shared';

/**
 * What the search field of a list page matches: every word typed has to appear in one of the
 * fields, in any order and any case, so "deps morning" finds "Morning dependency check".
 */
export function matchesText(search: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join('\n').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** A schedule is found by its name, its expression, and what it starts. */
export function scheduleFields(schedule: Schedule): string[] {
  const target = schedule.target.kind === 'chat' ? [schedule.target.chat.prompt, schedule.target.chat.cwd] : [schedule.target.spec.name, schedule.target.spec.objective, schedule.target.spec.cwd];
  return [schedule.name, schedule.cron, schedule.timezone ?? '', ...target.map((v) => v ?? '')];
}

export type ScheduleView = 'all' | 'on' | 'off';

export function scheduleView(schedule: Pick<Schedule, 'enabled'>): Exclude<ScheduleView, 'all'> {
  return schedule.enabled ? 'on' : 'off';
}

export type ProjectSort = 'activity' | 'name' | 'chats';

export const PROJECT_SORTERS: Record<ProjectSort, (a: Project, b: Project) => number> = {
  // A project nothing has happened in yet sorts after every one that has seen a chat
  activity: (a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  chats: (a, b) => b.chatCount - a.chatCount || a.name.localeCompare(b.name),
};
