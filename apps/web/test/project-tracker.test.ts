import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { TrackerStatus } from '@agentry/shared';
import { TRACKER_IDS } from '../src/lib/trackers';
import { canSaveDraft, chooseTracker, draftOf, NO_TRACKER, sameDraft, settingsOf, trackerOption, trackerOptions, withMapped } from '../src/pages/home/project-tracker';

const status = (over: Partial<TrackerStatus>): TrackerStatus => ({
  id: 'github-issues',
  label: 'GitHub Issues',
  cli: 'gh',
  host: 'github',
  binaryPath: '/usr/bin/gh',
  version: '2.92.0',
  minimum: '2.40.0',
  recorded: ['2.92.0'],
  state: 'ready',
  reason: null,
  checkedAt: '2026-10-02T00:00:00.000Z',
  ...over,
});

test('no tracker reads as none and saves as null', () => {
  assert.deepEqual(draftOf(null), NO_TRACKER);
  assert.equal(settingsOf(NO_TRACKER), null);
});

test('a chosen tracker starts from the origin repository and Done closing the issue', () => {
  const draft = chooseTracker(NO_TRACKER, 'github-issues', 'me/repo');
  assert.deepEqual(settingsOf(draft), { id: 'github-issues', scope: 'me/repo', query: '', statusMap: { done: 'completed' } });
});

test('choosing the same tracker again keeps the draft, and another drops the query', () => {
  const typed = { ...chooseTracker(NO_TRACKER, 'github-issues', 'me/repo'), query: 'is:open' };
  assert.equal(chooseTracker(typed, 'github-issues', 'me/repo'), typed);
  assert.equal(chooseTracker(typed, 'gitlab-issues', 'me/repo').query, '');
  assert.deepEqual(chooseTracker(typed, null, 'me/repo'), NO_TRACKER);
});

test('what is saved is trimmed, and the draft is compared by it', () => {
  const base = draftOf({ id: 'github-issues', scope: 'me/repo', query: 'is:open', statusMap: { done: 'completed' } });
  assert.equal(sameDraft({ ...base, scope: ' me/repo ' }, base), true);
  assert.equal(sameDraft(withMapped(base, 'done', ''), base), false);
  assert.deepEqual(withMapped(base, 'done', '').statusMap, {});
});

test('a chosen tracker needs a scope to be saved', () => {
  assert.equal(canSaveDraft(NO_TRACKER), true);
  assert.equal(canSaveDraft(chooseTracker(NO_TRACKER, 'github-issues', null)), false);
  assert.equal(canSaveDraft(chooseTracker(NO_TRACKER, 'github-issues', 'me/repo')), true);
});

test('a ready tracker of the project host can be chosen', () => {
  const option = trackerOption(status({}), 'github', true);
  assert.equal(option.choosable, true);
  assert.equal(option.reason, 'ready');
  assert.equal(option.tone, 'ok');
});

test('a tracker of another host is refused even when ready', () => {
  const option = trackerOption(status({ id: 'gitlab-issues', host: 'gitlab' }), 'github', true);
  assert.equal(option.choosable, false);
  assert.equal(option.reason, 'wrong-host');
});

test('a tracker that is off, signed out or not installed says why', () => {
  assert.equal(trackerOption(status({}), 'github', false).reason, 'disabled');
  const signedOut = trackerOption(status({ state: 'signed-out' }), 'github', true);
  assert.equal(signedOut.choosable, false);
  assert.equal(signedOut.reason, 'signed-out');
  assert.equal(signedOut.tone, 'warn');
  assert.equal(trackerOption(status({ state: 'not-installed' }), 'github', true).reason, 'not-installed');
});

test('a tracker turned off in Integrations cannot be chosen, and says so', () => {
  const off = trackerOption(status({ id: 'youtrack', cli: 'youtrack-app', host: null, state: 'ready', reason: null }), 'github', false);
  assert.equal(off.choosable, false);
  assert.equal(off.reason, 'disabled');
});

test('YouTrack can be chosen on any project once it is ready, and not while its access is missing', () => {
  for (const host of ['github', 'gitlab', null] as const) {
    assert.equal(trackerOption(status({ id: 'youtrack', cli: 'youtrack-app', host: null, state: 'ready', reason: null }), host, true).choosable, true);
  }
  const missing = trackerOption(status({ id: 'youtrack', cli: 'youtrack-app', host: null, state: 'signed-out', reason: 'no-credentials' }), 'github', true);
  assert.equal(missing.choosable, false);
  assert.equal(missing.reason, 'signed-out');
});

test('choosing YouTrack starts from an empty project and the State names a new project has; typed States are saved trimmed', () => {
  const draft = chooseTracker(NO_TRACKER, 'youtrack', 'acme/widgets');
  assert.deepEqual(draft, { id: 'youtrack', scope: '', query: '', statusMap: { in_progress: 'In Progress', done: 'Done' } });
  const typed = withMapped(withMapped({ ...draft, scope: ' AGP ' }, 'in_review', '  To Verify '), 'in_progress', '   ');
  assert.deepEqual(settingsOf(typed), { id: 'youtrack', scope: 'AGP', query: '', statusMap: { in_review: 'To Verify', done: 'Done' } });
});

test('the chooser lists the trackers in the order every list uses', () => {
  const statuses = [...TRACKER_IDS].reverse().map((id) => status({ id }));
  assert.deepEqual(trackerOptions(statuses, TRACKER_IDS, 'github', () => true).map((o) => o.id), [...TRACKER_IDS]);
});

test('the form is mounted in the project settings and saves through the client', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('../src/pages/home/ProjectSettings.tsx'), /<ProjectTracker project=\{project\} \/>/);
  const form = read('../src/pages/home/ProjectTracker.tsx');
  assert.match(form, /api\.putProjectTracker/);
  assert.match(form, /api\.projectTracker/);
  assert.match(form, /Select, Sheet \} from '@agentry\/ui\/components\/controls'/);
});
