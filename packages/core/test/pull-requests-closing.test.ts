import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectTrackerSettings } from '@agentry/shared';
import { PullRequestWatcher } from '../src/pull-requests.ts';
import type { MergedNotice } from '../src/trackers/sync.ts';
import { cleanup, expectGolden, note, opened, record, reviewed, setup, view, type Setup } from './fixtures/pr-harness.ts';

// What the host closed when a change request merged (matrix F10): the body is written once, when the
// request opens, so only the host's own answer says which issues it closed. Every call is compared
// with a committed log; the fake gh answers `pr view --json closingIssuesReferences` from
// $state/closing.json, in the shape recorded for gh 2.92.0 and 2.102.0.

const PHASE = 'phase5';
const GH_TRACKER: ProjectTrackerSettings = { id: 'github-issues', scope: 'acme/shop', query: '', statusMap: { done: 'closed' } };

const reference = (number: number, repo = 'shop', owner = 'acme') => ({ id: 'I_x', number, repository: { id: 'R_x', name: repo, owner: { id: 'U_x', login: owner } }, url: `https://github.com/${owner}/${repo}/issues/${String(number)}` });

async function merged(name: string, tracker: ProjectTrackerSettings | undefined, prepare: (s: Setup) => void, expect: (told: MergedNotice[], s: Setup, itemId: string) => void, unlinked: string[] = []): Promise<void> {
  const told: MergedNotice[] = [];
  const s = setup({
    ...(tracker ? { tracker } : {}),
    onMerged: async (notice) => {
      told.push(notice);
      return { closedUnlinked: unlinked };
    },
  });
  try {
    const item = reviewed(s);
    await opened(s, item);
    prepare(s);
    record(s.r);
    note(s.r, 'tick, merged');
    view(s.r, 'MERGED', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]);
    await new PullRequestWatcher(s.service).tick();
    expect(told, s, item.id);
    expectGolden(s.r, PHASE, name);
  } finally {
    cleanup(s);
  }
}

test('golden: a merge reads the issues the host closed and tells the sync, with their repositories', () =>
  merged(
    'merge-closed-issues',
    GH_TRACKER,
    (s) => writeFileSync(join(s.r.state, 'closing.json'), JSON.stringify({ closingIssuesReferences: [reference(12), reference(3, 'other', 'acme')] })),
    (told) => {
      assert.equal(told.length, 1);
      assert.deepEqual(told[0]?.closed, [
        { scope: 'acme/shop', key: '12' },
        { scope: 'acme/other', key: '3' },
      ]);
      assert.equal(told[0]?.host, 'github');
    },
  ));

test('golden: a merge whose closing issues could not be read tells the sync so, and does not guess an empty list', () =>
  merged(
    'merge-closed-issues-unreadable',
    GH_TRACKER,
    (s) => writeFileSync(join(s.r.state, 'closing-fail'), ''),
    (told) => assert.equal(told[0]?.closed, null),
  ));

test('a project with no tracker, or one that is not on the request’s host, reads nothing from the host', async () => {
  for (const tracker of [undefined, { ...GH_TRACKER, id: 'youtrack', scope: 'PROJ' } satisfies ProjectTrackerSettings]) {
    const told: MergedNotice[] = [];
    const s = setup({ ...(tracker ? { tracker } : {}), onMerged: async (n) => (told.push(n), { closedUnlinked: [] }) });
    try {
      await opened(s, reviewed(s));
      view(s.r, 'MERGED');
      await new PullRequestWatcher(s.service).tick();
      assert.deepEqual(told.map((n) => n.closed), [[]]);
      assert.ok(!readFileSync(join(s.r.state, 'calls'), 'utf8').includes('closingIssuesReferences'));
    } finally {
      cleanup(s);
    }
  }
});

test('an issue the host closed that the item does not link is on the request’s row, with its address', () =>
  merged(
    'merge-closed-unlinked',
    GH_TRACKER,
    (s) => writeFileSync(join(s.r.state, 'closing.json'), JSON.stringify({ closingIssuesReferences: [reference(9)] })),
    (_told, s, itemId) => assert.deepEqual(s.items.find(itemId)?.pullRequest?.error, { code: 'issue-closed-unlinked', detail: 'acme/shop#9' }),
    ['acme/shop#9'],
  ));
