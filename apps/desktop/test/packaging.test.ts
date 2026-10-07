import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');

test("the .deb does not depend on a tunnel package: Tailscale is the person's to install, and the tab says how", () => {
  const depends = /^deb:\n(?:.*\n)*?\s+depends:\n((?:\s+- .+\n)+)/m.exec(builder)?.[1] ?? '';
  const packages = depends.split('\n').map((line) => line.trim().replace(/^- /, '')).filter(Boolean);
  assert.ok(packages.includes('libgtk-3-0'), `the list was read: ${packages.join(', ')}`);
  // Not in Debian's archive, so a dependency would make the package uninstallable on a plain system
  assert.ok(!packages.includes('tailscale'), `deb.depends: ${packages.join(', ')}`);
  // localhost.run's ssh went with the old tunnel
  assert.ok(!packages.includes('openssh-client'), `deb.depends: ${packages.join(', ')}`);
});
