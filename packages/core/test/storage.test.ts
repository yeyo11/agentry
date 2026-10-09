import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, parseMountInfo, storageReport } from '../src/storage.ts';

// Lines as /proc/self/mountinfo writes them in a container: id parent maj:min root mount-point options
// [optional] - fstype source super-options
const HASH = 'a'.repeat(64);
const line = (root: string, point: string, fs = 'ext4') => `1 0 8:1 ${root} ${point} rw,relatime - ${fs} /dev/sda1 rw`;

const NAMED = [
  line('/', '/', 'overlay'),
  line('/var/lib/docker/volumes/agentry-config/_data', '/home/node/.claude'),
  line('/var/lib/docker/volumes/agentry-data/_data', '/data'),
  line('/home/me/workspace', '/workspace'),
].join('\n');

const ONLY_DATA_NAMED = [
  line('/', '/', 'overlay'),
  line(`/var/lib/docker/volumes/${HASH}/_data`, '/home/node/.claude'),
  line('/var/lib/docker/volumes/agentry-data/_data', '/data'),
  line(`/var/lib/docker/volumes/${HASH}/_data`, '/workspace'),
].join('\n');

const FOLDERS = { config: '/home/node/.claude', data: '/data', workspace: '/workspace' };

test('named volumes and bind mounts survive; the rest of the table is parsed around them', () => {
  const mounts = parseMountInfo(NAMED);
  assert.equal(mounts.length, 4);
  assert.deepEqual(['config', 'data', 'workspace'].map((id) => classify(FOLDERS[id as keyof typeof FOLDERS], mounts)), ['persistent', 'persistent', 'persistent']);
});

test('the README one-liner (only /data named) leaves config and workspace on anonymous volumes', () => {
  const report = storageReport('docker', FOLDERS, () => ONLY_DATA_NAMED);
  assert.deepEqual(report.locations.map((l) => l.kind), ['anonymous', 'persistent', 'anonymous']);
  assert.equal(report.atRisk, true);
  assert.equal(report.checked, true);
});

test('a folder with no mount of its own is the container layer', () => {
  const table = [line('/', '/', 'overlay'), line('/var/lib/docker/volumes/agentry-data/_data', '/data')].join('\n');
  const report = storageReport('docker', FOLDERS, () => table);
  assert.deepEqual(report.locations.map((l) => l.kind), ['container', 'persistent', 'container']);
  assert.equal(report.atRisk, true);
});

test('memory and emptyDir volumes are temporary', () => {
  const table = [
    line('/', '/', 'overlay'),
    line('/', '/home/node/.claude', 'tmpfs'),
    line('/var/lib/kubelet/pods/u1/volumes/kubernetes.io~empty-dir/data', '/data'),
    line('/var/lib/kubelet/pods/u1/volumes/kubernetes.io~csi/pvc-1/mount', '/workspace'),
  ].join('\n');
  assert.deepEqual(storageReport('docker', FOLDERS, () => table).locations.map((l) => l.kind), ['temporary', 'temporary', 'persistent']);
});

test('a sub path of one claim, as the Helm chart mounts it, is persistent', () => {
  const claim = '/var/lib/kubelet/pods/u1/volumes/kubernetes.io~csi/pvc-1/mount';
  const table = [line('/', '/', 'overlay'), line(`${claim}/data`, '/data'), line(`${claim}/claude`, '/home/node/.claude'), line(`${claim}/workspace`, '/workspace')].join('\n');
  const report = storageReport('docker', FOLDERS, () => table);
  assert.equal(report.atRisk, false);
});

test('a folder under a mount takes that mount, and escaped spaces are read back', () => {
  const table = [line('/', '/', 'overlay'), line('/var/lib/docker/volumes/agentry-data/_data', '/my\\040data')].join('\n');
  assert.equal(classify('/my data/provider-homes/codex', parseMountInfo(table)), 'persistent');
  assert.equal(classify('/my database', parseMountInfo(table)), 'container');
});

test('outside Docker nothing is checked, and an unreadable table warns of nothing', () => {
  assert.deepEqual(storageReport('deb', FOLDERS, () => ONLY_DATA_NAMED), { distribution: 'deb', checked: false, locations: [], atRisk: false });
  const unreadable = storageReport('docker', FOLDERS, () => {
    throw new Error('no /proc');
  });
  assert.deepEqual(unreadable.locations.map((l) => l.kind), ['unknown', 'unknown', 'unknown']);
  assert.equal(unreadable.atRisk, false);
});
