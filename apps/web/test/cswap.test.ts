import assert from 'node:assert/strict';
import test from 'node:test';
import type { CswapInfo, CswapManagedInfo } from '@agentry/shared';
import { accountsRefetchInterval, cswapInstalling, cswapRemovable, cswapView } from '../src/lib/cswap.ts';

const managed = (over: Partial<CswapManagedInfo> = {}): CswapManagedInfo => ({ available: true, state: 'absent', version: null, ...over });
const missing = (over: Partial<CswapManagedInfo> = {}): CswapInfo => ({
  installed: false,
  version: null,
  path: null,
  source: null,
  compatible: false,
  pinned: '0.26.0',
  managed: managed(over),
});
const running = (source: CswapInfo['source'], over: Partial<CswapManagedInfo> = {}, version = '0.26.0'): CswapInfo => ({
  installed: true,
  version,
  path: '/bin/cswap',
  source,
  compatible: version.startsWith('0.26.'),
  pinned: '0.26.0',
  managed: managed(over),
});

test('without claude-swap the page offers Agentry’s install only where Agentry may do it', () => {
  assert.equal(cswapView(missing()), 'offer');
  assert.equal(cswapView(missing({ available: false })), 'unavailable');
});

test('an install shows its progress, and so does the moment between landing and being detected', () => {
  assert.equal(cswapView(missing({ state: 'installing', step: 'uv' })), 'installing');
  assert.equal(cswapView(missing({ state: 'installed', version: '0.26.0' })), 'installing');
  assert.equal(cswapInstalling(running('managed', { state: 'installed', version: '0.26.0' })), false);
});

test('a failed install says so, and a claude-swap that runs wins over any install state', () => {
  assert.equal(cswapView(missing({ state: 'failed', error: 'no network' })), 'failed');
  assert.equal(cswapView(running('path', { state: 'failed' }, '0.30.0')), 'ready');
});

test('the overview is read fast only while an install moves', () => {
  assert.equal(accountsRefetchInterval(missing({ state: 'installing', step: 'claude-swap' })), 1_500);
  assert.equal(accountsRefetchInterval(missing()), 10_000);
  assert.equal(accountsRefetchInterval(running('managed', { state: 'installed' })), 10_000);
  assert.equal(accountsRefetchInterval(undefined), 10_000);
});

test('only Agentry’s own copy, in use and settled, can be removed from the page', () => {
  assert.equal(cswapRemovable(running('managed', { state: 'installed', version: '0.26.0' })), true);
  assert.equal(cswapRemovable(running('path', { state: 'installed', version: '0.26.0' })), false);
  assert.equal(cswapRemovable(running('managed', { available: false, state: 'installed' })), false);
  assert.equal(cswapRemovable(running('managed', { state: 'installing' })), false);
});
