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

test('Jira and YouTrack are shown as not available yet, with no way to choose them', () => {
  const jira = trackerOption(status({ id: 'jira', cli: 'acli', host: null, state: 'unknown', reason: 'not-recorded' }), 'github', true);
  assert.equal(jira.choosable, false);
  assert.equal(jira.reason, 'not-built');
  assert.equal(trackerOption(status({ id: 'youtrack', cli: 'youtrack-app', host: null }), 'github', true).choosable, false);
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
