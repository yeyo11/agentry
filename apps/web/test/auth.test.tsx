// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { probeAuth, setChallenge, useAuthChallenge, useAuthSettled } from '../src/lib/auth';

// A guarded wrapper has to open on its sign-in screen, not on a shell of skeletons it then takes
// back: the app asks once before it draws anything, and draws nothing until it has the answer.

function State() {
  const challenge = useAuthChallenge();
  const settled = useAuthSettled();
  return <i>{`${challenge ?? 'open'}:${settled ? 'settled' : 'waiting'}`}</i>;
}
const state = () => renderToStaticMarkup(<State />).replace(/<\/?i>/g, '');

const answer = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test('a page that never probes is settled from the start', () => {
  setChallenge(null);
  assert.equal(state(), 'open:settled');
});

test('a refused probe brings the sign-in for the mode the guard names, before the shell is drawn', async () => {
  let during = '';
  const refused: typeof fetch = async (...args) => {
    during = state();
    return answer(401, { error: 'authentication required', mode: 'oidc' })(...args);
  };
  await probeAuth(refused);
  assert.equal(during, 'open:waiting');
  assert.equal(state(), 'oidc:settled');
  setChallenge(null);
});

test('an accepted probe or an unreachable API lets the shell draw, with no challenge', async () => {
  await probeAuth(answer(200, { mode: 'none' }));
  assert.equal(state(), 'open:settled');
  await probeAuth(async () => {
    throw new TypeError('network down');
  });
  assert.equal(state(), 'open:settled');
});

test('a wrapper too slow to answer gets its shell after the wait', async () => {
  let release = () => {};
  const slow: typeof fetch = () => new Promise((resolve) => (release = () => resolve(new Response('{}', { status: 200 }))));
  const probe = probeAuth(slow, 10);
  assert.equal(state(), 'open:waiting');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state(), 'open:settled');
  release();
  await probe;
});
