import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRemote, resolveSshHost } from '../src/hosts/remote.ts';

const SECRET = 'S3NTINEL-t0ken';

const r = (hostname: string, path: string, protocol: 'https' | 'ssh' | 'git', port: number | null = null) => ({ hostname, path, protocol, port });

const table: Array<[string, ReturnType<typeof r> | null]> = [
  ['https://github.com/acme/app.git', r('github.com', 'acme/app', 'https')],
  ['https://github.com/acme/app', r('github.com', 'acme/app', 'https')],
  ['https://github.com/acme/app/', r('github.com', 'acme/app', 'https')],
  ['HTTPS://GitHub.COM/acme/app.git', r('github.com', 'acme/app', 'https')],
  ['https://gitlab.com/group/sub/deep/app.git', r('gitlab.com', 'group/sub/deep/app', 'https')],
  ['https://oauth2:' + SECRET + '@gitlab.com/g/a.git', r('gitlab.com', 'g/a', 'https')],
  ['https://x-access-token:' + SECRET + '@github.com/o/n', r('github.com', 'o/n', 'https')],
  ['https://user:p@ss@git.corp.example/o/n.git', r('git.corp.example', 'o/n', 'https')],
  ['https://' + SECRET + '@github.com/o/n', r('github.com', 'o/n', 'https')],
  ['https://git.corp.example:8443/o/n.git', r('git.corp.example', 'o/n', 'https', 8443)],
  ['https://git.corp.example:443/o/n.git', r('git.corp.example', 'o/n', 'https')],
  ['https://[2001:db8::1]/o/n.git', r('2001:db8::1', 'o/n', 'https')],
  ['https://[2001:db8::1]:8443/o/n.git', r('2001:db8::1', 'o/n', 'https', 8443)],
  ['https://github.com/acme/my%20app.git', r('github.com', 'acme/my app', 'https')],
  ['ssh://git@github.com/acme/app.git', r('github.com', 'acme/app', 'ssh')],
  ['ssh://github.com/acme/app.git', r('github.com', 'acme/app', 'ssh')],
  ['ssh://git@git.corp.example:2222/o/n.git', r('git.corp.example', 'o/n', 'ssh')],
  ['ssh://git:' + SECRET + '@git.corp.example/o/n.git', r('git.corp.example', 'o/n', 'ssh')],
  ['ssh://git@[2001:db8::1]:2222/o/n.git', r('2001:db8::1', 'o/n', 'ssh')],
  ['ssh://git@ssh.github.com:443/acme/app.git', r('github.com', 'acme/app', 'ssh')],
  ['git@github.com:acme/app.git', r('github.com', 'acme/app', 'ssh')],
  ['github.com:acme/app.git', r('github.com', 'acme/app', 'ssh')],
  ['git@gitlab.com:group/sub/app.git', r('gitlab.com', 'group/sub/app', 'ssh')],
  ['git@altssh.gitlab.com:group/app.git', r('gitlab.com', 'group/app', 'ssh')],
  ['git@ssh.github.com:acme/app.git', r('github.com', 'acme/app', 'ssh')],
  ['git@work:acme/app.git', r('work', 'acme/app', 'ssh')],
  ['work:acme/app', r('work', 'acme/app', 'ssh')],
  ['git@work:/srv/git/app.git', r('work', 'srv/git/app', 'ssh')],
  ['git@[2001:db8::1]:acme/app.git', r('2001:db8::1', 'acme/app', 'ssh')],
  ['git:' + SECRET + '@git.corp.example:o/n.git', r('git.corp.example', 'o/n', 'ssh')],
  ['git@host:acme/app@v2.git', r('host', 'acme/app@v2', 'ssh')],
  ['git://github.com/acme/app.git', r('github.com', 'acme/app', 'git')],
  ['git://git.corp.example:9418/o/n', r('git.corp.example', 'o/n', 'git')],
  // no host
  ['/home/me/repos/app.git', null],
  ['./app', null],
  ['../a:b/app', null],
  ['file:///home/me/repos/app.git', null],
  ['file://localhost/home/me/app', null],
  ['C:\\repos\\app', null],
  ['C:/repos/app', null],
  ['', null],
  ['   ', null],
  // no path, or a scheme no host takes a push on
  ['https://github.com', null],
  ['https://github.com/', null],
  ['git@github.com:', null],
  ['http://github.com/acme/app.git', null],
  ['ftp://github.com/acme/app.git', null],
  ['https://', null],
];

for (const [url, expected] of table) {
  test(`parseRemote(${JSON.stringify(url.replace(SECRET, '***'))})`, () => {
    assert.deepEqual(parseRemote(url), expected);
  });
}

test('a secret never survives into any output', () => {
  for (const [url] of table) {
    if (!url.includes(SECRET)) continue;
    const out = parseRemote(url);
    assert.ok(out, url);
    assert.ok(!JSON.stringify(out).includes(SECRET), url);
    assert.ok(!JSON.stringify(out).includes('@'), url);
  }
});

test('the parsed object carries no user field', () => {
  const out = parseRemote('https://me:' + SECRET + '@github.com/o/n.git');
  assert.deepEqual(Object.keys(out ?? {}).sort(), ['hostname', 'path', 'port', 'protocol']);
});

test('resolveSshHost takes the hostname line and applies the fold', async () => {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    return 'user git\nhostname git.corp.example\nport 22\n';
  };
  assert.equal(await resolveSshHost('work', exec), 'git.corp.example');
  assert.deepEqual(calls, [['-G', '--', 'work']]);
  assert.equal(await resolveSshHost('gh', async () => 'hostname ssh.github.com\n'), 'github.com');
  assert.equal(await resolveSshHost('gl', async () => 'hostname altssh.gitlab.com\r\n'), 'gitlab.com');
  assert.equal(await resolveSshHost('v6', async () => 'hostname 2001:db8::1\n'), '2001:db8::1');
});

test('an alias without an ssh answer is kept', async () => {
  assert.equal(await resolveSshHost('Work', async () => { throw new Error('spawn ssh ENOENT'); }), 'work');
  assert.equal(await resolveSshHost('work', async () => 'user git\nport 22\n'), 'work');
  assert.equal(await resolveSshHost('work', async () => ''), 'work');
});

test('an alias that is already the host resolves to itself', async () => {
  assert.equal(await resolveSshHost('github.com', async () => 'hostname github.com\n'), 'github.com');
  assert.equal(await resolveSshHost('ssh.github.com', async () => { throw new Error('no ssh'); }), 'github.com');
});

test('ssh -G is never run for something that looks like an option', async () => {
  let ran = false;
  const exec = async () => {
    ran = true;
    return 'hostname evil.example\n';
  };
  assert.equal(await resolveSshHost('-oProxyCommand=x', exec), '-oproxycommand=x');
  assert.equal(await resolveSshHost('a b', exec), 'a b');
  assert.equal(ran, false);
});

test('a hung ssh -G gives up after its timeout and keeps the alias', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = resolveSshHost('slow', () => new Promise<string>(() => {}));
  t.mock.timers.tick(5_000);
  assert.equal(await pending, 'slow');
});
