import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubIssuesManifest } from '../src/trackers/github-issues/manifest.ts';
import { gitlabIssuesManifest } from '../src/trackers/gitlab-issues/manifest.ts';
import type { TrackerManifest } from '../src/trackers/manifest.ts';
import { TrackerRegistry } from '../src/trackers/registry.ts';

test('the registry lists the four trackers, each by its CLI', () => {
  const registry = new TrackerRegistry();
  assert.deepEqual(registry.list().map((m) => [m.id, m.cli, m.host]), [
    ['github-issues', 'gh', 'github'],
    ['gitlab-issues', 'glab', 'gitlab'],
    ['jira', 'acli', null],
    ['youtrack', 'youtrack-app', null],
  ]);
  assert.equal(registry.get('github-issues'), githubIssuesManifest);
  assert.equal(registry.ofHost('gitlab'), gitlabIssuesManifest);
});

test('a host\'s tracker needs the project\'s host to be that host; the others fit any project', () => {
  const registry = new TrackerRegistry();
  assert.equal(registry.fitsProject('github-issues', 'github'), true);
  assert.equal(registry.fitsProject('github-issues', 'gitlab'), false);
  assert.equal(registry.fitsProject('github-issues', null), false);
  assert.equal(registry.fitsProject('gitlab-issues', 'gitlab'), true);
  assert.equal(registry.fitsProject('jira', 'github'), true);
  assert.equal(registry.fitsProject('youtrack', null), true);
});

test('two manifests sharing an id or a code host throw when the registry is built', () => {
  const copy = (manifest: TrackerManifest, patch: Partial<TrackerManifest>): TrackerManifest => ({ ...manifest, ...patch });
  assert.throws(() => new TrackerRegistry([githubIssuesManifest, copy(gitlabIssuesManifest, { id: 'github-issues' })]), /declared twice/);
  assert.throws(() => new TrackerRegistry([githubIssuesManifest, copy(gitlabIssuesManifest, { host: 'github' })]), /reused by both/);
});
