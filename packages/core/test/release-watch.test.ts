import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { AgentryEvent } from '@agentry/shared';
import { EventBus } from '../src/events.ts';
import { ReleaseWatch } from '../src/release-watch.ts';
import { tempConfig } from './helpers.ts';

const release = (tag: string) => ({
  tag_name: tag,
  html_url: `https://github.com/yeyo11/agentry/releases/tag/${tag}`,
  published_at: '2026-09-24T08:00:00Z',
});

/** A GitHub that answers with whatever `answer` holds at the time, and counts what it was asked */
function github(initial: unknown, status = 200) {
  const state = { answer: initial, status, calls: 0, headers: [] as Headers[], urls: [] as string[] };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    state.calls += 1;
    state.urls.push(String(url));
    state.headers.push(new Headers(init?.headers));
    return new Response(JSON.stringify(state.answer), { status: state.status });
  }) as typeof fetch;
  return { state, fetch: fetchFn };
}

const releases = (events: EventBus) => {
  const seen: AgentryEvent[] = [];
  events.observe((event) => {
    if (event.type === 'system.release') seen.push(event);
  });
  return seen;
};

test('reading the answer never asks GitHub', () => {
  const gh = github(release('v0.18.0'));
  const watch = new ReleaseWatch(tempConfig(), { current: '0.17.1', env: {}, fetch: gh.fetch });
  assert.deepEqual(watch.info(), {
    current: '0.17.1',
    latest: null,
    publishedAt: null,
    url: null,
    checkedAt: null,
    updateAvailable: false,
    distribution: 'source',
  });
  assert.equal(gh.state.calls, 0);
});

test('the tag v0.18.0 is the version 0.18.0, stored with its page and date in release.json', async () => {
  const config = tempConfig();
  const now = Date.parse('2026-09-25T10:00:00Z');
  const gh = github(release('v0.18.0'));
  const watch = new ReleaseWatch(config, { current: '0.17.1', env: {}, now: () => now, fetch: gh.fetch });
  await watch.check();

  const info = watch.info();
  assert.equal(info.latest, '0.18.0');
  assert.equal(info.updateAvailable, true);
  assert.equal(info.url, 'https://github.com/yeyo11/agentry/releases/tag/v0.18.0');
  assert.equal(info.publishedAt, '2026-09-24T08:00:00Z');
  assert.equal(info.checkedAt, '2026-09-25T10:00:00.000Z');
  assert.deepEqual(JSON.parse(readFileSync(join(config.dataDir, 'release.json'), 'utf8')), {
    latest: '0.18.0',
    publishedAt: '2026-09-24T08:00:00Z',
    url: 'https://github.com/yeyo11/agentry/releases/tag/v0.18.0',
    checkedAt: '2026-09-25T10:00:00.000Z',
  });
  assert.equal(new ReleaseWatch(config, { current: '0.17.1', env: {} }).info().latest, '0.18.0', 'survives a restart');
});

test('GitHub is asked for its JSON with a user-agent, and the URL can be pointed at a fixture', async () => {
  const gh = github(release('v0.18.0'));
  await new ReleaseWatch(tempConfig(), { current: '0.17.1', env: {}, fetch: gh.fetch }).check();
  assert.deepEqual(gh.state.urls, ['https://api.github.com/repos/yeyo11/agentry/releases/latest']);
  assert.equal(gh.state.headers[0]?.get('accept'), 'application/vnd.github+json');
  assert.match(gh.state.headers[0]?.get('user-agent') ?? '', /^agentry\/0\.17\.1$/);

  const fixture = github(release('v0.18.0'));
  await new ReleaseWatch(tempConfig(), { current: '0.17.1', env: { AGENTRY_RELEASES_URL: 'http://127.0.0.1:9/latest' }, fetch: fixture.fetch }).check();
  assert.deepEqual(fixture.state.urls, ['http://127.0.0.1:9/latest']);
});

test('a failed check keeps the previous answer and says why', async () => {
  const config = tempConfig();
  await new ReleaseWatch(config, { current: '0.17.1', env: {}, fetch: github(release('v0.18.0')).fetch }).check();

  const watch = new ReleaseWatch(config, { current: '0.17.1', env: {}, fetch: github({ message: 'API rate limit exceeded' }, 403).fetch });
  await watch.check();
  const info = watch.info();
  assert.equal(info.latest, '0.18.0');
  assert.equal(info.updateAvailable, true);
  assert.match(info.error ?? '', /GitHub answered 403/);
  assert.equal(JSON.parse(readFileSync(join(config.dataDir, 'release.json'), 'utf8')).latest, '0.18.0');
});

test('a release without a version tag is refused rather than stored', async () => {
  const watch = new ReleaseWatch(tempConfig(), { current: '0.17.1', env: {}, fetch: github(release('nightly')).fetch });
  await watch.check();
  assert.equal(watch.info().latest, null);
  assert.match(watch.info().error ?? '', /no version tag/);
});

test('a pre-release of the next version is behind its release, and ahead of the one before', async () => {
  const watch = new ReleaseWatch(tempConfig(), { current: '0.18.0-rc.1', env: {}, fetch: github(release('v0.18.0')).fetch });
  await watch.check();
  assert.equal(watch.info().updateAvailable, true);

  const ahead = new ReleaseWatch(tempConfig(), { current: '0.18.0-rc.1', env: {}, fetch: github(release('v0.17.1')).fetch });
  await ahead.check();
  assert.equal(ahead.info().updateAvailable, false);

  const same = new ReleaseWatch(tempConfig(), { current: '0.18.0', env: {}, fetch: github(release('v0.18.0')).fetch });
  await same.check();
  assert.equal(same.info().updateAvailable, false);
});

test('system.release is published once per newer version, and not again after a restart', async () => {
  const config = tempConfig();
  const events = new EventBus();
  const seen = releases(events);
  const gh = github(release('v0.18.0'));
  const watch = new ReleaseWatch(config, { current: '0.17.1', env: {}, fetch: gh.fetch, events });

  await watch.check();
  await watch.check();
  assert.equal(seen.length, 1);
  const first = seen[0];
  assert.ok(first?.type === 'system.release');
  assert.equal(first.release.latest, '0.18.0');
  assert.equal(first.release.updateAvailable, true);

  gh.state.answer = release('v0.18.1');
  await watch.check();
  assert.equal(seen.length, 2);

  const restarted = new ReleaseWatch(config, { current: '0.17.1', env: {}, fetch: gh.fetch, events });
  await restarted.check();
  assert.equal(seen.length, 2, 'the release the file already knew was announced by the previous process');
});

test('a check that finds this very version announces nothing', async () => {
  const events = new EventBus();
  const seen = releases(events);
  await new ReleaseWatch(tempConfig(), { current: '0.18.0', env: {}, fetch: github(release('v0.18.0')).fetch, events }).check();
  assert.equal(seen.length, 0);
});

test('the kind of install comes from AGENTRY_DISTRIBUTION, and anything else is a source checkout', () => {
  const kind = (value: string | undefined) =>
    new ReleaseWatch(tempConfig(), { current: '0.17.1', env: value === undefined ? {} : { AGENTRY_DISTRIBUTION: value } }).info().distribution;
  assert.equal(kind('docker'), 'docker');
  assert.equal(kind('appimage'), 'appimage');
  assert.equal(kind('deb'), 'deb');
  assert.equal(kind(undefined), 'source');
  assert.equal(kind('flatpak'), 'source');
});

/** Lets a check the fake timers started run to the end, file write included */
async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('the daily check runs a minute after start, then only once the answer is a day old', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    let now = Date.parse('2026-09-25T10:00:00Z');
    const gh = github(release('v0.18.0'));
    const watch = new ReleaseWatch(tempConfig(), { current: '0.17.1', env: {}, now: () => now, fetch: gh.fetch });
    const pass = async (ms: number) => {
      const before = watch.info().checkedAt;
      now += ms;
      mock.timers.tick(ms);
      await settle(() => watch.info().checkedAt !== before);
    };
    watch.startDaily();
    assert.equal(gh.state.calls, 0, 'nothing at boot');

    await pass(60_000);
    assert.equal(gh.state.calls, 1, 'the first check, a minute in');
    assert.equal(watch.info().checkedAt, '2026-09-25T10:01:00.000Z');

    const hour = 60 * 60 * 1000;
    for (let h = 1; h < 24; h += 1) await pass(hour);
    assert.equal(gh.state.calls, 1, 'the answer is less than a day old for the next 23 hours');

    await pass(hour);
    assert.equal(gh.state.calls, 2, 'and a day later it asks again');
    watch.stop();
  } finally {
    mock.timers.reset();
  }
});

test('AGENTRY_UPDATE_CHECK=off leaves no timer, and the button still works', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const gh = github(release('v0.18.0'));
    const watch = new ReleaseWatch(tempConfig(), { current: '0.17.1', env: { AGENTRY_UPDATE_CHECK: 'off' }, fetch: gh.fetch });
    watch.startDaily();
    mock.timers.tick(2 * 24 * 60 * 60 * 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gh.state.calls, 0);
    await watch.check();
    assert.equal(gh.state.calls, 1);
  } finally {
    mock.timers.reset();
  }
});
