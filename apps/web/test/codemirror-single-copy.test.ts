import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// CodeMirror keeps its facets and state fields by object identity, so two copies of
// `@codemirror/state` or `@codemirror/view` in one bundle make every editor throw "Unrecognized
// extension value". A dependency bump that moved one of them without the other (#200) broke every
// screen with a code editor; this reads the lockfile so it fails before the browser does.
const lock = readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');

for (const name of ['@codemirror/state', '@codemirror/view', '@codemirror/language']) {
  test(`the lockfile resolves one ${name}`, () => {
    const versions = new Set([...lock.matchAll(new RegExp(`^  '${name.replace('/', '\\/')}@([^']+)':`, 'gm'))].map((m) => m[1]));
    assert.equal(versions.size, 1, `${name}: ${[...versions].join(', ')} (run pnpm dedupe)`);
  });
}
