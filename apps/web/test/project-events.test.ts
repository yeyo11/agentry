import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryKey } from '@tanstack/react-query';
import type { ProjectCreatedEvent, ProjectRemovedEvent } from '@agentry/shared';
import { keys } from '../src/api';
import { targetsFor } from '../src/lib/events';

// A project added or removed in another tab shows in this one: its lists and the All projects views
// are read again, and no one project's board, which the event says nothing about.

const startsWith = (key: QueryKey, prefix: QueryKey) => prefix.every((part, i) => JSON.stringify(part) === JSON.stringify(key[i]));
const refetches = (targets: QueryKey[], key: QueryKey) => targets.some((prefix) => startsWith(key, prefix));

test('a project added or removed refreshes the projects and the All projects views', () => {
  const created: ProjectCreatedEvent = { id: 1, at: '2026-09-28T10:00:00Z', title: 'Shop added', type: 'project.created', projectId: 'p1', projectName: 'Shop' };
  const removed: ProjectRemovedEvent = { ...created, id: 2, title: 'Shop removed', type: 'project.removed' };
  for (const event of [created, removed]) {
    const targets = targetsFor(event).map(([key]) => key);
    for (const key of [keys.projects, keys.projectCandidates, keys.overview, keys.workItemBoard(null), keys.workItemList(null)]) {
      assert.ok(refetches(targets, key), `${event.type} refreshes ${JSON.stringify(key)}`);
    }
    assert.equal(refetches(targets, keys.workItemBoard('p2')), false);
  }
});
