import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const RECORDINGS = fileURLToPath(new URL('./fixtures/recordings/', import.meta.url));

interface Entry {
  id: string;
  cli: string;
  version: string;
  argv: string[];
  vars: Record<string, string>;
  env?: Record<string, string>;
  stdinSha256: string | null;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const index = JSON.parse(readFileSync(join(RECORDINGS, 'index.json'), 'utf8')) as { entries: Entry[] };
const entry = (id: string): Entry => {
  const found = index.entries.find((e) => e.id === id);
  assert.ok(found, `no recording ${id}`);
  return found;
};
const recordedArgv = (e: Entry) => e.argv.map((word) => word.replace(/@\{(\w+)\}/g, (_m, name: string) => e.vars[name] ?? ''));

// The environment is cleared of the variables the fake reads, so a developer's shell cannot steer it.
const run = (cli: string, argv: string[], extra: Record<string, string> = {}, input = '') => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.startsWith('FAKE_CLI')) env[name] = value;
  const result = spawnSync(process.execPath, [FAKE, ...argv], { env: { ...env, FAKE_CLI: cli, ...extra }, input });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
};

const replays = (id: string, extra: Record<string, string> = {}, input = '') => {
  const e = entry(id);
  const result = run(e.cli, recordedArgv(e), { FAKE_CLI_VERSION: e.version, ...(e.env ?? {}), ...extra }, input);
  assert.deepEqual(result.stdout, readFileSync(join(RECORDINGS, e.stdout)), `${id}: stdout`);
  assert.deepEqual(result.stderr, readFileSync(join(RECORDINGS, e.stderr)), `${id}: stderr`);
  assert.equal(result.status, e.exitCode, `${id}: exit code`);
};

test('recorded gh 2.92.0 calls replay byte for byte, streams and exit code apart', () => {
  replays('gh/2.92.0/version');
  replays('gh/2.92.0/auth-status-json');
  // 2.92 invents a PR for `--json number` alone: the reason adapters always ask for two fields.
  replays('gh/2.92.0/pr-view-999999');
  replays('gh/2.92.0/pr-create-exists', { FAKE_CLI_LABELS: 'pr-create-exists' });
});

test('recorded gh 2.102.0 calls replay byte for byte, streams and exit code apart', () => {
  replays('gh/2.102.0/version');
  replays('gh/2.102.0/pr-view-999999');
  replays('gh/2.102.0/auth-status-json-none', { FAKE_CLI_LABELS: 'auth-status-json-none' });
});

test('recorded glab 1.120.0 calls replay byte for byte, including one that read stdin', () => {
  replays('glab/1.120.0/version');
  replays('glab/1.120.0/repoview');
  replays('glab/1.120.0/view404');
  replays('glab/1.120.0/bad_token');
  replays('glab/1.120.0/note_stdin', {}, 'probe from stdin\n');
});

test('the gh 2.45.0 version line is kept for the below-minimum test', () => {
  const result = run('gh', ['--version'], { FAKE_CLI_VERSION: '2.45.0' });
  assert.equal(result.status, 0);
  assert.match(result.stdout.toString('utf8'), /^gh version 2\.45\.0 /);
});

test('a call nobody recorded exits 97 and says so on stderr', () => {
  const result = run('gh', ['pr', 'view', '12', '-R', 'yeyo11/agentry', '--json', 'no-such-field']);
  assert.equal(result.status, 97);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.toString('utf8'), /^unrecorded call/);

  const otherStdin = run('glab', ['mr', 'note', 'create', '4', '-R', 'yeyo11/agentry'], {}, 'a body nobody recorded\n');
  assert.equal(otherStdin.status, 97, 'stdin is part of the call');
});

test('host, repository and ids are templated, so another repository gets the same recorded answer', () => {
  const e = entry('glab/1.120.0/mrview3');
  const result = run('glab', ['mr', 'view', '3', '-R', 'acme/widgets', '-F', 'json']);
  assert.equal(result.status, e.exitCode);
  assert.deepEqual(result.stdout, readFileSync(join(RECORDINGS, e.stdout)));
});

test('an entry recorded under an environment variable answers only when it is set', () => {
  const plain = run('glab', ['api', 'user']);
  assert.equal(plain.status, 0, 'without GITLAB_TOKEN the signed-in recording answers');
  assert.equal(run('glab', ['api', 'user'], { GITLAB_TOKEN: 'invalid' }).status, 1);
});

test('the fake knows which CLI it is from the name it was started through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-fake-cli-'));
  const gh = join(dir, 'gh');
  symlinkSync(FAKE, gh);
  const result = spawnSync(process.execPath, [gh, '--version'], { env: { PATH: process.env.PATH ?? '' } });
  assert.equal(result.status, 0);
  assert.match(result.stdout.toString('utf8'), /^gh version 2\.92\.0 \(2026-04-28\)/);
});
