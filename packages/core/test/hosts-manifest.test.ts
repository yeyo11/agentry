import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions } from '../src/cli-version.ts';
import { githubManifest } from '../src/hosts/github/manifest.ts';
import { gitlabManifest } from '../src/hosts/gitlab/manifest.ts';
import type { CodeHostManifest } from '../src/hosts/manifest.ts';
import { CODE_HOST_MANIFESTS, CodeHostRegistry } from '../src/hosts/registry.ts';

const copy = (manifest: CodeHostManifest, patch: Partial<CodeHostManifest>): CodeHostManifest => ({ ...manifest, ...patch });

test('the registry lists github and gitlab, each by its own CLI', () => {
  const registry = new CodeHostRegistry();
  assert.deepEqual(registry.list().map((m) => [m.id, m.cli]), [['github', 'gh'], ['gitlab', 'glab']]);
  assert.equal(registry.get('github'), githubManifest);
  assert.equal(registry.get('gitlab'), gitlabManifest);
});

test('the facts the plan records are what the manifests say', () => {
  assert.equal(githubManifest.versions.minimum, '2.92.0');
  assert.deepEqual(githubManifest.versions.recorded, ['2.92.0', '2.102.0']);
  assert.equal(githubManifest.versions.untested, 'ready');
  assert.equal(gitlabManifest.versions.minimum, '1.120.0');
  assert.deepEqual(gitlabManifest.versions.recorded, ['1.120.0']);
  assert.equal(gitlabManifest.versions.untested, 'degraded');
  assert.deepEqual([githubManifest.refPrefix, gitlabManifest.refPrefix], ['#', '!']);
  assert.deepEqual([githubManifest.changeRequestNoun, gitlabManifest.changeRequestNoun], ['pull request', 'merge request']);
  assert.deepEqual(githubManifest.auth, { kind: 'hosts-json', args: ['auth', 'status', '--json', 'hosts'] });
  assert.deepEqual(gitlabManifest.auth, { kind: 'exit-code', args: ['auth', 'status'], hostFlag: '--hostname' });
});

test('every recorded release is at or above the minimum, and each manifest names its pages', () => {
  for (const manifest of CODE_HOST_MANIFESTS) {
    for (const release of manifest.versions.recorded) {
      assert.ok(compareVersions(release, manifest.versions.minimum) >= 0, `${manifest.id} ${release}`);
    }
    for (const url of [manifest.install.url, manifest.signInUrl, manifest.docsUrl]) assert.match(url, /^https:\/\//);
    assert.ok(manifest.defaultHosts.length > 0);
  }
});

test('the registry resolves a default host, whatever its case', () => {
  const registry = new CodeHostRegistry();
  assert.equal(registry.byDefaultHost('GitHub.com')?.id, 'github');
  assert.equal(registry.byDefaultHost('gitlab.com')?.id, 'gitlab');
  assert.equal(registry.byDefaultHost('git.example.com'), undefined);
});

test('two manifests sharing an id, a CLI or a default host throw when the registry is built', () => {
  assert.throws(() => new CodeHostRegistry([githubManifest, copy(gitlabManifest, { id: 'github' })]), /declared twice/);
  assert.throws(() => new CodeHostRegistry([githubManifest, copy(gitlabManifest, { cli: 'gh' })]), /CLI "gh" is claimed/);
  assert.throws(
    () => new CodeHostRegistry([githubManifest, copy(gitlabManifest, { defaultHosts: ['github.com'] })]),
    /Host "github.com" is claimed/,
  );
  assert.doesNotThrow(() => new CodeHostRegistry());
});
