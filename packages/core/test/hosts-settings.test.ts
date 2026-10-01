import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CodeHostsSettingsStore, defaultCodeHostsSettings } from '../src/hosts/settings.ts';

let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentry-hosts-settings-'));
});
after(() => rm(root, { recursive: true, force: true }));

const store = (): { dir: string; store: CodeHostsSettingsStore } => {
  n += 1;
  const dir = join(root, `data${n}`);
  return { dir, store: new CodeHostsSettingsStore({ dataDir: dir }) };
};

describe('CodeHostsSettingsStore', () => {
  it('reads every host on, searching for its binary, until the first save', () => {
    assert.deepEqual(store().store.get(), defaultCodeHostsSettings());
    assert.deepEqual(defaultCodeHostsSettings().hosts, {
      github: { enabled: true, binaryPath: null },
      gitlab: { enabled: true, binaryPath: null },
    });
  });

  it('saves to hosts.json and a host left out keeps the defaults', async () => {
    const { dir, store: s } = store();
    const saved = await s.set({ hosts: { gitlab: { enabled: false, binaryPath: '/opt/glab' } } });
    assert.deepEqual(saved.hosts.github, { enabled: true, binaryPath: null });
    assert.deepEqual(saved.hosts.gitlab, { enabled: false, binaryPath: '/opt/glab' });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'hosts.json'), 'utf8')), saved);
    assert.deepEqual(new CodeHostsSettingsStore({ dataDir: dir }).get(), saved);
  });

  it('refuses what is not a settings document', async () => {
    const { store: s } = store();
    await assert.rejects(s.set(null), /must be an object/);
    await assert.rejects(s.set({ hosts: [] }), /hosts must be an object/);
    await assert.rejects(s.set({ hosts: { bitbucket: {} } }), /one of github, gitlab/);
    await assert.rejects(s.set({ hosts: { github: { enabled: 'yes' } } }), /enabled must be a boolean/);
    await assert.rejects(s.set({ hosts: { github: { binaryPath: 'gh' } } }), /absolute path/);
    assert.deepEqual(s.get(), defaultCodeHostsSettings());
  });

  it('reads a hand edit that went bad as the defaults', async () => {
    const { dir, store: first } = store();
    await first.set({});
    await writeFile(join(dir, 'hosts.json'), '{ not json');
    assert.deepEqual(new CodeHostsSettingsStore({ dataDir: dir }).get(), defaultCodeHostsSettings());
  });

  it('serves a copy, so a caller cannot change what is kept', () => {
    const { store: s } = store();
    s.get().hosts.github.enabled = false;
    assert.equal(s.get().hosts.github.enabled, true);
  });
});
