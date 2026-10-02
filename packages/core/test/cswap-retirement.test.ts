import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CswapRetirementNotice } from '../src/cswap-retirement.ts';

const dataDir = (): string => mkdtempSync(join(tmpdir(), 'agentry-test-retire-'));

test('nothing of claude-swap here: no notice', () => {
  const dir = dataDir();
  try {
    assert.equal(new CswapRetirementNotice({ dataDir: dir }, {}).read(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('its documents, its managed copy or CSWAP_BIN are the notice; the projects that had a policy are named', async () => {
  const dir = dataDir();
  try {
    writeFileSync(join(dir, 'accounts.json'), '{}');
    writeFileSync(join(dir, 'account-config.json'), JSON.stringify({ policies: [{ id: 'p', threshold: 80, projects: ['a', 'b'] }] }));
    mkdirSync(join(dir, 'tools', 'bin'), { recursive: true });
    const notice = new CswapRetirementNotice({ dataDir: dir }, { CSWAP_BIN: '/x/cswap' });
    const read = notice.read();
    assert.deepEqual(read?.found, ['accounts', 'account-config', 'managed-copy', 'cswap-bin']);
    assert.deepEqual(read?.policyProjects, ['a', 'b']);
    assert.equal(read?.managedCopy, true);

    // Removing the copy deletes `tools` and nothing else
    assert.equal(await notice.removeManagedCopy(), true);
    assert.equal(existsSync(join(dir, 'tools')), false);
    assert.equal(existsSync(join(dir, 'accounts.json')), true);
    assert.equal(existsSync(join(dir, 'account-config.json')), true);
    assert.equal(await notice.removeManagedCopy(), false);

    await notice.dismiss();
    assert.equal(notice.read(), null, 'dismissed stays dismissed');
    assert.equal(new CswapRetirementNotice({ dataDir: dir }, {}).read(), null, 'across a restart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
