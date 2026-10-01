import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CodeHostsSettings } from '@agentry/shared';
import type { AgentryEventInput } from '../src/events.ts';
import { CodeHostDetector, hostnamesOfAuthJson, type CodeHostDetectorDeps } from '../src/hosts/detector.ts';
import { defaultCodeHostsSettings } from '../src/hosts/settings.ts';
import { adapterOf, answer, ghHosts, scripted, type Script } from './hosts/stub-adapters.ts';

let root: string;
let bin: string;
let n = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentry-hosts-detector-'));
});
after(() => rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  n += 1;
  bin = join(root, `bin${n}`);
  await mkdir(bin);
});

async function fake(name: string, body = 'exit 0'): Promise<string> {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

function detector(script: Script, extra: Partial<CodeHostDetectorDeps> = {}) {
  const events: AgentryEventInput[] = [];
  const instance = new CodeHostDetector({
    adapter: adapterOf,
    run: scripted(script),
    resolvePath: async () => bin,
    glabHosts: async () => [],
    env: { PATH: bin },
    home: join(root, 'home'),
    emit: (event) => events.push(event),
    debounceMs: 50,
    minWatchGapMs: 0,
    ...extra,
  });
  return { instance, events };
}

const off = (id: 'github' | 'gitlab'): (() => CodeHostsSettings) => () => {
  const base = defaultCodeHostsSettings();
  return { hosts: { ...base.hosts, [id]: { enabled: false, binaryPath: null } } };
};

describe('hostnamesOfAuthJson', () => {
  it('lists the keys of hosts, lower case, and refuses another shape', () => {
    assert.deepEqual(hostnamesOfAuthJson(ghHosts({ 'GitHub.com': 'a', 'ghe.example.org': null })), ['github.com', 'ghe.example.org']);
    assert.deepEqual(hostnamesOfAuthJson('{"hosts":{}}'), []);
    for (const bad of ['', 'nope', '[]', '{}', '{"hosts":[]}', '{"hosts":null}']) assert.equal(hostnamesOfAuthJson(bad), null, bad);
  });
});

describe('CodeHostDetector', () => {
  it('reads gh as ready with its hosts and who is signed in, and glab as not installed', async () => {
    await fake('gh');
    const { instance } = detector({ ghAuth: ghHosts({ 'github.com': 'octo', 'ghe.example.org': null }) });
    const [github, gitlab] = await instance.statuses();
    assert.equal(github?.id, 'github');
    assert.equal(github?.state, 'ready');
    assert.equal(github?.reason, null);
    assert.equal(github?.version, '2.92.0');
    assert.equal(github?.binaryPath, join(bin, 'gh'));
    assert.equal(github?.minimum, '2.92.0');
    assert.deepEqual(github?.recorded, ['2.92.0', '2.102.0']);
    assert.deepEqual(github?.hosts, [
      { hostname: 'github.com', default: true, signedIn: true, user: 'octo' },
      { hostname: 'ghe.example.org', default: false, signedIn: false, user: null },
    ]);
    assert.equal(gitlab?.state, 'not-installed');
    assert.equal(gitlab?.binaryPath, null);
  });

  it('says signed-out with no-hosts when gh lists none, and shows the default host anyway', async () => {
    await fake('gh');
    const { instance } = detector({ ghAuth: ghHosts({}) });
    const github = await instance.status('github');
    assert.equal(github?.state, 'signed-out');
    assert.equal(github?.reason, 'no-hosts');
    assert.deepEqual(github?.hosts, [{ hostname: 'github.com', default: true, signedIn: false, user: null }]);
  });

  it('says signed-out without a reason when a host is listed and nobody is signed in', async () => {
    await fake('gh');
    const { instance } = detector({ ghAuth: ghHosts({ 'github.com': null }) });
    const github = await instance.status('github');
    assert.equal(github?.state, 'signed-out');
    assert.equal(github?.reason, null);
  });

  it('says incompatible below the minimum', async () => {
    await fake('gh');
    const { instance } = detector({ ghVersion: '2.45.0' });
    const github = await instance.status('github');
    assert.equal(github?.state, 'incompatible');
    assert.equal(github?.reason, 'below-minimum');
    assert.equal(github?.version, '2.45.0');
  });

  it('reads a release above the minimum that was not recorded as ready for gh and degraded for glab', async () => {
    await fake('gh');
    await fake('glab');
    const { instance } = detector(
      { ghVersion: '2.110.0', ghAuth: ghHosts({ 'github.com': 'octo' }), glabVersion: '1.130.0', glabSignedIn: ['gitlab.com'] },
      { glabHosts: async () => [{ hostname: 'gitlab.com', user: 'me' }] },
    );
    const [github, gitlab] = await instance.statuses();
    assert.equal(github?.state, 'ready');
    assert.equal(gitlab?.state, 'degraded');
    assert.equal(gitlab?.reason, 'version-untested');
    assert.deepEqual(gitlab?.hosts, [{ hostname: 'gitlab.com', default: true, signedIn: true, user: 'me' }]);
  });

  it('asks glab only about the hosts its configuration lists', async () => {
    await fake('glab');
    const calls: NonNullable<Script['calls']> = [];
    const { instance } = detector(
      { glabSignedIn: ['code.example.org'], calls },
      { glabHosts: async () => [{ hostname: 'code.example.org', user: 'me' }, { hostname: 'old.example.org', user: null }] },
    );
    const gitlab = await instance.status('gitlab');
    assert.deepEqual(calls.filter((call) => call.args[0] === 'auth').map((call) => call.args[3]), ['code.example.org', 'old.example.org']);
    assert.equal(gitlab?.state, 'ready');
    assert.deepEqual(gitlab?.hosts.map((host) => [host.hostname, host.signedIn]), [
      ['gitlab.com', false],
      ['code.example.org', true],
      ['old.example.org', false],
    ]);
  });

  it('reads a probe that failed or timed out as unknown with the reason', async () => {
    await fake('gh');
    await fake('glab');
    const run: CodeHostDetectorDeps['run'] = async (call) =>
      call.cli === 'gh' ? answer('', null, { reason: 'timeout' }) : answer('garbled');
    const { instance } = detector({}, { run });
    const [github, gitlab] = await instance.statuses();
    assert.deepEqual([github?.state, github?.reason], ['unknown', 'timeout']);
    assert.deepEqual([gitlab?.state, gitlab?.reason], ['unknown', 'probe-failed']);
  });

  it('reads a host that is turned off as unknown, and never runs it', async () => {
    await fake('gh');
    const calls: NonNullable<Script['calls']> = [];
    const { instance } = detector({ calls }, { settings: off('github') });
    const github = await instance.status('github');
    assert.deepEqual([github?.state, github?.reason, github?.binaryPath], ['unknown', null, null]);
    assert.ok(!calls.some((call) => call.cli === 'gh'));
  });

  it('uses the binary the person chose', async () => {
    const own = await fake('my-gh');
    const { instance } = detector(
      { ghAuth: ghHosts({ 'github.com': 'octo' }) },
      { settings: () => ({ ...defaultCodeHostsSettings(), hosts: { ...defaultCodeHostsSettings().hosts, github: { enabled: true, binaryPath: own } } }) },
    );
    assert.equal((await instance.status('github'))?.binaryPath, own);
  });

  it('serves the cache, and emits hosts.changed only when a status really changed', async () => {
    await fake('gh');
    const script: Script = { ghAuth: ghHosts({}) };
    const { instance, events } = detector(script);
    await instance.statuses();
    await instance.refresh();
    assert.equal(events.length, 0, 'the first reading and an identical one are not changes');

    script.ghAuth = ghHosts({ 'github.com': 'octo' });
    await instance.refresh();
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event?.type, 'hosts.changed');
    if (event?.type === 'hosts.changed') assert.equal(event.hosts.find((s) => s.id === 'github')?.state, 'ready');

    await instance.refresh();
    assert.equal(events.length, 1);
  });

  it('shares one detection between callers that ask at the same time', async () => {
    await fake('gh');
    const calls: NonNullable<Script['calls']> = [];
    const { instance } = detector({ ghAuth: ghHosts({}), calls });
    await Promise.all([instance.statuses(), instance.statuses(), instance.refresh()]);
    assert.equal(calls.filter((call) => call.args[0] === '--version').length, 1);
  });

  it('re-detects when a CLI appears on the PATH and nobody pressed refresh', async () => {
    const { instance, events } = detector({ ghAuth: ghHosts({ 'github.com': 'octo' }) });
    try {
      await instance.startWatching();
      assert.equal((await instance.status('github'))?.state, 'not-installed');
      await fake('gh');
      for (let i = 0; i < 100 && events.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(events.length, 1);
      assert.equal(instance.known()?.find((s) => s.id === 'github')?.state, 'ready');
    } finally {
      instance.close();
    }
  });
});
