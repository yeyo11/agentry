import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CliVersionWatch, compareVersions } from '../src/cli-version.ts';
import { tempConfig } from './helpers.ts';

const registry = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test('versions compare numerically, so 2.1.10 is newer than 2.1.9', () => {
  assert.ok(compareVersions('2.1.10', '2.1.9') > 0);
  assert.ok(compareVersions('2.2.0', '2.1.99') > 0);
  assert.equal(compareVersions('2.1.278', '2.1.278'), 0);
  assert.ok(compareVersions('2.1.278', '2.1.278-beta.1') > 0, 'a pre-release sorts below its release');
});

test('reading the answer never touches the registry', () => {
  let calls = 0;
  const watch = new CliVersionWatch(tempConfig(), {
    env: {},
    fetch: (async () => {
      calls += 1;
      return new Response('{}');
    }) as typeof fetch,
  });
  assert.deepEqual(watch.info('2.1.278'), { current: '2.1.278', pinned: null, latest: null, checkedAt: null, updateAvailable: false });
  assert.equal(calls, 0);
});

test('a check stores the newest version and survives a restart', async () => {
  const config = tempConfig();
  const now = Date.parse('2026-09-20T10:00:00Z');
  const watch = new CliVersionWatch(config, { env: {}, now: () => now, fetch: registry({ version: '2.1.300' }) });
  await watch.check();

  const info = watch.info('2.1.278');
  assert.equal(info.latest, '2.1.300');
  assert.equal(info.updateAvailable, true);
  assert.equal(info.checkedAt, '2026-09-20T10:00:00.000Z');
  assert.equal(watch.info('2.1.300').updateAvailable, false);
  assert.equal(watch.info(null).updateAvailable, false, 'nothing to update when no CLI is installed');

  const restarted = new CliVersionWatch(config, { env: {} });
  assert.equal(restarted.info('2.1.278').latest, '2.1.300');
});

test('a failed check keeps the previous answer and says why', async () => {
  const config = tempConfig();
  await new CliVersionWatch(config, { env: {}, fetch: registry({ version: '2.1.300' }) }).check();

  const watch = new CliVersionWatch(config, { env: {}, fetch: registry({}, 503) });
  await watch.check();
  const info = watch.info('2.1.278');
  assert.equal(info.latest, '2.1.300');
  assert.match(info.error ?? '', /503/);
  assert.ok(existsSync(join(config.dataDir, 'cli-version.json')));
  assert.equal(JSON.parse(readFileSync(join(config.dataDir, 'cli-version.json'), 'utf8')).latest, '2.1.300');
});

test('an answer that is not a version is refused rather than stored', async () => {
  const watch = new CliVersionWatch(tempConfig(), { env: {}, fetch: registry({ version: '<html>' }) });
  await watch.check();
  assert.equal(watch.info('2.1.278').latest, null);
  assert.match(watch.info('2.1.278').error ?? '', /no version/);
});

test('two checks at once are one request', async () => {
  let calls = 0;
  const watch = new CliVersionWatch(tempConfig(), {
    env: {},
    fetch: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '2.1.300' }));
    }) as typeof fetch,
  });
  await Promise.all([watch.check(), watch.check()]);
  assert.equal(calls, 1);
});

test('only an exact version counts as pinned', () => {
  const pinned = (value: string) => new CliVersionWatch(tempConfig(), { env: { AGENTRY_CLAUDE_CODE_PINNED: value } }).pinned;
  assert.equal(pinned('2.1.278'), '2.1.278');
  assert.equal(pinned('latest'), null);
  assert.equal(pinned('stable'), null);
  assert.equal(pinned(''), null);
});

test('the registry can be pointed elsewhere for a mirror', async () => {
  const seen: string[] = [];
  const watch = new CliVersionWatch(tempConfig(), {
    env: { AGENTRY_CLI_REGISTRY_URL: 'https://mirror.example/claude-code/latest' },
    fetch: (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ version: '2.1.300' }));
    }) as typeof fetch,
  });
  await watch.check();
  assert.deepEqual(seen, ['https://mirror.example/claude-code/latest']);
});

test('the daily check can be switched off and leaves no timer behind', () => {
  const watch = new CliVersionWatch(tempConfig(), { env: { AGENTRY_CLI_UPDATE_CHECK: 'off' } });
  watch.startDaily();
  const on = new CliVersionWatch(tempConfig(), { env: {} });
  on.startDaily();
  on.startDaily(); // idempotent
  on.stop();
});
