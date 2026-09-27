import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');

test('the .deb depends on the ssh the tunnel runs', () => {
  const depends = /^deb:\n(?:.*\n)*?\s+depends:\n((?:\s+- .+\n)+)/m.exec(builder)?.[1] ?? '';
  const packages = depends.split('\n').map((line) => line.trim().replace(/^- /, '')).filter(Boolean);
  assert.ok(packages.includes('openssh-client'), `deb.depends: ${packages.join(', ')}`);
});
