import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanLine, ERROR_CONTEXT, LINE_CHARS, tailLog, TAIL_LINES } from '../src/hosts/log-tail.ts';

const here = dirname(fileURLToPath(import.meta.url));
const recorded = (path: string): string => readFileSync(join(here, 'fixtures/recordings', path), 'utf8');

test('cleanLine drops the BOM, both renderings of escapes, controls and carriage-return overwrites', () => {
  assert.equal(cleanLine('﻿2026-09-30T15:22:05Z Current runner version'), '2026-09-30T15:22:05Z Current runner version');
  assert.equal(cleanLine('^[[31;1mERROR: boom^[[0;m'), 'ERROR: boom');
  assert.equal(cleanLine('\x1b[0K\x1b[32;1m$ echo hi\x1b[0;m'), '$ echo hi');
  assert.equal(cleanLine('50%\r75%\r100% done\x07'), '100% done');
  assert.equal(cleanLine('a\x00b\tc'), 'ab\tc');
});

test('a recorded GitHub job log (UNKNOWN STEP labels) keeps its end and an error window', () => {
  const raw = recorded('gh/2.102.0/rest-job-log-allow.out');
  assert.ok(raw.split('\n').length > TAIL_LINES);
  const tail = tailLog(raw, { state: 'failed' });
  assert.equal(tail.status, 'lines');
  assert.equal(tail.truncated, true);
  assert.ok(tail.lines.every((line) => line.length <= LINE_CHARS));
  assert.ok(tail.lines.every((line) => !line.includes('﻿') && !line.includes('^[')));
  assert.ok(tail.lines.some((line) => line.includes('##[error]')));
  assert.equal(tail.lines[0], '…');
  assert.ok(tail.lines.length <= TAIL_LINES + 3 * (2 * ERROR_CONTEXT + 2) + 1);
});

test('GitHub layout markers leave the tail, a marker-only line goes with them, and ##[error] stays', () => {
  const raw = [
    '2026-10-01T09:50:01.1234567Z \x1b[36;1m##[group]Run pnpm test\x1b[0m',
    '2026-10-01T09:50:02.1234567Z ##[command]node --test',
    '2026-10-01T09:50:03.1234567Z ##[endgroup]',
    '2026-10-01T09:50:11.1234567Z \x1b[31;1m##[error]Process completed with exit code 1.\x1b[0m',
  ].join('\n');
  assert.deepEqual(tailLog(raw, { state: 'failed' }).lines, [
    '2026-10-01T09:50:01.1234567Z Run pnpm test',
    '2026-10-01T09:50:02.1234567Z node --test',
    '2026-10-01T09:50:11.1234567Z ##[error]Process completed with exit code 1.',
  ]);
});

test('a recorded GitLab trace loses its section markers and ANSI, and keeps the error line', () => {
  const tail = tailLog(recorded('glab/1.120.0/api_trace.out'), { state: 'failed' });
  assert.equal(tail.status, 'lines');
  const text = tail.lines.join('\n');
  assert.ok(!text.includes('section_start'));
  assert.ok(!text.includes('section_end'));
  assert.ok(!text.includes('^['));
  assert.match(text, /ERROR: Job failed/);
});

test('a log of 3 000 lines keeps 200 and the windows around the first three errors only', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
  for (const at of [100, 900, 1500, 2000]) lines[at] = `##[error]failure at ${at}`;
  const tail = tailLog(lines.join('\n'), { state: 'failed' });
  const text = tail.lines.join('\n');
  assert.ok(text.includes('line 2999'));
  for (const at of [100, 900, 1500]) assert.ok(text.includes(`failure at ${at}`));
  assert.ok(!text.includes('failure at 2000'));
  assert.ok(!text.includes('line 500'));
  assert.ok(tail.truncated);
});

test('lines are cut at 500 characters and redacted', () => {
  const tail = tailLog(`${'x'.repeat(900)}\ntoken ghp_${'a'.repeat(36)}`);
  assert.equal(tail.lines[0]?.length, LINE_CHARS);
  assert.ok(!tail.lines.join('\n').includes('ghp_aaaa'));
});

test('a running job whose trace lags (recorded preamble only) reads as no output yet', () => {
  assert.deepEqual(tailLog(recorded('glab/1.120.0/trace_running1.out'), { state: 'running' }), {
    lines: [],
    truncated: false,
    status: 'no-output-yet',
  });
  const later = tailLog(recorded('glab/1.120.0/trace_running4.out'), { state: 'running' });
  assert.equal(later.status, 'lines');
  assert.ok(later.lines.join('\n').includes('probe tick 11'));
});

test('a manual job’s empty trace reads as no output yet, a finished empty one does not', () => {
  assert.equal(tailLog(recorded('glab/1.120.0/trace_manual.out'), { state: 'manual' }).status, 'no-output-yet');
  assert.deepEqual(tailLog('', { state: 'passed' }), { lines: [], truncated: false, status: 'lines' });
});
