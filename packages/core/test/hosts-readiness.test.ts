import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CodeHostsSettings, PullRequestReadiness } from '@agentry/shared';
import { defaultCodeHostsSettings } from '../src/hosts/settings.ts';
import { projectReadiness, REMOTES_DOCS_URL, type ReadinessDeps } from '../src/hosts/readiness.ts';
import { adapterOf, answer, ghHosts, scripted, type Script } from './hosts/stub-adapters.ts';

let root: string;
let bin: string;
let n = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentry-readiness-'));
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

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

/** A repository with `origin` at `url`, and `origin/main` as its default branch when `head` is set. */
async function repo(url: string | null, head = true): Promise<string> {
  const dir = join(root, `repo${n}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
  if (url) sh(dir, 'remote', 'add', 'origin', url);
  if (url && head) {
    sh(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    sh(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  }
  return dir;
}

function deps(script: Script = {}, extra: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    adapter: adapterOf,
    run: scripted(script),
    resolvePath: async () => bin,
    glabHosts: async () => [],
    sshExec: async () => '',
    env: { PATH: bin },
    home: root,
    ...extra,
  };
}

const signedIn = ghHosts({ 'github.com': 'octo' });
const settingsOf = (patch: Partial<CodeHostsSettings['hosts']>): (() => CodeHostsSettings) => () => {
  const base = defaultCodeHostsSettings();
  return { hosts: { ...base.hosts, ...patch } };
};

function check(readiness: PullRequestReadiness, status: PullRequestReadiness['status'], host: PullRequestReadiness['host'] = null): void {
  assert.equal(readiness.status, status, JSON.stringify(readiness));
  assert.equal(readiness.host, host);
}

describe('projectReadiness: git', () => {
  it('says not-git for a missing path and a plain directory, with nothing to do', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    for (const path of [join(root, 'absent'), plain]) {
      const readiness = await projectReadiness(path, deps());
      check(readiness, 'not-git');
      assert.equal(readiness.remedy, null);
      assert.equal(readiness.hostname, null);
    }
  });

  it('says no-remote and links git remotes', async () => {
    const readiness = await projectReadiness(await repo(null), deps());
    check(readiness, 'no-remote');
    assert.deepEqual(readiness.remedy, { kind: 'docs', url: REMOTES_DOCS_URL });
  });
});

describe('projectReadiness: which host', () => {
  it('reads a local path, a file URL, a ported host and an unknown host as unsupported-host, calling no CLI', async () => {
    await fake('gh');
    const calls: NonNullable<Script['calls']> = [];
    for (const url of [join(root, 'bare.git'), 'file:///srv/x.git', 'https://github.com:8443/o/r.git', 'https://git.example.org/o/r.git']) {
      const readiness = await projectReadiness(await repo(url), deps({ ghAuth: signedIn, calls }));
      check(readiness, 'unsupported-host');
      assert.deepEqual(readiness.remedy, { kind: 'settings', url: null });
    }
    // Only the lookup of the unknown host asked gh which hosts it knows; nothing else ran
    assert.deepEqual(calls.map((call) => call.args[0]), ['auth']);
  });

  it('keeps the hostname but never the user or the secret of the URL', async () => {
    await fake('gh');
    const readiness = await projectReadiness(await repo('https://octo:s3cr3t-token@git.example.org/o/r.git'), deps());
    assert.equal(readiness.hostname, 'git.example.org');
    assert.ok(!JSON.stringify(readiness).includes('s3cr3t-token'));
    assert.ok(!JSON.stringify(readiness).includes('octo:'));
  });

  it('resolves an SSH alias through ssh -G and folds ssh.github.com', async () => {
    await fake('gh');
    const asked: string[][] = [];
    const sshExec = async (args: string[]): Promise<string> => {
      asked.push(args);
      return 'user git\nhostname ssh.github.com\nport 443\n';
    };
    const readiness = await projectReadiness(await repo('git@work:o/r.git'), deps({ ghAuth: signedIn }, { sshExec }));
    assert.deepEqual(asked, [['-G', '--', 'work']]);
    check(readiness, 'ready', 'github');
    assert.equal(readiness.hostname, 'github.com');
  });

  it('sends a host a CLI lists to that CLI, and a host both list to github', async () => {
    await fake('gh');
    await fake('glab');
    const url = 'https://code.example.org/o/r.git';
    const onlyGlab = await projectReadiness(await repo(url), deps({ ghAuth: signedIn, glabSignedIn: ['code.example.org'] }, { glabHosts: async () => [{ hostname: 'code.example.org', user: 'me' }] }));
    check(onlyGlab, 'ready', 'gitlab');

    const onlyGh = await projectReadiness(await repo(url), deps({ ghAuth: ghHosts({ 'code.example.org': 'octo' }) }));
    check(onlyGh, 'ready', 'github');

    const both = await projectReadiness(
      await repo(url),
      deps({ ghAuth: ghHosts({ 'code.example.org': 'octo' }), glabSignedIn: ['code.example.org'] }, { glabHosts: async () => [{ hostname: 'code.example.org', user: 'me' }] }),
    );
    check(both, 'ready', 'github');
  });

  it('reads a turned-off host as unsupported-host and says so', async () => {
    await fake('gh');
    const readiness = await projectReadiness(
      await repo('https://github.com/o/r.git'),
      deps({ ghAuth: signedIn }, { settings: settingsOf({ github: { enabled: false, binaryPath: null } }) }),
    );
    check(readiness, 'unsupported-host');
    assert.match(readiness.detail ?? '', /turned off/);
  });
});

describe('projectReadiness: the CLI', () => {
  it('says cli-missing with the install page when the binary is not found', async () => {
    const readiness = await projectReadiness(await repo('https://github.com/o/r.git'), deps());
    check(readiness, 'cli-missing', 'github');
    assert.deepEqual(readiness.remedy, { kind: 'install', url: 'https://cli.github.com' });
    assert.equal(readiness.hostname, 'github.com');
  });

  it('uses the binary the person chose, and reads a missing one as cli-missing', async () => {
    const own = await fake('my-gh');
    const url = 'https://github.com/o/r.git';
    const used: string[] = [];
    const run = scripted({ ghAuth: signedIn });
    const spy: ReadinessDeps['run'] = (call, where) => {
      used.push(where.binaryPath);
      return run(call, where);
    };
    check(await projectReadiness(await repo(url), deps({}, { run: spy, settings: settingsOf({ github: { enabled: true, binaryPath: own } }) })), 'ready', 'github');
    assert.ok(used.length > 0 && used.every((path) => path === own));
    check(await projectReadiness(await repo(url), deps({}, { settings: settingsOf({ github: { enabled: true, binaryPath: join(bin, 'nope') } }) })), 'cli-missing', 'github');
  });

  it('says cli-missing when --version fails', async () => {
    await fake('gh');
    const run: ReadinessDeps['run'] = async () => answer('', 127, { stderrFirstLine: 'gh: exec format error' });
    const readiness = await projectReadiness(await repo('https://github.com/o/r.git'), deps({}, { run }));
    check(readiness, 'cli-missing', 'github');
    assert.equal(readiness.detail, 'gh: exec format error');
  });

  it('says cli-incompatible below the minimum, and accepts the minimum itself', async () => {
    await fake('gh');
    const url = 'https://github.com/o/r.git';
    const old = await projectReadiness(await repo(url), deps({ ghVersion: '2.45.0', ghAuth: signedIn }));
    check(old, 'cli-incompatible', 'github');
    assert.deepEqual(old.remedy, { kind: 'install', url: 'https://cli.github.com' });
    assert.match(old.detail ?? '', /2\.45\.0/);
    check(await projectReadiness(await repo(url), deps({ ghVersion: '2.92.0', ghAuth: signedIn })), 'ready', 'github');
  });

  it('says cli-signed-out with the host in the detail and the sign-in docs', async () => {
    await fake('gh');
    const readiness = await projectReadiness(await repo('https://github.com/o/r.git'), deps({ ghAuth: ghHosts({}) }));
    check(readiness, 'cli-signed-out', 'github');
    assert.equal(readiness.detail, 'github.com');
    assert.deepEqual(readiness.remedy, { kind: 'sign-in', url: 'https://cli.github.com/manual/gh_auth_login' });
  });

  it('asks glab about the one host of the remote', async () => {
    await fake('glab');
    const calls: NonNullable<Script['calls']> = [];
    const readiness = await projectReadiness(await repo('git@gitlab.com:group/sub/proj.git'), deps({ glabSignedIn: ['gitlab.com'], calls }));
    check(readiness, 'ready', 'gitlab');
    const auth = calls.find((call) => call.args[0] === 'auth');
    assert.deepEqual(auth?.args, ['auth', 'status', '--hostname', 'gitlab.com']);
  });
});

describe('projectReadiness: the default branch', () => {
  it('reads origin/HEAD locally and does not ask the CLI', async () => {
    await fake('gh');
    const calls: NonNullable<Script['calls']> = [];
    const readiness = await projectReadiness(await repo('https://github.com/o/r.git'), deps({ ghAuth: signedIn, calls }));
    check(readiness, 'ready', 'github');
    assert.equal(readiness.defaultBranch, 'main');
    assert.equal(readiness.detail, null);
    assert.equal(readiness.remedy, null);
    assert.ok(!calls.some((call) => call.args[0] === 'default-branch'));
  });

  it('asks the CLI, with owner and name split from the path, when origin/HEAD is not set', async () => {
    await fake('glab');
    const calls: NonNullable<Script['calls']> = [];
    const readiness = await projectReadiness(
      await repo('https://gitlab.com/group/sub/proj.git', false),
      deps({ glabSignedIn: ['gitlab.com'], defaultBranch: answer('trunk\n'), calls }),
    );
    check(readiness, 'ready', 'gitlab');
    assert.equal(readiness.defaultBranch, 'trunk');
    assert.deepEqual(calls.find((call) => call.args[0] === 'default-branch')?.args, ['default-branch', 'gitlab.com', 'group/sub/proj']);
  });

  it('says no-default-branch with the CLI docs when neither names it', async () => {
    await fake('gh');
    const failed = await projectReadiness(
      await repo('https://github.com/o/r.git', false),
      deps({ ghAuth: signedIn, defaultBranch: answer('', 1, { stderrFirstLine: 'Could not resolve to a Repository' }) }),
    );
    check(failed, 'no-default-branch', 'github');
    assert.equal(failed.detail, 'Could not resolve to a Repository');
    assert.deepEqual(failed.remedy, { kind: 'docs', url: 'https://cli.github.com/manual' });

    const empty = await projectReadiness(await repo('https://github.com/o/r.git', false), deps({ ghAuth: signedIn, defaultBranch: answer('\n') }));
    check(empty, 'no-default-branch', 'github');
  });
});

describe('projectReadiness: a real binary on a temporary PATH', () => {
  it('runs the CLI through the execution layer', async () => {
    await fake(
      'gh',
      `case "$1" in
  --version) echo "gh version 2.92.0 (2026-04-28)" ;;
  auth) echo '${signedIn}' ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac`,
    );
    const { run: _unused, ...rest } = deps();
    const readiness = await projectReadiness(await repo('https://github.com/o/r.git'), rest);
    check(readiness, 'ready', 'github');
    assert.equal(readiness.defaultBranch, 'main');
  });
});
