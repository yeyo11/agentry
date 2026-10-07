import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db.ts';
import { classifyCall, hostErrorFields, reasonOf } from '../src/hosts/classify.ts';
import { buildHostEnv, envOf } from '../src/hosts/env.ts';
import { runHostCall, spawnHostCall, splitHttpHead, type HostCall, type HostResult } from '../src/hosts/exec.ts';
import { parseJson } from '../src/hosts/json.ts';
import { HostBusyError, HostLimiter } from '../src/hosts/limits.ts';
import { HostRateLimiter } from '../src/hosts/rate-limit.ts';
import { firstLine, redactHostObject } from '../src/hosts/redact.ts';
import { isRetryable } from '../src/hosts/retry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const recorded = (path: string): string => readFileSync(join(here, 'fixtures/recordings', path), 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'agentry-hosts-exec-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A stand-in for a host CLI: node runs this script, so the "binary" is node and the script is argv[0]
const SCRIPT = join(scratch, 'fake-cli.mjs');
writeFileSync(
  SCRIPT,
  `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let [mode, file, ...rest] = process.argv.slice(2);
// \`gh pr merge\` style argv, so the classifier has a porcelain verb to find; the scenario comes from the environment
if (mode === 'pr') { mode = 'status'; file = process.env.FAKE_COUNTER; rest = ['502', '{}']; }
const count = () => { appendFileSync(file, 'x'); return readFileSync(file, 'utf8').length; };
const http = (status, headers, body) => process.stdout.write('HTTP/2.0 ' + status + ' X\\r\\n' + Object.entries(headers).map(([k, v]) => k + ': ' + v + '\\r\\n').join('') + '\\r\\n' + body);
if (mode === 'env') { process.stdout.write(JSON.stringify(process.env)); }
else if (mode === 'stdin') { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => process.stdout.write('got:' + s)); }
else if (mode === 'status') { count(); http(Number(rest[0]), JSON.parse(rest[1] ?? '{}'), '{"message":"nope"}'); process.exit(1); }
else if (mode === 'flaky') { const n = count(); if (n <= Number(rest[0])) { http(502, {}, '{}'); process.exit(1); } http(200, {}, '{"ok":true}'); }
else if (mode === 'plain-fail') { count(); process.stderr.write('boom\\nsecond line\\n'); process.stdout.write('{"id":1}'); process.exit(1); }
else if (mode === 'error-body') { process.stdout.write('{"message":"Not Found","status":"404","errors":[{"code":"missing","resource":"Issue","field":"x","message":"words"}]}'); process.exit(1); }
else if (mode === 'big') { const chunk = Buffer.alloc(1024 * 1024, 97); let left = Number(rest[0]); const more = () => { while (left > 0) { left -= 1; if (!process.stdout.write(chunk)) return process.stdout.once('drain', more); } }; more(); }
else if (mode === 'log') { for (let i = 0; i < Number(rest[0]); i++) process.stdout.write('line ' + String(i).padStart(6, '0') + '\\n'); }
else if (mode === 'sleep') { setInterval(() => {}, 1000); process.on('SIGTERM', () => {}); }
else if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {});
  const grandchild = spawn(process.execPath, [process.argv[1], 'sleep', file], { stdio: 'ignore' });
  writeFileSync(rest[0], String(grandchild.pid));
  setInterval(() => {}, 1000);
}
`,
);

const counterFile = (): string => join(mkdtempSync(join(scratch, 'c-')), 'count');
const callOf = (cli: HostCall['cli'], args: string[], over: Partial<HostCall> = {}): HostCall => ({ cli, args, kind: 'read', class: 'read', host: 'github.com', ...over });
const options = (extra: Record<string, unknown> = {}) => ({ binaryPath: process.execPath, cwd: scratch, ...extra });
const run = (mode: string, args: string[], over: Partial<HostCall> = {}) => callOf('gh', [SCRIPT, mode, ...args], over);
const noSleep = { sleep: async () => {}, random: () => 0.5 };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------- the process ----------

test('a child that ignores SIGTERM is killed with its grandchild, and the result is a timeout', async () => {
  const pidFile = join(scratch, 'grandchild.pid');
  const result = await spawnHostCall(run('ignore-term', [counterFile(), pidFile]), options({ timeoutMs: 3000, killGraceMs: 500 }));
  assert.equal(result.exitCode, null);
  assert.equal(result.reason, 'timeout');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  // SIGKILL went to the group, so the grandchild, which also ignores SIGTERM, is gone; the timeout and the wait are wide because node can start slowly when the whole suite runs at once
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false);
});

test('stdin is always closed: a CLI that reads it sees the body, and one given none sees the end of input', async () => {
  const given = await spawnHostCall(run('stdin', [counterFile()], { input: 'the body' }), options());
  assert.equal(given.stdout, 'got:the body');
  const none = await spawnHostCall(run('stdin', [counterFile()]), options());
  assert.equal(none.stdout, 'got:');
});

test('a missing binary is cli-missing, not a thrown error', async () => {
  const result = await spawnHostCall(callOf('gh', ['--version']), options({ binaryPath: join(scratch, 'no-such-gh') }));
  assert.equal(result.reason, 'cli-missing');
  assert.equal(result.exitCode, null);
});

test('stdout over the cap kills the process and keeps only the end', async () => {
  const result = await spawnHostCall(run('big', [counterFile(), '4']), options({ caps: { stdoutBytes: 1024 * 1024, tailBytes: 4096 } }));
  assert.equal(result.reason, 'output-too-large');
  assert.equal(result.truncated, true);
  assert.equal(result.exitCode, null);
  assert.ok(result.stdout.length <= 4096);
});

test('a log keeps a tail ring, with no failure, while it is under the read cut', async () => {
  const result = await spawnHostCall(run('log', [counterFile(), '5000'], { class: 'log' }), options({ caps: { tailBytes: 2048 } }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.reason, null);
  assert.ok(result.stdout.length <= 2048);
  assert.ok(result.stdout.trimEnd().endsWith('line 004999'));
});

test('a log read past its cut stops and says output-too-large', async () => {
  const result = await spawnHostCall(run('big', [counterFile(), '8'], { class: 'log' }), options({ caps: { tailBytes: 1024, logReadBytes: 2 * 1024 * 1024 } }));
  assert.equal(result.reason, 'output-too-large');
  assert.ok(result.stdout.length <= 1024);
});

test('stderr keeps its first bytes, redacted, and its first line only', async () => {
  const result = await spawnHostCall(run('plain-fail', [counterFile()]), options());
  assert.equal(result.stderrFirstLine, 'boom');
  // The whole text rides along for an adapter that reads a box (glab's merge refusal)
  assert.ok(result.stderrText?.startsWith('boom'));
  assert.equal(firstLine('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 was rejected\nmore'), 'token <redacted:token> was rejected');
});

test('the status line and headers of `api -i` become `http` and leave only the body', async () => {
  const gh = splitHttpHead(recorded('gh/2.92.0/api-i.out'));
  assert.equal(gh.http?.status, 200);
  assert.equal(gh.http?.headers['x-ratelimit-resource'], 'core');
  assert.ok(gh.body.trimStart().startsWith('['));
  const gl = splitHttpHead(recorded('glab/1.120.0/api_404i.out'));
  assert.equal(gl.http?.status, 404);
  assert.equal(gl.http?.headers['ratelimit-limit'], '2000');
  const result = await spawnHostCall(run('status', [counterFile(), '404'], { args: [SCRIPT, 'status', counterFile(), '404', '{}', '-i'] }), options());
  assert.equal(result.http?.status, 404);
  assert.equal(result.stdout, '{"message":"nope"}');
});

// ---------- environment ----------

test('the environment: variables set, and GH_HOST, GH_REPO, NO_PROMPT, GITLAB_HOST removed', async () => {
  const base = { PATH: process.env.PATH, GH_HOST: 'evil.example', GH_REPO: 'a/b', NO_PROMPT: '1', GITLAB_HOST: 'evil.example', GH_TOKEN: 'keep-me', DEBUG: '1' };
  const gh = JSON.parse((await spawnHostCall(run('env', [counterFile()]), options({ baseEnv: base }))).stdout) as Record<string, string>;
  assert.equal(gh.GH_HOST, undefined);
  assert.equal(gh.GH_REPO, undefined);
  assert.equal(gh.DEBUG, undefined);
  assert.equal(gh.GH_TELEMETRY, '0');
  assert.equal(gh.GH_PROMPT_DISABLED, '1');
  assert.equal(gh.NO_COLOR, '1');
  assert.equal(gh.LC_ALL, 'C');
  assert.equal(gh.GIT_TERMINAL_PROMPT, '0');
  // the person's own token stays: the pinned host is what keeps it from going elsewhere
  assert.equal(gh.GH_TOKEN, 'keep-me');
  const glab = JSON.parse((await spawnHostCall(callOf('glab', [SCRIPT, 'env', counterFile()]), options({ baseEnv: base }))).stdout) as Record<string, string>;
  assert.equal(glab.NO_PROMPT, undefined);
  assert.equal(glab.GITLAB_HOST, undefined);
  assert.equal(glab.GLAB_NO_PROMPT, '1');
  assert.equal(glab.GLAB_SEND_TELEMETRY, 'false');
});

test('YouTrack credentials enter the child of youtrack-app only, never another CLI', () => {
  const secrets = { YOUTRACK_HOST: 'https://yt.example', YOUTRACK_TOKEN: 'perm-token' };
  const base = { PATH: '/bin', YOUTRACK_API_TOKEN: 'legacy' };
  const yt = buildHostEnv('youtrack-app', base, secrets);
  assert.equal(yt.YOUTRACK_TOKEN, 'perm-token');
  assert.equal(yt.YOUTRACK_API_TOKEN, undefined);
  assert.equal(buildHostEnv('gh', base, secrets).YOUTRACK_TOKEN, undefined);
  assert.equal(buildHostEnv('glab', base, secrets).YOUTRACK_TOKEN, undefined);
  // an adapter's copy cannot change the table
  envOf('gh').set.GH_TELEMETRY = '1';
  assert.equal(envOf('gh').set.GH_TELEMETRY, '0');
});

// ---------- the write classifier ----------

test('the classifier: porcelain verbs, api methods and fields, graphql documents, youtrack requests', () => {
  const kind = (cli: HostCall['cli'], ...args: string[]) => classifyCall({ cli, args });
  for (const args of [
    ['pr', 'create', '-R', 'github.com/o/r', '--title', 'close'],
    ['pr', 'merge', '12'],
    ['pr', 'comment', '12', '--body-file', '-'],
    ['pr', 'ready', '12'],
    ['run', 'rerun', '1', '--failed'],
    ['pr', 'review', '12', '--approve'],
  ]) {
    assert.equal(kind('gh', ...args), 'write', args.join(' '));
  }
  for (const args of [['--version'], ['auth', 'status', '--json', 'hosts'], ['pr', 'view', '12', '--json', 'number,url'], ['pr', 'list', '--head', 'close'], ['run', 'view', '1'], ['pr', 'checks', '12', '--json', 'name']]) {
    assert.equal(kind('gh', ...args), 'read', args.join(' '));
  }
  assert.equal(kind('glab', 'mr', 'create', '--yes'), 'write');
  assert.equal(kind('glab', 'mr', 'merge', '12'), 'write');
  assert.equal(kind('glab', 'ci', 'run'), 'write');
  assert.equal(kind('glab', 'mr', 'note', 'create', '12'), 'write');
  for (const args of [['mr', 'note', 'list', '12'], ['ci', 'get'], ['ci', 'list'], ['ci', 'status'], ['mr', 'list', '-A'], ['repo', 'view', '-F', 'json'], ['version'], ['auth', 'status', '--hostname', 'gitlab.com']]) {
    assert.equal(kind('glab', ...args), 'read', args.join(' '));
  }
  // api: the method, or a field or body without GET
  assert.equal(kind('gh', 'api', '--hostname', 'github.com', 'repos/o/r'), 'read');
  assert.equal(kind('gh', 'api', '-i', 'repos/o/r', '--paginate'), 'read');
  assert.equal(kind('gh', 'api', '-X', 'POST', 'repos/o/r/issues'), 'write');
  assert.equal(kind('gh', 'api', '-XDELETE', 'repos/o/r/x'), 'write');
  assert.equal(kind('gh', 'api', '--method=PATCH', 'repos/o/r'), 'write');
  assert.equal(kind('gh', 'api', 'repos/o/r/issues', '-f', 'title=x'), 'write');
  assert.equal(kind('gh', 'api', 'repos/o/r/issues', '--input', '-'), 'write');
  assert.equal(kind('gh', 'api', '-X', 'GET', 'search/issues', '-f', 'q=is:open'), 'read');
  assert.equal(kind('gh', 'api', '--method', 'HEAD', 'repos/o/r'), 'read');
  assert.equal(kind('glab', 'api', '--hostname', 'gitlab.com', 'projects/1/merge_requests', '-F', 'a=b'), 'write');
  assert.equal(kind('glab', 'api', '--hostname', 'gitlab.com', 'projects/1', '--paginate', '--output', 'ndjson'), 'read');
  // graphql: every call is a POST, the document decides
  assert.equal(kind('gh', 'api', 'graphql', '-f', 'query=query($n:Int!){ viewer { login } }', '-F', 'n=1'), 'read');
  assert.equal(kind('gh', 'api', 'graphql', '-f', 'query=# note\n  mutation { addComment }'), 'write');
  assert.equal(kind('gh', 'api', 'graphql', '-F', 'query=@document.graphql'), 'write');
  assert.equal(classifyCall({ cli: 'gh', args: ['api', 'graphql', '--input', '-'], input: '{"query":"query { viewer { login } }"}' }), 'read');
  assert.equal(classifyCall({ cli: 'gh', args: ['api', 'graphql', '--input', '-'], input: '{"query":"mutation { x }"}' }), 'write');
  // youtrack-app
  assert.equal(kind('youtrack-app', 'rest', 'request', '--path', '/api/issues'), 'read');
  assert.equal(kind('youtrack-app', 'rest', 'request', '--method', 'POST', '--path', '/api/issues'), 'write');
  assert.equal(kind('youtrack-app', 'project', 'list'), 'read');
});

test('a call declared read that the classifier says is a write is run as a write: never retried', async () => {
  const file = counterFile();
  const call = callOf('gh', [SCRIPT, 'pr', 'merge', '12']);
  assert.equal(call.kind, 'read');
  const result = await runHostCall(call, options({ retry: noSleep, limiter: new HostLimiter(), baseEnv: { PATH: process.env.PATH, FAKE_COUNTER: file } }));
  assert.equal(result.exitCode, 1);
  assert.equal(readFileSync(file, 'utf8').length, 1);
});

// ---------- retry ----------

test('a write is never retried, even on a 5xx', async () => {
  const file = counterFile();
  const result = await runHostCall(run('flaky', [file, '5'], { kind: 'write', class: 'write', args: [SCRIPT, 'flaky', file, '5', '-i'] }), options({ retry: noSleep }));
  assert.equal(result.http?.status, 502);
  assert.equal(readFileSync(file, 'utf8').length, 1);
});

test('a read is retried on a 5xx and succeeds on the third attempt', async () => {
  const file = counterFile();
  const waits: number[] = [];
  const result = await runHostCall(run('flaky', [file, '2'], { args: [SCRIPT, 'flaky', file, '2', '-i'] }), options({ retry: { random: () => 0.5, sleep: async (ms: number) => void waits.push(ms) } }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '{"ok":true}');
  assert.equal(readFileSync(file, 'utf8').length, 3);
  assert.deepEqual(waits, [1000, 4000]);
});

test('a read gives up after three attempts', async () => {
  const file = counterFile();
  const result = await runHostCall(run('flaky', [file, '9'], { args: [SCRIPT, 'flaky', file, '9', '-i'] }), options({ retry: noSleep }));
  assert.equal(result.reason, 'server-error');
  assert.equal(readFileSync(file, 'utf8').length, 3);
});

test('a read is never retried on 401, 403, 404 or 422', async () => {
  for (const status of ['401', '403', '404', '422']) {
    const file = counterFile();
    const result = await runHostCall(run('status', [file, status], { args: [SCRIPT, 'status', file, status, '{}', '-i'] }), options({ retry: noSleep }));
    assert.equal(readFileSync(file, 'utf8').length, 1, status);
    assert.equal(result.http?.status, Number(status));
  }
});

test('a non-zero exit with nothing structured is retried; with a structured 4xx body it is not', async () => {
  const plain = counterFile();
  const result = await runHostCall(run('plain-fail', [plain]), options({ retry: noSleep }));
  assert.equal(result.reason, 'unreachable');
  assert.equal(readFileSync(plain, 'utf8').length, 3);
  const structured = { exitCode: 1, stdout: '{"status":"404"}', stderrFirstLine: '', http: null, truncated: false, durationMs: 1 } satisfies HostResult;
  assert.equal(isRetryable(structured, 'gh'), false);
  assert.equal(isRetryable({ ...structured, exitCode: 4, stdout: '' }, 'gh'), false);
  assert.equal(isRetryable({ ...structured, exitCode: null, stdout: '', reason: 'timeout' }, 'gh'), true);
});

test('a Retry-After up to 60 s is waited for; a longer one opens the breaker and stops', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const breaker = new HostRateLimiter(db);
  const waits: number[] = [];
  const file = counterFile();
  const short = JSON.stringify({ 'retry-after': '7' });
  await runHostCall(run('status', [file, '502'], { args: [SCRIPT, 'status', file, '502', short, '-i'] }), options({ retry: { random: () => 0.5, sleep: async (ms: number) => void waits.push(ms) } }));
  assert.deepEqual(waits, [7000, 7000]);

  const long = JSON.stringify({ 'retry-after': '600' });
  const longFile = counterFile();
  await runHostCall(run('status', [longFile, '502'], { args: [SCRIPT, 'status', longFile, '502', long, '-i'] }), options({ retry: noSleep, breaker }));
  assert.equal(readFileSync(longFile, 'utf8').length, 1);
  assert.equal(breaker.check('github.com').open, true);
});

// ---------- the breaker ----------

const recordedHeaders = (path: string): Record<string, string> => splitHttpHead(recorded(path)).http?.headers ?? {};

test('the breaker opens on a primary limit from recorded GitHub headers, until the reset, and only for that host', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const headers = recordedHeaders('gh/2.92.0/api-i.out');
  assert.equal(headers['x-ratelimit-limit'], '5000');
  const reset = Number(headers['x-ratelimit-reset']);
  const now = new Date((reset - 600) * 1000);
  const breaker = new HostRateLimiter(db, () => now);

  assert.equal(breaker.record('github.com', 'core', { status: 200, headers }).open, false);
  const state = breaker.record('github.com', 'core', { status: 403, headers: { ...headers, 'x-ratelimit-remaining': '0' } });
  assert.deepEqual(state.open && [state.reason, state.until.getTime()], ['rate-limited', reset * 1000]);
  assert.equal(breaker.check('github.example.com', 'core').open, false);
  assert.equal(breaker.check('github.com', 'search').open, false);
  const later = new HostRateLimiter(db, () => new Date((reset + 1) * 1000));
  assert.equal(later.check('github.com', 'core').open, false);
});

test('any response that reports remaining 0 opens it, even a 200', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const headers = recordedHeaders('gh/2.92.0/api-i.out');
  const now = new Date((Number(headers['x-ratelimit-reset']) - 60) * 1000);
  const breaker = new HostRateLimiter(db, () => now);
  assert.equal(breaker.record('github.com', 'core', { status: 200, headers: { ...headers, 'x-ratelimit-remaining': '0' } }).open, true);
});

test('a secondary limit waits Retry-After, at least 60 s, doubling on each repeat up to 15 min', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  let now = new Date('2026-09-30T18:00:00Z');
  const breaker = new HostRateLimiter(db, () => now);
  const headers = { ...recordedHeaders('gh/2.92.0/api-i.out'), 'retry-after': '10' };
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const state = breaker.record('github.com', 'core', { status: 403, headers });
    assert.ok(state.open);
    waits.push(state.until.getTime() - now.getTime());
    now = new Date(state.until.getTime() + 1);
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  // a response that comes after the block has run out starts the doubling over
  breaker.record('github.com', 'core', { status: 200, headers: recordedHeaders('gh/2.92.0/api-i.out') });
  assert.equal(breaker.record('github.com', 'core', { status: 403, headers }).open && true, true);
  const row = db.prepare('SELECT strikes FROM host_rate_limits WHERE host = ?').get('github.com') as { strikes: number };
  assert.equal(row.strikes, 1);
});

test('GitLab headers: a 429 throttles; a plain 403 with budget left is a permission failure, not a limit', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const headers = recordedHeaders('glab/1.120.0/api_404i.out');
  assert.equal(headers['ratelimit-name'], 'throttle_authenticated_api');
  const now = new Date(Number(headers['ratelimit-reset']) * 1000 - 30_000);
  const breaker = new HostRateLimiter(db, () => now);
  assert.equal(breaker.record('gitlab.com', 'core', { status: 403, headers }).open, false);
  const throttled = breaker.record('gitlab.com', 'core', { status: 429, headers });
  assert.ok(throttled.open);
  assert.equal(throttled.reason, 'slowed-down');
  assert.equal(throttled.until.getTime() - now.getTime(), 60_000);
});

test('the floors: under 50 in GitHub core or graphql, under 5 in search, under 5 % on GitLab, pause background polling only', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const now = new Date('2026-09-30T18:00:00Z');
  const reset = new Date(now.getTime() + 600_000);
  const breaker = new HostRateLimiter(db, () => now);
  breaker.observe('github.com', 'core', { limit: 5000, remaining: 49, resetAt: reset });
  breaker.observe('github.com', 'search', { limit: 30, remaining: 6, resetAt: reset });
  breaker.observe('gitlab.com', 'core', { limit: 2000, remaining: 99, resetAt: reset });
  assert.equal(breaker.backgroundPaused('github.com', 'core'), true);
  assert.equal(breaker.backgroundPaused('github.com', 'search'), false);
  assert.equal(breaker.backgroundPaused('gitlab.com', 'core', 'glab'), true);
  breaker.observe('gitlab.com', 'core', { limit: 2000, remaining: 100, resetAt: reset });
  assert.equal(breaker.backgroundPaused('gitlab.com', 'core', 'glab'), false);
  // the breaker itself stays shut: a person's own action still goes through
  assert.equal(breaker.check('github.com', 'core').open, false);
});

test('the breaker is shared by two DatabaseSync handles on one file', () => {
  const file = join(scratch, 'shared.db');
  const first = new DatabaseSync(file);
  migrate(first);
  const second = new DatabaseSync(file);
  const now = new Date('2026-09-30T18:00:00Z');
  const a = new HostRateLimiter(first, () => now);
  const b = new HostRateLimiter(second, () => now);
  assert.equal(b.check('github.com').open, false);
  a.record('github.com', 'core', { status: 429, headers: { 'retry-after': '90' } });
  const seen = b.check('github.com');
  assert.ok(seen.open);
  assert.equal(seen.until.getTime() - now.getTime(), 90_000);
  first.close();
  second.close();
});

test('a call is refused while the breaker is open, with no process started; the rate-limit probe is exempt', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const breaker = new HostRateLimiter(db);
  breaker.openFor('github.com', 'core', 60_000);
  const file = counterFile();
  const refused = await runHostCall(run('flaky', [file, '0']), options({ breaker }));
  assert.equal(refused.reason, 'slowed-down');
  assert.equal(existsSync(file), false);
  const probe = callOf('gh', ['api', 'rate_limit', '--hostname', 'github.com']);
  const allowed = await runHostCall(probe, options({ breaker, binaryPath: join(scratch, 'none') }));
  assert.equal(allowed.reason, 'cli-missing');
});

// ---------- stdout is data only on success ----------

test('stdout after a non-zero exit is not data: only the structured error fields are read', async () => {
  const result = await spawnHostCall(run('error-body', [counterFile()]), options());
  assert.equal(result.exitCode, 1);
  assert.deepEqual(hostErrorFields(result), { status: 404, errors: [{ code: 'missing', resource: 'Issue', field: 'x' }] });
  assert.equal(reasonOf(result, 'gh'), 'not-found');
  // glab's `{"error":{"message":…}}` is neither data nor a status
  const glab = { exitCode: 1, stdout: '{"error":{"message":"404 Not Found"}}', http: null };
  assert.deepEqual(hostErrorFields(glab), { status: null, errors: [] });
  assert.equal(reasonOf(glab, 'glab'), 'unreachable');
  assert.equal(reasonOf({ exitCode: 4, stdout: '', http: null }, 'gh'), 'auth-failed');
  assert.equal(reasonOf({ exitCode: 0, stdout: '', http: null }, 'gh'), null);
  assert.equal(reasonOf({ exitCode: 1, stdout: '', http: { status: 503, headers: {} } }, 'gh'), 'server-error');
});

// ---------- the rest ----------

test('the limiter admits 4 per CLI, queues the fifth and refuses it after the admission time', async () => {
  const limiter = new HostLimiter({ perCli: 4, admissionMs: 80 });
  const held = await Promise.all([1, 2, 3, 4].map(() => limiter.acquire('gh')));
  assert.equal(limiter.active('gh'), 4);
  await assert.rejects(limiter.acquire('gh'), HostBusyError);
  // another CLI has its own slots
  (await limiter.acquire('glab'))();
  const waiting = new HostLimiter({ perCli: 1, admissionMs: 1000 });
  const first = await waiting.acquire('gh');
  const second = waiting.acquire('gh');
  first();
  first();
  const release = await second;
  assert.equal(waiting.active('gh'), 1);
  release();
  assert.equal(waiting.active('gh'), 0);
  for (const r of held) r();
  assert.equal(limiter.active('gh'), 0);
});

test('a call that waits too long for a slot is busy', async () => {
  const limiter = new HostLimiter({ perCli: 1, admissionMs: 50 });
  const release = await limiter.acquire('gh');
  const result = await runHostCall(run('env', [counterFile()]), options({ limiter }));
  assert.equal(result.reason, 'busy');
  release();
});

test('integers above 2^53 are read as strings, others stay numbers', () => {
  const parsed = parseJson('{"id":9007199254740993,"n":12,"neg":-9007199254740993,"f":1.5,"big":[18446744073709551615],"s":"9007199254740993"}') as Record<string, unknown>;
  assert.equal(parsed.id, '9007199254740993');
  assert.equal(parsed.n, 12);
  assert.equal(parsed.neg, '-9007199254740993');
  assert.equal(parsed.f, 1.5);
  assert.deepEqual(parsed.big, ['18446744073709551615']);
  assert.equal(parsed.s, '9007199254740993');
  assert.throws(() => parseJson('{not json'));
});

test('redaction drops runners_token, job e-mails and hook secrets, and cleans strings', () => {
  const cleaned = redactHostObject({
    id: 1,
    runners_token: 'GR1348941abcdefghijkl',
    commit: { author_email: 'someone@corp.example.org', message: 'ok' },
    hook: { config: { secret: 'shh', url: 'https://x.example/h' } },
    note: 'sent to person@gmail.com with ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  });
  const text = JSON.stringify(cleaned);
  for (const secret of ['GR1348941', 'someone@corp', 'shh', 'person@gmail.com', 'ghp_abcdef']) assert.ok(!text.includes(secret), secret);
  assert.equal((cleaned.hook.config as Record<string, unknown>).url, 'https://x.example/h');
  assert.equal(cleaned.id, 1);
});
