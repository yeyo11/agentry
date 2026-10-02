import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, CodeHostStatus, TrackerIssue, TrackerStatus } from '@agentry/shared';
import { api, keys } from '../src/api';
import { targetsFor } from '../src/lib/events';
import {
  canChooseTracker, canSyncAgain, columnSyncs, importKeys, isSelectable, issueRef, setMapped, statusChoices, toggleAll, toggleKey, trackerAction, trackerEntry, trackerTone, withTrackerEntry,
} from '../src/lib/trackers';

const status = (id: TrackerStatus['id'], state: TrackerStatus['state']) => ({ id, state }) as TrackerStatus;
const issue = (key: string, importedItemId: string | null = null) => ({ tracker: 'github-issues', key, importedItemId }) as TrackerIssue;

test('GitHub and GitLab number their issues, Jira and YouTrack write the key', () => {
  assert.equal(issueRef('github-issues', '12'), '#12');
  assert.equal(issueRef('gitlab-issues', '7'), '#7');
  assert.equal(issueRef('jira', 'PROJ-12'), 'PROJ-12');
});

test('a tracker that is not built offers no action, whatever its state', () => {
  assert.equal(trackerAction(status('jira', 'unknown')), null);
  assert.equal(trackerAction(status('youtrack', 'not-installed')), null);
  assert.equal(trackerAction(status('github-issues', 'signed-out')), 'sign-in');
  assert.equal(trackerAction(status('gitlab-issues', 'not-installed')), 'install');
  assert.equal(trackerAction(status('github-issues', 'ready')), null);
  assert.equal(trackerAction(status('github-issues', 'signed-out'), false), null);
});

test('status colours: ready ok, signed out warn, incompatible bad, off muted', () => {
  assert.equal(trackerTone(status('github-issues', 'ready')), 'ok');
  assert.equal(trackerTone(status('github-issues', 'signed-out')), 'warn');
  assert.equal(trackerTone(status('github-issues', 'incompatible')), 'bad');
  assert.equal(trackerTone(status('github-issues', 'ready'), false), 'muted');
});

test('only a ready, built tracker can be chosen for a project', () => {
  assert.equal(canChooseTracker(status('github-issues', 'ready')), true);
  assert.equal(canChooseTracker(status('github-issues', 'signed-out')), false);
  assert.equal(canChooseTracker(status('jira', 'ready')), false);
  assert.equal(canChooseTracker(undefined), false);
});

test('settings entries default to on and are replaced one at a time', () => {
  assert.deepEqual(trackerEntry(undefined, 'jira'), { enabled: true, binaryPath: null });
  const base = { trackers: { 'github-issues': { enabled: true, binaryPath: null } } } as never;
  const next = withTrackerEntry(base, 'github-issues', { enabled: false, binaryPath: '/bin/gh' });
  assert.equal(trackerEntry(next, 'github-issues').enabled, false);
});

test('only the done column writes to GitHub and GitLab', () => {
  assert.deepEqual(statusChoices('github-issues', 'done'), ['completed']);
  assert.equal(columnSyncs('gitlab-issues', 'in_review'), false);
  assert.equal(columnSyncs('jira', 'done'), false);
  assert.deepEqual(setMapped({ done: 'completed' }, 'done', ''), {});
  assert.deepEqual(setMapped({}, 'done', 'completed'), { done: 'completed' });
});

test('Sync again is offered only for a failed write', () => {
  assert.equal(canSyncAgain({ syncState: 'failed' }), true);
  assert.equal(canSyncAgain({ syncState: 'synced' }), false);
  assert.equal(canSyncAgain({ syncState: 'none' }), false);
});

test('selection skips what is already imported and keeps the page order', () => {
  const page = [issue('3'), issue('2', 'item-1'), issue('1')];
  assert.equal(isSelectable(page[1] as TrackerIssue), false);
  assert.deepEqual(importKeys(page, new Set(['1', '2', '3'])), ['3', '1']);
  const all = toggleAll(page, new Set());
  assert.deepEqual([...all].sort(), ['1', '3']);
  assert.equal(toggleAll(page, all).size, 0);
  assert.deepEqual([...toggleKey(new Set(['1']), '1')], []);
});

test('the tracker routes are reachable through the client', () => {
  for (const method of ['trackers', 'refreshTrackers', 'trackerSettings', 'putTrackerSettings', 'projectTracker', 'putProjectTracker', 'trackerIssues', 'importTrackerIssues', 'linkWorkItemIssue', 'unlinkWorkItemIssue', 'syncWorkItemIssue'] as const) {
    assert.equal(typeof api[method], 'function', method);
  }
  assert.deepEqual(keys.trackerIssues('p1', 'is:open', 2).slice(0, 2), keys.projectTracker('p1'));
});

test('a host change makes the trackers and every project\'s issue search stale', () => {
  const event = { id: 1, at: '2026-10-02T00:00:00.000Z', type: 'hosts.changed', hosts: [] as CodeHostStatus[] } as unknown as AgentryEvent;
  const names = targetsFor(event).map(([key]) => key[0]);
  assert.ok(names.includes('trackers'));
  assert.ok(names.includes('project-tracker'));
});

test('an imported item and a saved tracker refresh the project\'s issue search', () => {
  const created = { id: 2, at: '2026-10-02T00:00:00.000Z', type: 'workitem.created', projectId: 'p1', itemId: 'i1' } as unknown as AgentryEvent;
  assert.ok(targetsFor(created).some(([key]) => key[0] === 'project-tracker' && key[1] === 'p1'));
  const updated = { id: 3, at: '2026-10-02T00:00:00.000Z', type: 'project.updated', projectId: 'p1', changes: ['settings'] } as unknown as AgentryEvent;
  assert.ok(targetsFor(updated).some(([key]) => key[0] === 'project-tracker' && key[1] === 'p1'));
});
