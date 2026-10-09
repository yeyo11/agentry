import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ghConfigDir, ghFallbackHost, hostsUser } from '../src/providers/gh-fallback.ts';

test('the user of a host in gh\'s hosts.yml is its active account, read at the host\'s own level only', () => {
  const text = 'github.com:\n    users:\n        user: notThisOne\n        monalisa:\n    user: "octocat"\n"acme.ghe.com":\n    user: hubot\nother.example:\n    git_protocol: ssh\n';
  assert.equal(hostsUser(text, 'github.com'), 'octocat');
  assert.equal(hostsUser(text, 'acme.ghe.com'), 'hubot');
  assert.equal(hostsUser(text, 'other.example'), null);
  assert.equal(hostsUser(text, 'missing.example'), null);
  assert.equal(hostsUser('github.com:\n    user:\n', 'github.com'), null);
});

test('gh\'s config directory follows GH_CONFIG_DIR, then XDG_CONFIG_HOME, then AppData on Windows', () => {
  assert.equal(ghConfigDir({ GH_CONFIG_DIR: '/c', XDG_CONFIG_HOME: '/x' }, '/h', 'linux'), '/c');
  assert.equal(ghConfigDir({ XDG_CONFIG_HOME: '/x' }, '/h', 'linux'), '/x/gh');
  assert.equal(ghConfigDir({ AppData: 'C:/A' }, '/h', 'linux'), '/h/.config/gh');
  assert.ok(ghConfigDir({ AppData: 'C:/A' }, '/h', 'win32').endsWith('GitHub CLI'));
});

test('the host gh is asked about is the first variable set, as a host name, or the default', () => {
  const fallback = { hostname: 'github.com', hostEnv: ['COPILOT_GH_HOST', 'GH_HOST'] };
  assert.equal(ghFallbackHost(fallback, {}), 'github.com');
  assert.equal(ghFallbackHost(fallback, { GH_HOST: 'Acme.GHE.com' }), 'acme.ghe.com');
  assert.equal(ghFallbackHost(fallback, { GH_HOST: 'a.ghe.com', COPILOT_GH_HOST: 'https://b.ghe.com/' }), 'b.ghe.com');
  assert.equal(ghFallbackHost(fallback, { GH_HOST: '-x' }), null);
});
