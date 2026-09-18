import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccountManager, toAutoEvent } from '../src/accounts.ts';
import { Db } from '../src/db.ts';
import { tempConfig } from './helpers.ts';

const LIST = {
  schemaVersion: 1,
  activeAccountNumber: 2,
  accounts: [
    {
      number: 1,
      email: 'one@example.com',
      organizationName: 'Org One',
      active: false,
      usageStatus: 'ok',
      usage: {
        fiveHour: { pct: 100.0, resetsAt: '2026-09-18T20:39:59Z', countdown: '2h 34m' },
        sevenDay: { pct: 35.0, resetsAt: '2026-09-21T01:59:59Z', countdown: '2d 7h' },
        scoped: [{ pct: 22.0, resetsAt: '2026-09-21T01:59:59Z', countdown: '2d 7h', name: 'Fable' }],
      },
      usageFetchedAt: '2026-09-18T18:05:15Z',
    },
    {
      number: 2,
      email: 'two@example.com',
      alias: 'work',
      active: true,
      disabled: true,
      usageStatus: 'ok',
      usage: { fiveHour: { pct: 5.0, resetsAt: '2026-09-18T21:10:00Z', countdown: '3h 4m' }, sevenDay: { pct: 1.0, resetsAt: null, countdown: null } },
      usageFetchedAt: '2026-09-18T18:05:14Z',
    },
  ],
};

/** A `cswap` that answers with canned JSON, so the tests never touch the real accounts. */
function fakeCswap(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-cswap-'));
  const bin = join(dir, 'cswap');
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  --version) echo "cswap 0.26.0" ;;
  list) echo '${JSON.stringify(LIST, null, 2)}' ;;
  switch) printf 'switching…\n{\n  "switched": true,\n  "from": {"number": 2, "email": "two@example.com"},\n  "to": "one@example.com",\n  "reason": "manual"\n}\n' ;;
  add-token) head -n 1 > "${join(dir, 'token.txt')}" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
    'utf8',
  );
  chmodSync(bin, 0o755);
  return bin;
}

test('reads claude-swap accounts, usage and headroom', async () => {
  const config = { ...tempConfig(), cswapBin: fakeCswap() };
  const manager = new AccountManager(config, new Db(config));

  const cswap = await manager.detect();
  assert.equal(cswap.installed, true);
  assert.equal(cswap.version, '0.26.0');

  const overview = await manager.overview();
  assert.equal(overview.activeNumber, 2);
  const [one, two] = overview.accounts;
  assert.equal(one?.email, 'one@example.com');
  assert.equal(one?.organizationName, 'Org One');
  // The binding window is the 5h one at 100%: nothing left
  assert.equal(one?.headroomPct, 0);
  assert.equal(one?.usage?.scoped[0]?.name, 'Fable');
  assert.equal(two?.headroomPct, 95);
  assert.equal(two?.alias, 'work');
  assert.equal(two?.disabled, true);

  // Only the active account counts as active, by number, email or alias
  assert.equal(manager.managed, true);
  assert.equal(manager.isActive('2'), true);
  assert.equal(manager.isActive('two@example.com'), true);
  assert.equal(manager.isActive('work'), true);
  assert.equal(manager.isActive('1'), false);

  const snapshot = manager.snapshot();
  assert.equal(snapshot?.total, 2);
  assert.equal(snapshot?.active?.number, 2);

  const switched: unknown[] = [];
  manager.on('switched', (result) => switched.push(result));
  const result = await manager.switch('1');
  assert.deepEqual(result, { switched: true, from: 'two@example.com', to: 'one@example.com', reason: 'manual' });
  assert.equal(switched.length, 1);
  // A write must not blind the manager: it still knows the accounts, with the new active one
  assert.equal(manager.managed, true);
  assert.equal(manager.isActive('1'), true);
  assert.equal(manager.isActive('2'), false);
  // The switch is logged so the UI can show why the account moved
  assert.equal((await manager.overview()).events.at(-1)?.event, 'switch');
});

test('degrades to "not installed" without claude-swap', async () => {
  const config = { ...tempConfig(), cswapBin: '/nonexistent/cswap' };
  const manager = new AccountManager(config, new Db(config));
  const cswap = await manager.detect();
  assert.equal(cswap.installed, false);
  assert.match(cswap.error ?? '', /nonexistent|not found|ENOENT/);
  assert.deepEqual(await manager.list(), []);
  assert.equal(manager.managed, false);
  assert.equal(manager.snapshot(), null);
  assert.equal((await manager.overview()).activeNumber, null);
});

// Identifiers become CLI arguments: anything flag-like must be rejected before the process starts
test('rejects identifiers and settings that the CLI would misread', async () => {
  const config = { ...tempConfig(), cswapBin: '/nonexistent/cswap' };
  const manager = new AccountManager(config, new Db(config));
  for (const bad of ['--help', '-x', 'a b', '', 'a;b', undefined]) {
    assert.throws(() => manager.remove(bad), /invalid account/, String(bad));
    assert.throws(() => manager.disable(bad), /invalid account/);
    // `switch(undefined)` is the documented "rotate to the next account" call
    if (bad !== undefined) assert.throws(() => manager.switch(bad), /invalid account/);
  }
  assert.throws(() => manager.setAlias(1, '--unset-me'), /invalid alias/);
  assert.throws(() => manager.switch('1', 'fastest' as never), /strategy must be/);
  await assert.rejects(manager.addToken(''), /token is required/);
  await assert.rejects(manager.addToken('two words'), /invalid token/);

  await assert.rejects(manager.setAutoSwitch({ threshold: 10 }), /threshold must be/);
  await assert.rejects(manager.setAutoSwitch({ intervalSec: 5 }), /intervalSec must be/);
  await assert.rejects(manager.setAutoSwitch({ strategy: 'whatever' as never }), /strategy must be/);
  await assert.rejects(manager.setAutoSwitch({ models: ['--all'] }), /invalid model name/);
});

test('auto-switch settings persist and the event stream is parsed', async () => {
  const config = { ...tempConfig(), cswapBin: '/nonexistent/cswap' };
  const manager = new AccountManager(config, new Db(config));
  // enabled stays off here: the supervisor would have nothing to spawn
  const saved = await manager.setAutoSwitch({ threshold: 75.5, strategy: 'consume-first', models: ['Fable'], intervalSec: 120 });
  assert.equal(saved.threshold, 75.5);
  assert.equal(saved.rotateOnLimit, true);
  assert.deepEqual(new AccountManager(config, new Db(config)).autoSwitch, saved);

  const poll = toAutoEvent('{"schemaVersion":1,"event":"poll","active":{"number":2},"threshold":90.0}');
  assert.equal(poll.event, 'poll');
  const switched = toAutoEvent('{"event":"switch","from":{"number":1,"email":"one@example.com"},"to":"two@example.com","reason":"threshold"}');
  assert.deepEqual({ from: switched.from, to: switched.to, reason: switched.reason }, {
    from: 'one@example.com',
    to: 'two@example.com',
    reason: 'threshold',
  });
  assert.equal(toAutoEvent('not json').event, 'error');
});
