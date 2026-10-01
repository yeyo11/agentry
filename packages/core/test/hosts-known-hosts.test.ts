import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { glabConfigCandidates, glabKnownHosts, readGlabKnownHosts } from '../src/hosts/known-hosts.ts';

const root = mkdtempSync(join(tmpdir(), 'known-hosts-'));
after(() => rmSync(root, { recursive: true, force: true }));

// A token-looking value that must never come out of the reader, in any form.
const SENTINEL = 'glpat-SENTINEL0000000000';

const CONFIG = `# glab config
git_protocol: ssh
editor:
hosts:
    gitlab.com:
        token: ${SENTINEL}
        api_host: gitlab.com
        git_protocol: ssh
        user: yeyo11
        job_token: ${SENTINEL}-job
    "GitLab.Example.com":
        token: !!null ${SENTINEL}-2
        user: "someone"
    bare.example.org:
        token: ${SENTINEL}-3
telemetry: false
other:
    not-a-host:
        user: ignored
`;

test('glab’s host names and users are read, and no token ever comes out', async () => {
  const file = join(root, 'config.yml');
  writeFileSync(file, CONFIG);
  const hosts = await readGlabKnownHosts(file);
  assert.deepEqual(hosts, [
    { hostname: 'gitlab.com', user: 'yeyo11' },
    { hostname: 'gitlab.example.com', user: 'someone' },
    { hostname: 'bare.example.org', user: null },
  ]);
  assert.ok(!JSON.stringify(hosts).includes('SENTINEL'), 'a token reached the returned objects');
  assert.ok(!JSON.stringify(hosts).includes('glpat'), 'a token pattern reached the returned objects');
});

test('a missing, empty or hostless file is an empty list, and nothing is thrown', async () => {
  assert.deepEqual(await readGlabKnownHosts(join(root, 'nope.yml')), []);
  const empty = join(root, 'empty.yml');
  writeFileSync(empty, '');
  assert.deepEqual(await readGlabKnownHosts(empty), []);
  const none = join(root, 'none.yml');
  writeFileSync(none, 'git_protocol: https\n');
  assert.deepEqual(await readGlabKnownHosts(none), []);
});

test('the config file is looked for in the plan’s order, and the first that exists wins', async () => {
  const home = join(root, 'home');
  const explicit = join(root, 'explicit');
  const xdg = join(root, 'xdg');
  for (const dir of [join(home, '.config', 'glab-cli'), explicit, join(xdg, 'glab-cli')]) mkdirSync(dir, { recursive: true });
  const env = { GLAB_CONFIG_DIR: explicit, XDG_CONFIG_HOME: xdg };
  assert.deepEqual(glabConfigCandidates({ env, home }), [
    join(explicit, 'config.yml'),
    join(home, '.config', 'glab-cli', 'config.yml'),
    join(xdg, 'glab-cli', 'config.yml'),
  ]);

  writeFileSync(join(xdg, 'glab-cli', 'config.yml'), 'hosts:\n  from-xdg.example.com:\n    user: x\n');
  assert.deepEqual((await glabKnownHosts({ env, home })).map((h) => h.hostname), ['from-xdg.example.com']);
  writeFileSync(join(home, '.config', 'glab-cli', 'config.yml'), 'hosts:\n  from-home.example.com:\n    user: y\n');
  assert.deepEqual((await glabKnownHosts({ env, home })).map((h) => h.hostname), ['from-home.example.com']);
  writeFileSync(join(explicit, 'config.yml'), 'hosts:\n  from-env.example.com:\n    user: z\n');
  assert.deepEqual((await glabKnownHosts({ env, home })).map((h) => h.hostname), ['from-env.example.com']);
  assert.deepEqual(await glabKnownHosts({ env: {}, home: join(root, 'no-home') }), []);
});
