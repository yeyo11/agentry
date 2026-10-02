import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { TrackersSettings } from '@agentry/shared';
import { CodeHostDetector } from '../src/hosts/detector.ts';
import { defaultCodeHostsSettings } from '../src/hosts/settings.ts';
import { TrackerDetector, type TrackerDetectorDeps } from '../src/trackers/detector.ts';
import { TRACKER_MANIFESTS, TrackerRegistry } from '../src/trackers/registry.ts';
import { adapterOf, ghHosts, scripted, type Script } from './hosts/stub-adapters.ts';

let root: string;
let bin: string;
let n = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentry-trackers-detector-'));
});
after(() => rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  n += 1;
  bin = join(root, `bin${n}`);
  await mkdir(bin);
});

async function fake(name: string): Promise<string> {
  const file = join(bin, name);
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return file;
}

/** The real host detector on a scripted `run`, under the tracker detector: the chain the app builds. */
function detectors(script: Script, extra: Partial<TrackerDetectorDeps> = {}) {
  const run = scripted(script);
  const hosts = new CodeHostDetector({
    adapter: adapterOf,
    run,
    resolvePath: async () => bin,
    glabHosts: async () => [{ hostname: 'gitlab.com', user: 'tanuki' }],
    env: { PATH: bin },
    home: join(root, 'home'),
    settings: () => defaultCodeHostsSettings(),
  });
  const trackers = new TrackerDetector({ hosts, adapter: adapterOf, run, resolvePath: async () => bin, env: { PATH: bin }, home: join(root, 'home'), ...extra });
  return { hosts, trackers };
}

const settings = (patch: Partial<TrackersSettings['trackers']>): (() => TrackersSettings) => () => ({
  trackers: {
    'github-issues': { enabled: true, binaryPath: null },
    'gitlab-issues': { enabled: true, binaryPath: null },
    jira: { enabled: true, binaryPath: null },
    youtrack: { enabled: true, binaryPath: null },
    ...patch,
  },
});

describe('TrackerDetector', () => {
  it('lists the four trackers in registry order, a host tracker ready with its host\'s CLI and floor', async () => {
    await fake('gh');
    const { trackers } = detectors({ ghAuth: ghHosts({ 'github.com': 'octo' }) });
    const all = await trackers.statuses();
    assert.deepEqual(all.map((s) => s.id), ['github-issues', 'gitlab-issues', 'jira', 'youtrack']);
    const [github, gitlab] = all;
    assert.equal(github?.state, 'ready');
    assert.equal(github?.reason, null);
    assert.equal(github?.host, 'github');
    assert.equal(github?.cli, 'gh');
    assert.equal(github?.version, '2.92.0');
    assert.equal(github?.binaryPath, join(bin, 'gh'));
    assert.equal(github?.minimum, '2.92.0');
    assert.deepEqual(github?.recorded, ['2.92.0', '2.102.0']);
    assert.equal(gitlab?.state, 'not-installed');
    assert.equal(gitlab?.binaryPath, null);
  });

  it('follows its host: signed out, below the floor, and glab on a release not recorded is still usable', async () => {
    await fake('gh');
    await fake('glab');
    const signedOut = detectors({ ghAuth: ghHosts({ 'github.com': null }), glabVersion: '1.121.0', glabSignedIn: ['gitlab.com'] });
    const [github, gitlab] = await signedOut.trackers.statuses();
    assert.equal(github?.state, 'signed-out');
    assert.equal(gitlab?.state, 'ready');

    const old = detectors({ ghVersion: '2.45.0' });
    const incompatible = await old.trackers.status('github-issues');
    assert.equal(incompatible?.state, 'incompatible');
    assert.equal(incompatible?.reason, 'below-minimum');
  });

  it('reads jira and youtrack as unknown with not-recorded, with no floor, no binary and no probe', async () => {
    await fake('acli');
    await fake('youtrack-app');
    const script: Script = { calls: [] };
    const { trackers } = detectors(script);
    for (const id of ['jira', 'youtrack'] as const) {
      const status = await trackers.status(id);
      assert.equal(status?.state, 'unknown', id);
      assert.equal(status?.reason, 'not-recorded', id);
      assert.equal(status?.host, null, id);
      assert.equal(status?.minimum, null, id);
      assert.deepEqual(status?.recorded, [], id);
      assert.equal(status?.binaryPath, null, id);
    }
    assert.ok(!script.calls?.some((call) => call.cli === 'acli' || call.cli === 'youtrack-app'));
  });

  it('a tracker turned off is unknown with no reason, and jira stays not-recorded', async () => {
    await fake('gh');
    const { trackers } = detectors({ ghAuth: ghHosts({ 'github.com': 'octo' }) }, { settings: settings({ 'github-issues': { enabled: false, binaryPath: null } }) });
    const github = await trackers.status('github-issues');
    assert.equal(github?.state, 'unknown');
    assert.equal(github?.reason, null);
    assert.equal((await trackers.status('jira'))?.reason, 'not-recorded');
  });

  it('reads the version of a binary chosen for the tracker, and holds it to the host\'s floor', async () => {
    await fake('gh');
    const chosen = await fake('gh-mine');
    const script: Script = { ghAuth: ghHosts({ 'github.com': 'octo' }), calls: [] };
    const { trackers } = detectors(script, { settings: settings({ 'github-issues': { enabled: true, binaryPath: chosen } }) });
    const github = await trackers.status('github-issues');
    assert.equal(github?.state, 'ready');
    assert.equal(github?.binaryPath, chosen);
    await trackers.status('github-issues');
    assert.equal(script.calls?.filter((call) => call.args[0] === '--version').length, 2, 'one for the host, one for the chosen binary, read once');

    const old = detectors({ ghAuth: ghHosts({ 'github.com': 'octo' }), ghVersion: '2.10.0' }, { settings: settings({ 'github-issues': { enabled: true, binaryPath: chosen } }) });
    const stale = await old.trackers.status('github-issues');
    assert.equal(stale?.state, 'incompatible');
    assert.equal(stale?.reason, 'below-minimum');

    const gone = detectors({ ghAuth: ghHosts({ 'github.com': 'octo' }) }, { settings: settings({ 'github-issues': { enabled: true, binaryPath: join(bin, 'missing') } }) });
    assert.equal((await gone.trackers.status('github-issues'))?.state, 'not-installed');
  });

  it('refresh detects the hosts again, so a sign-in shows up', async () => {
    await fake('gh');
    const script: Script = { ghAuth: ghHosts({ 'github.com': null }) };
    const { trackers } = detectors(script);
    assert.equal((await trackers.status('github-issues'))?.state, 'signed-out');
    script.ghAuth = ghHosts({ 'github.com': 'octo' });
    const refreshed = await trackers.refresh();
    assert.equal(refreshed.find((s) => s.id === 'github-issues')?.state, 'ready');
  });
});

describe('every tracker manifest', () => {
  it('names a host that exists exactly when its CLI facts are the host\'s', () => {
    for (const manifest of TRACKER_MANIFESTS) assert.equal(manifest.host !== null, manifest.recording === 'host', manifest.id);
    assert.ok(new TrackerRegistry().list().length === 4);
  });
});
