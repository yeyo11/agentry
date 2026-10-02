import assert from 'node:assert/strict';
import test from 'node:test';
import { githubAdapter } from '../src/hosts/github/adapter.ts';
import type { ChecksTarget } from '../src/hosts/checks-service.ts';
import { mergeTargetOf } from '../src/hosts/merge-target.ts';
import { cleanup, opened, reviewed, setup, sh, write } from './fixtures/pr-harness.ts';

// What a host-side rebase would cost the checkout, read from real git: the branch was pushed by
// approving the item, so the checkout starts with nothing to lose.

test('the checkout of a pushed branch loses nothing; an uncommitted file, or a commit never pushed, is what Rebase on GitLab would cost', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    const worktree = item.worktree ?? '';
    const base = { id: 'cr-1', kind: 'work-item', repo: { host: 'github.com', path: 'acme/shop', owner: 'acme', name: 'shop' }, number: 7, branch: 'task/cw-1', base: 'main', run: async () => Promise.reject(new Error('unused')) } as unknown as ChecksTarget;
    const target = mergeTargetOf(base, 'github', githubAdapter, { home: s.r.project, worktree });
    assert.deepEqual(await target.checkout?.(), { uncommitted: false, unpushed: false });

    write(worktree, 'scratch.ts', 'export const scratch = 1;\n');
    assert.deepEqual(await target.checkout?.(), { uncommitted: true, unpushed: false });

    sh(worktree, 'add', '-A');
    sh(worktree, 'commit', '-q', '-m', 'never pushed');
    assert.deepEqual(await target.checkout?.(), { uncommitted: false, unpushed: true });

    // No checkout, nothing to lose and nothing to read
    assert.equal(mergeTargetOf(base, 'github', githubAdapter, null).checkout, undefined);
    assert.equal(mergeTargetOf(base, 'github', githubAdapter, { home: s.r.project, worktree: null }).checkout, undefined);
  } finally {
    cleanup(s);
  }
});
