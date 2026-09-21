import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Schedule } from '@agentry/shared';
import { matchesText, PROJECT_SORTERS, scheduleFields, scheduleView } from '../src/lib/lists.ts';

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  name: 'Morning dependency check',
  cron: '0 9 * * 1-5',
  target: { kind: 'chat', chat: { prompt: 'Summarise what changed since yesterday', cwd: '/work/alpha' } },
  enabled: true,
  overlap: 'parallel',
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const project = (over: Partial<Project>): Project => ({ id: 'p', name: 'p', path: '/p', worktrees: [], exists: true, chatCount: 0, lastActivity: null, ...over });

test('every word typed has to be found, in any order and any case', () => {
  assert.equal(matchesText('', ['anything']), true);
  assert.equal(matchesText('  ', ['anything']), true);
  assert.equal(matchesText('deps MORNING', ['Morning deps check']), true);
  assert.equal(matchesText('morning nightly', ['Morning deps check']), false);
  // Words may come from different fields
  assert.equal(matchesText('alpha morning', ['Morning check', null, '/work/alpha']), true);
});

test('a schedule is found by its name, its expression and what it starts', () => {
  const chat = schedule();
  assert.equal(matchesText('1-5', scheduleFields(chat)), true);
  assert.equal(matchesText('yesterday', scheduleFields(chat)), true);
  assert.equal(matchesText('alpha', scheduleFields(chat)), true);
  const orchestration = schedule({ target: { kind: 'orchestration', spec: { name: 'release train', objective: 'Ship the week', tasks: [] } } });
  assert.equal(matchesText('train ship', scheduleFields(orchestration)), true);
});

test('a schedule is on or off by whether it is enabled', () => {
  assert.equal(scheduleView(schedule()), 'on');
  assert.equal(scheduleView(schedule({ enabled: false })), 'off');
});

test('projects sort by activity with the untouched ones last, by name, or by chats', () => {
  const quiet = project({ id: 'q', name: 'quiet' });
  const busy = project({ id: 'b', name: 'busy', chatCount: 9, lastActivity: '2026-01-02T00:00:00Z' });
  const older = project({ id: 'o', name: 'older', chatCount: 3, lastActivity: '2026-01-01T00:00:00Z' });
  const ids = (sorter: (a: Project, b: Project) => number) => [quiet, older, busy].sort(sorter).map((p) => p.id);
  assert.deepEqual(ids(PROJECT_SORTERS.activity), ['b', 'o', 'q']);
  assert.deepEqual(ids(PROJECT_SORTERS.name), ['b', 'o', 'q']);
  assert.deepEqual(ids(PROJECT_SORTERS.chats), ['b', 'o', 'q']);
});
