import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccountManager } from '../src/accounts.ts';
import { CSWAP_VERSION, cswapCompatible, uvAsset, type UvAsset } from '../src/cswap-pin.ts';
import { Db } from '../src/db.ts';
import { loadConfig } from '../src/paths.ts';

const EMPTY_LIST = JSON.stringify({ schemaVersion: 1, activeAccountNumber: null, accounts: [] });

/** A `cswap` that reports `version` and lists no accounts. */
function cswapScript(version: string): string {
  return `#!/bin/sh
case "$1" in
  --version) echo "cswap ${version}" ;;
  list) echo '${EMPTY_LIST}' ;;
  *) exit 2 ;;
esac
`;
}

function binDir(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-path-'));
  writeFileSync(join(dir, 'cswap'), cswapScript(version));
  chmodSync(join(dir, 'cswap'), 0o755);
  return dir;
}

/**
 * A uv release archive whose `uv` installs a fake claude-swap into `$UV_TOOL_BIN_DIR`, reporting the
 * version it was asked for; `FAKE_UV_FAIL` makes it fail the way a network error would.
 */
function fakeUvArchive(): { archive: Buffer; asset: UvAsset; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentry-uv-'));
  const dir = 'uv-test-target';
  const log = join(root, 'calls.log');
  mkdirSync(join(root, dir));
  writeFileSync(
    join(root, dir, 'uv'),
    `#!/bin/sh
echo "$* | $UV_TOOL_DIR | $UV_PYTHON_INSTALL_DIR | $UV_CACHE_DIR | $UV_NO_CONFIG" >> "${log}"
if [ -n "$FAKE_UV_FAIL" ]; then echo "error: Failed to fetch: https://pypi.org/simple/claude-swap/" >&2; exit 2; fi
version="\${4#claude-swap==}"
mkdir -p "$UV_TOOL_BIN_DIR"
cat > "$UV_TOOL_BIN_DIR/cswap" <<EOS
#!/bin/sh
case "\\$1" in
  --version) echo "cswap $version" ;;
  list) echo '${EMPTY_LIST}' ;;
esac
EOS
chmod +x "$UV_TOOL_BIN_DIR/cswap"
`,
  );
  chmodSync(join(root, dir, 'uv'), 0o755);
  execFileSync('tar', ['-czf', join(root, 'uv.tar.gz'), '-C', root, dir]);
  const archive = readFileSync(join(root, 'uv.tar.gz'));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  return { archive, asset: { url: 'https://example.invalid/uv.tar.gz', sha256, dir }, log };
}

function setup(opts: { path?: string; env?: Record<string, string>; asset?: UvAsset | null; archive?: Buffer } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentry-cswap-mgr-'));
  const config = loadConfig({
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
    AGENTRY_DATA_DIR: join(root, 'data'),
    ...opts.env,
  });
  const fetches: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetches.push(url);
    return new Response(opts.archive ?? Buffer.from('not an archive'));
  }) as unknown as typeof fetch;
  const env = { ...process.env, PATH: [opts.path, '/usr/bin', '/bin'].filter(Boolean).join(':'), FAKE_UV_FAIL: '' };
  const manager = new AccountManager(config, new Db(config), {
    env,
    installer: { fetch: fakeFetch, asset: opts.asset === undefined ? null : opts.asset },
  });
  return { manager, config, fetches, env };
}

/** Runs `start` and waits for the install it begins to end, success or failure, and be detected. */
async function installed(manager: AccountManager, start: () => Promise<unknown> = () => manager.installCswap()): Promise<void> {
  const done = once(manager, 'cswap');
  await start();
  await done;
}

test('the pin knows which versions it parses, and which platforms have a uv build', () => {
  assert.equal(cswapCompatible(CSWAP_VERSION), true);
  assert.equal(cswapCompatible('0.26.3'), true);
  assert.equal(cswapCompatible('0.25.9'), false);
  assert.equal(cswapCompatible('0.27.0'), false);
  assert.equal(cswapCompatible(null), false);
  assert.match(uvAsset('linux', 'x64')?.url ?? '', /uv-x86_64-unknown-linux-gnu\.tar\.gz$/);
  assert.equal(uvAsset('win32', 'x64'), null);
});

test('nothing installed: not installed, and the managed install is offered', async () => {
  const { archive, asset } = fakeUvArchive();
  const { manager } = setup({ asset, archive });
  const info = (await manager.overview()).cswap;
  assert.equal(info.installed, false);
  assert.equal(info.source, null);
  assert.equal(info.pinned, CSWAP_VERSION);
  assert.deepEqual(info.managed, { available: true, state: 'absent', version: null });
});

test('the managed install fetches the pinned uv, installs claude-swap inside the data dir and is then used', async () => {
  const { archive, asset, log } = fakeUvArchive();
  const { manager, config, fetches } = setup({ asset, archive });
  const events: unknown[] = [];
  manager.on('cswap', (info) => events.push(info));

  const done = once(manager, 'cswap');
  const started = await manager.installCswap();
  assert.equal(started.managed.state, 'installing');
  await done;

  assert.deepEqual(fetches, [asset.url]);
  const call = readFileSync(log, 'utf8');
  assert.match(call, new RegExp(`^tool install --force claude-swap==${CSWAP_VERSION.replaceAll('.', '\\.')} \\| `));
  // Every path uv writes to is under the tools dir, and the user's uv config is ignored
  const tools = join(config.dataDir, 'tools');
  assert.ok(call.includes(`| ${join(tools, 'tools')} | ${join(tools, 'python')} | ${join(tools, 'cache')} | 1`));

  const info = (await manager.overview()).cswap;
  assert.equal(info.installed, true);
  assert.equal(info.source, 'managed');
  assert.equal(info.version, CSWAP_VERSION);
  assert.equal(info.compatible, true);
  assert.equal(info.path, join(tools, 'bin', 'cswap'));
  assert.equal(manager.bin, join(tools, 'bin', 'cswap'));
  assert.equal(info.managed.state, 'installed');
  assert.equal(events.length, 1);

  // uv is kept: a reinstall does not download it again
  await installed(manager);
  assert.equal(fetches.length, 1);
});

test('an archive whose digest does not match is never run', async () => {
  const { archive, asset, log } = fakeUvArchive();
  const { manager } = setup({ asset: { ...asset, sha256: '0'.repeat(64) }, archive });
  await installed(manager);
  const info = (await manager.overview()).cswap;
  assert.equal(info.installed, false);
  assert.equal(info.managed.state, 'failed');
  assert.match(info.managed.error ?? '', /digest mismatch/);
  assert.equal(existsSync(log), false);
});

test('a failed install says why, and a retry can succeed', async () => {
  const { archive, asset } = fakeUvArchive();
  const { manager, env } = setup({ asset, archive });
  env.FAKE_UV_FAIL = '1';
  await installed(manager);
  const failed = (await manager.overview()).cswap.managed;
  assert.equal(failed.state, 'failed');
  assert.match(failed.error ?? '', /Failed to fetch/);

  env.FAKE_UV_FAIL = '';
  await installed(manager);
  assert.equal((await manager.overview(true)).cswap.source, 'managed');
});

test('a compatible cswap on the PATH is preferred over the managed copy', async () => {
  const { archive, asset } = fakeUvArchive();
  const { manager } = setup({ asset, archive, path: binDir('0.26.2') });
  await installed(manager);
  const info = (await manager.overview(true)).cswap;
  assert.equal(info.source, 'path');
  assert.equal(info.version, '0.26.2');
  assert.equal(info.managed.version, CSWAP_VERSION);
});

test('an incompatible cswap on the PATH is used with a warning, until the managed copy exists', async () => {
  const { archive, asset } = fakeUvArchive();
  const { manager } = setup({ asset, archive, path: binDir('0.30.1') });
  const before = (await manager.overview()).cswap;
  assert.equal(before.installed, true);
  assert.equal(before.source, 'path');
  assert.equal(before.compatible, false);

  await installed(manager);
  const after = (await manager.overview(true)).cswap;
  assert.equal(after.source, 'managed');
  assert.equal(after.compatible, true);
});

test('removing the managed copy falls back to what else there is', async () => {
  const { archive, asset } = fakeUvArchive();
  const { manager, config } = setup({ asset, archive });
  await installed(manager);
  const info = await manager.removeCswap();
  assert.equal(info.installed, false);
  assert.equal(info.managed.state, 'absent');
  assert.equal(existsSync(join(config.dataDir, 'tools')), false);
});

test('CSWAP_BIN wins even when incompatible, and Agentry then manages nothing', async () => {
  const { archive, asset } = fakeUvArchive();
  const { manager } = setup({ asset, archive, env: { CSWAP_BIN: join(binDir('0.30.1'), 'cswap') }, path: binDir(CSWAP_VERSION) });
  const info = (await manager.overview()).cswap;
  assert.equal(info.source, 'env');
  assert.equal(info.compatible, false);
  assert.equal(info.managed.available, false);
  await assert.rejects(manager.installCswap(), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  await assert.rejects(manager.removeCswap(), (err: Error & { statusCode?: number }) => err.statusCode === 409);
});

test('the Docker image and AGENTRY_CSWAP_MANAGED=0 turn the managed install off', async () => {
  const { archive, asset } = fakeUvArchive();
  for (const env of [{ AGENTRY_DISTRIBUTION: 'docker' }, { AGENTRY_CSWAP_MANAGED: '0' }] as Record<string, string>[]) {
    const { manager } = setup({ asset, archive, env });
    assert.equal((await manager.overview()).cswap.managed.available, false);
  }
  // A platform with no pinned uv build cannot install either
  const { manager } = setup({ asset: null });
  assert.equal((await manager.overview()).cswap.managed.available, false);
});

test('a managed copy older than the pin is upgraded at boot', async () => {
  const { archive, asset, log } = fakeUvArchive();
  const { manager, config } = setup({ asset, archive });
  const bin = join(config.dataDir, 'tools', 'bin', 'cswap');
  mkdirSync(join(config.dataDir, 'tools', 'bin'), { recursive: true });
  writeFileSync(bin, cswapScript('0.25.0'));
  chmodSync(bin, 0o755);

  await installed(manager, () => manager.init());
  assert.match(readFileSync(log, 'utf8'), /tool install --force/);
  const info = (await manager.overview(true)).cswap;
  assert.equal(info.version, CSWAP_VERSION);
  assert.equal(info.source, 'managed');
  manager.shutdown();
});
