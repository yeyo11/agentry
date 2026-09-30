import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { installDirs, nvmBinDirs, probeLoginShellPath, resolveCommand, resolveUserPath } from '../src/providers/path.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentry-path-'));
});
after(() => rm(root, { recursive: true, force: true }));

async function fake(name: string, body: string, mode = 0o755): Promise<string> {
  const file = join(root, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, mode);
  return file;
}

describe('probeLoginShellPath', () => {
  it('reads the PATH between the sentinels and ignores banners', async () => {
    const shell = await fake('banner-shell', 'echo "welcome"; printf "__AGENTRY_PATH__/a:/b__AGENTRY_PATH__"; echo bye');
    assert.deepEqual(await probeLoginShellPath({ env: { SHELL: shell } }), { ok: true, path: '/a:/b' });
  });

  it('sets the fast-path marker for rc files', async () => {
    const shell = await fake(
      'marker-shell',
      'printf "__AGENTRY_PATH__%s__AGENTRY_PATH__" "$AGENTRY_SHELL_PATH_PROBE"',
    );
    assert.deepEqual(await probeLoginShellPath({ env: { SHELL: shell } }), { ok: true, path: '1' });
  });

  it('keeps the PATH of a shell that exits non-zero afterwards', async () => {
    const shell = await fake('failing-shell', 'printf "__AGENTRY_PATH__/x__AGENTRY_PATH__"; exit 3');
    assert.deepEqual(await probeLoginShellPath({ env: { SHELL: shell } }), { ok: true, path: '/x' });
  });

  it('fails with no-shell when SHELL is unset', async () => {
    assert.deepEqual(await probeLoginShellPath({ env: {} }), { ok: false, reason: 'no-shell' });
  });

  it('fails with timeout when the shell hangs', async () => {
    const shell = await fake('slow-shell', 'exec sleep 30');
    assert.deepEqual(await probeLoginShellPath({ env: { SHELL: shell }, timeoutMs: 200 }), { ok: false, reason: 'timeout' });
  });

  it('fails with spawn-error when the shell cannot run', async () => {
    const result = await probeLoginShellPath({ env: { SHELL: join(root, 'missing-shell') } });
    assert.deepEqual(result, { ok: false, reason: 'spawn-error' });
  });

  it('fails with empty-path when the shell prints no sentinels', async () => {
    const shell = await fake('silent-shell', 'echo nothing useful');
    assert.deepEqual(await probeLoginShellPath({ env: { SHELL: shell } }), { ok: false, reason: 'empty-path' });
  });
});

describe('resolveCommand', () => {
  it('finds an executable in PATH order and skips the ones that are not', async () => {
    const first = join(root, 'rc-first');
    const second = join(root, 'rc-second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(first, 'tool'), '#!/bin/sh\n');
    await chmod(join(first, 'tool'), 0o644);
    await writeFile(join(second, 'tool'), '#!/bin/sh\n');
    await chmod(join(second, 'tool'), 0o755);
    assert.equal(await resolveCommand('tool', [first, second].join(delimiter)), join(second, 'tool'));
  });

  it('ignores a directory with the command name and returns undefined when absent', async () => {
    const dir = join(root, 'rc-dir');
    await mkdir(join(dir, 'tool'), { recursive: true });
    assert.equal(await resolveCommand('tool', `${dir}${delimiter}${join(root, 'nowhere')}`), undefined);
  });

  it('checks a command with a slash as it is', async () => {
    const file = await fake('direct-tool', 'true');
    assert.equal(await resolveCommand(file, ''), file);
    assert.equal(await resolveCommand(join(root, 'no-such-tool'), ''), undefined);
  });
});

describe('nvmBinDirs', () => {
  async function nvm(name: string, versions: string[], aliases: Record<string, string>): Promise<string> {
    const dir = join(root, name);
    for (const v of versions) await mkdir(join(dir, 'versions', 'node', v, 'bin'), { recursive: true });
    for (const [alias, value] of Object.entries(aliases)) {
      const file = join(dir, 'alias', ...alias.split('/'));
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, `${value}\n`);
    }
    return dir;
  }
  const bin = (dir: string, v: string) => join(dir, 'versions', 'node', v, 'bin');

  it('puts the default alias first and the rest newest first, comparing numerically', async () => {
    const dir = await nvm('nvm-a', ['v18.20.0', 'v20.9.0', 'v20.11.1', 'v9.0.0'], { default: '18' });
    assert.deepEqual(await nvmBinDirs(dir), [
      bin(dir, 'v18.20.0'),
      bin(dir, 'v20.11.1'),
      bin(dir, 'v20.9.0'),
      bin(dir, 'v9.0.0'),
    ]);
  });

  it('follows an alias to another alias', async () => {
    const dir = await nvm('nvm-b', ['v18.20.0', 'v20.11.1'], { default: 'lts/*', 'lts/*': 'lts/hydrogen', 'lts/hydrogen': 'v18.20.0' });
    assert.equal((await nvmBinDirs(dir))[0], bin(dir, 'v18.20.0'));
  });

  it('treats `node` as the newest and orders by version when there is no default', async () => {
    const withNode = await nvm('nvm-c', ['v18.20.0', 'v20.11.1'], { default: 'node' });
    assert.equal((await nvmBinDirs(withNode))[0], bin(withNode, 'v20.11.1'));
    const none = await nvm('nvm-d', ['v16.0.0', 'v22.1.0'], {});
    assert.deepEqual(await nvmBinDirs(none), [bin(none, 'v22.1.0'), bin(none, 'v16.0.0')]);
  });

  it('is empty when nvm is not installed', async () => {
    assert.deepEqual(await nvmBinDirs(join(root, 'no-nvm')), []);
  });
});

describe('resolveUserPath', () => {
  it('orders login shell, current PATH and install directories, keeping existing ones once', async () => {
    const home = join(root, 'home');
    const fromShell = join(root, 'from-shell');
    const inherited = join(root, 'inherited');
    const localBin = join(home, '.local', 'bin');
    for (const dir of [fromShell, inherited, localBin]) await mkdir(dir, { recursive: true });
    const shell = await fake('path-shell', `printf "__AGENTRY_PATH__${fromShell}:${join(root, 'gone')}:${inherited}__AGENTRY_PATH__"`);
    const path = await resolveUserPath({ env: { SHELL: shell, PATH: inherited }, home });
    const dirs = path.split(delimiter);
    assert.deepEqual(dirs.slice(0, 3), [fromShell, inherited, localBin]);
    assert.equal(dirs.filter((d) => d === inherited).length, 1);
    assert.ok(!dirs.includes(join(root, 'gone')));
  });

  it('still returns the PATH and install directories when the shell fails', async () => {
    const home = join(root, 'home2');
    const npmGlobal = join(home, '.npm-global', 'bin');
    await mkdir(npmGlobal, { recursive: true });
    const path = await resolveUserPath({ env: { PATH: '' }, home });
    assert.ok(path.split(delimiter).includes(npmGlobal));
  });
});

describe('installDirs', () => {
  it('honours the variables that move volta-like homes and nvm', async () => {
    const home = join(root, 'home3');
    const dirs = await installDirs({ PNPM_HOME: '/p', ASDF_DATA_DIR: '/a', MISE_DATA_DIR: '/m', NVM_DIR: join(root, 'no-nvm') }, home);
    for (const expected of ['/p', join('/a', 'shims'), join('/m', 'shims'), join(home, '.volta', 'bin'), join(home, '.bun', 'bin')]) {
      assert.ok(dirs.includes(expected), expected);
    }
  });
});
