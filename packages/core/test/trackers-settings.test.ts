import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Core } from '../src/index.ts';
import { TrackersSettingsStore, defaultTrackersSettings } from '../src/trackers/settings.ts';
import { tempConfig } from './helpers.ts';

let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentry-trackers-settings-'));
});
after(() => rm(root, { recursive: true, force: true }));

const store = (): { dir: string; store: TrackersSettingsStore } => {
  n += 1;
  const dir = join(root, `data${n}`);
  return { dir, store: new TrackersSettingsStore({ dataDir: dir }) };
};

describe('TrackersSettingsStore', () => {
  it('reads every tracker on, searching for its binary, until the first save', () => {
    assert.deepEqual(store().store.get(), defaultTrackersSettings());
    assert.deepEqual(Object.keys(defaultTrackersSettings().trackers), ['github-issues', 'gitlab-issues', 'youtrack']);
    assert.deepEqual(defaultTrackersSettings().trackers.youtrack, { enabled: true, binaryPath: null });
  });

  it('saves to trackers.json and a tracker left out keeps the defaults', async () => {
    const { dir, store: s } = store();
    const saved = await s.set({ trackers: { 'gitlab-issues': { enabled: false, binaryPath: '/opt/glab' } } });
    assert.deepEqual(saved.trackers['github-issues'], { enabled: true, binaryPath: null });
    assert.deepEqual(saved.trackers['gitlab-issues'], { enabled: false, binaryPath: '/opt/glab' });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'trackers.json'), 'utf8')), saved);
    assert.deepEqual(new TrackersSettingsStore({ dataDir: dir }).get(), saved);
  });

  it('keeps the rest of a file written when Jira was a tracker', async () => {
    const { dir } = store();
    await writeFile(join(dir, 'trackers.json'), JSON.stringify({ trackers: { jira: { enabled: true, binaryPath: null }, 'gitlab-issues': { enabled: false, binaryPath: null } } }));
    const read = new TrackersSettingsStore({ dataDir: dir }).get();
    assert.deepEqual(Object.keys(read.trackers), ['github-issues', 'gitlab-issues', 'youtrack']);
    assert.equal(read.trackers['gitlab-issues'].enabled, false);
  });

  it('refuses what is not a settings document', async () => {
    const { store: s } = store();
    for (const input of [null, [], 'x', { trackers: [] }, { trackers: { nope: {} } }, { trackers: { jira: {} } }, { trackers: { youtrack: 'on' } }, { trackers: { youtrack: { enabled: 'yes' } } }, { trackers: { youtrack: { binaryPath: 'youtrack-app' } } }]) {
      await assert.rejects(s.set(input), Error, JSON.stringify(input));
    }
    assert.deepEqual(s.get(), defaultTrackersSettings());
  });

  it('reads a hand edit that went bad as the defaults', async () => {
    const { dir, store: first } = store();
    await first.set({});
    await writeFile(join(dir, 'trackers.json'), '{ nope');
    assert.deepEqual(new TrackersSettingsStore({ dataDir: dir }).get(), defaultTrackersSettings());
  });

  it('is on the Core, over its data directory', async () => {
    const config = tempConfig();
    const core = new Core(config);
    try {
      await core.trackersSettings.set({ trackers: { youtrack: { enabled: false } } });
      assert.equal(core.trackersSettings.get().trackers.youtrack.enabled, false);
      assert.equal(JSON.parse(await readFile(join(config.dataDir, 'trackers.json'), 'utf8')).trackers.youtrack.enabled, false);
    } finally {
      core.db.close();
    }
  });
});
