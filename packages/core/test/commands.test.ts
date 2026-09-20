import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandKind, MIN_SAMPLES, slowAfterMs, usualDuration } from '../src/commands.ts';

// A kind of command is what "the same command again" and "longer than usual" are measured on, so
// the arguments that differ from run to run must not split one kind into many, and two commands
// that only share a program must not be lumped into one.

test('the arguments that change between runs do not change the kind of a command', () => {
  assert.equal(commandKind('pnpm e2e'), 'pnpm e2e');
  assert.equal(commandKind('pnpm e2e --slow specs/pages.spec.mjs'), 'pnpm e2e');
  assert.equal(commandKind('pnpm run test'), 'pnpm test');
  assert.equal(commandKind('pnpm --filter @agentry/core test -- chats.test.ts'), 'pnpm test');
  assert.equal(commandKind('cargo test --release'), 'cargo test');
  assert.equal(commandKind('git log --oneline -5'), 'git log');
});

test('setup around the command is not the command: cd, env, timeout and wrappers are skipped', () => {
  assert.equal(commandKind('cd apps/web && pnpm build'), 'pnpm build');
  assert.equal(commandKind('CI=1 NODE_ENV=test pnpm test'), 'pnpm test');
  assert.equal(commandKind('timeout 300 pnpm e2e'), 'pnpm e2e');
  assert.equal(commandKind('timeout -k 5 300 pnpm e2e'), 'pnpm e2e');
  assert.equal(commandKind('cd /repo && time timeout 120 npx vitest run'), 'npx vitest');
  assert.equal(commandKind('set -e; export A=1; pnpm typecheck'), 'pnpm typecheck');
});

test('a pipeline is judged by its head, and an interpreter by the script it runs', () => {
  assert.equal(commandKind('pnpm e2e 2>&1 | tail -20'), 'pnpm e2e');
  assert.equal(commandKind('node e2e/run.mjs --headless'), 'node e2e/run.mjs');
  assert.equal(commandKind('python3 -m pytest -x'), 'python3 pytest');
  assert.equal(commandKind('ls -la'), 'ls');
  assert.equal(commandKind('/usr/bin/grep -r foo .'), 'grep');
  assert.equal(commandKind(''), '');
});

test('there is no usual duration until enough runs have been seen', () => {
  assert.equal(usualDuration([80_000, 90_000]), null);
  assert.equal(usualDuration(Array.from({ length: MIN_SAMPLES - 1 }, () => 1000)), null);
  assert.ok(usualDuration(Array.from({ length: MIN_SAMPLES }, () => 1000)));
});

test('a command is slow only well past its own history, and never under the floor', () => {
  const e2e = usualDuration([78_000, 80_000, 82_000, 79_000, 95_000, 81_000]);
  assert.ok(e2e);
  assert.equal(e2e.medianMs, 81_000);
  // Three times the median beats one and a half times the slowest ordinary run
  assert.equal(slowAfterMs(e2e), 243_000);

  // A command that takes a second is not worth a signal at ten seconds
  const quick = usualDuration([1000, 1000, 1200, 900, 1100]);
  assert.ok(quick);
  assert.equal(slowAfterMs(quick), 30_000);

  // A suite that always takes twenty minutes is not hung at three
  const long = usualDuration([1_200_000, 1_150_000, 1_300_000, 1_250_000, 1_180_000]);
  assert.ok(long);
  assert.ok(slowAfterMs(long) > 3_000_000);
});
