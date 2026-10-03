import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHandoff, HANDOFF_MAX_BYTES, HANDOFF_SECTIONS, type HandoffInput } from '../src/handoff.ts';
import { PASTED_NOTE } from '../src/prompt-rules.ts';

const base = (over: Partial<HandoffInput> = {}): HandoffInput => ({
  prompt: 'Add a retry to the uploader',
  steps: [{ path: 'src/up.ts', tool: 'Edit', additions: 3, deletions: 1, created: false, intent: 'Wrap the call in a retry loop.' }],
  commands: [{ command: 'pnpm test', exitCode: 1 }],
  checklist: [{ text: 'write the retry', done: true }, { text: 'cover it with a test', done: false }],
  gitStatus: ' M src/up.ts',
  gitDiffStat: ' src/up.ts | 4 +++-',
  lastMessage: 'The retry is in; the test is next.',
  openItems: ['cover it with a test'],
  closing: 'Do not push.',
  agent: null,
  target: { subagents: true },
  ...over,
});

const ID = 'abcdef01';
const OPEN = `<pasted_content id="${ID}">`;
const CLOSE = `</pasted_content id="${ID}">`;

test('the handoff has the five sections, in order, and the pasted note after the block', () => {
  const h = buildHandoff(base(), ID);
  assert.deepEqual(h.sections, Object.values(HANDOFF_SECTIONS));
  for (const s of h.sections) assert.ok(h.text.includes(`## ${s}\n`));
  assert.ok(h.text.trimEnd().endsWith(PASTED_NOTE));
  assert.equal(h.bytes, Buffer.byteLength(h.text));
});

test('transcript text sits only inside the pasted block', () => {
  const h = buildHandoff(base(), ID);
  const from = h.text.indexOf(OPEN);
  const to = h.text.indexOf(CLOSE);
  const block = h.text.slice(from, to);
  const outside = h.text.slice(0, from) + h.text.slice(to);
  for (const needle of ['Add a retry to the uploader', 'src/up.ts', 'pnpm test', 'The retry is in', 'Do not push']) {
    assert.ok(block.includes(needle), needle);
    assert.ok(!outside.includes(needle), `${needle} leaked outside`);
  }
});

test('a secret in a command or a message is masked', () => {
  const h = buildHandoff(base({ commands: [{ command: 'curl -H "Authorization: Bearer sk-abc123def456ghi789" x', exitCode: 0 }], lastMessage: 'API_KEY=supersecretvalue1' }), ID);
  assert.ok(!h.text.includes('sk-abc123def456ghi789'));
  assert.ok(!h.text.includes('supersecretvalue1'));
  assert.ok(h.text.includes('[redacted]'));
});

test('only the last 20 commands are kept, with their exit code', () => {
  const commands = Array.from({ length: 30 }, (_, i) => ({ command: `cmd-${i}`, exitCode: i }));
  const h = buildHandoff(base({ commands }), ID);
  assert.ok(!h.text.includes('`cmd-9` '));
  assert.ok(h.text.includes('`cmd-10` → exit 10'));
  assert.ok(h.text.includes('`cmd-29` → exit 29'));
});

test('the 12 KiB cap keeps every section header', () => {
  const big = 'x'.repeat(40_000);
  const h = buildHandoff(base({ prompt: big, lastMessage: big, gitStatus: big, closing: big, openItems: Array.from({ length: 500 }, (_, i) => `item ${i} ${'y'.repeat(200)}`) }), ID);
  assert.ok(h.bytes <= HANDOFF_MAX_BYTES, String(h.bytes));
  for (const s of h.sections) assert.ok(h.text.includes(`## ${s}\n`));
  assert.ok(h.text.includes(CLOSE));
  assert.ok(h.text.includes('[cut]'));
});

test('a multi-byte text is cut without a broken character', () => {
  const h = buildHandoff(base({ prompt: '😀'.repeat(20_000) }), ID);
  assert.ok(h.bytes <= HANDOFF_MAX_BYTES);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(h.text));
});

test('an agent file is inlined when the target lacks subagents, and only then', () => {
  const agent = { name: 'developer', prompt: 'You implement items carefully.' };
  assert.ok(buildHandoff(base({ agent, target: { subagents: false } }), ID).text.includes('You implement items carefully.'));
  assert.ok(!buildHandoff(base({ agent, target: { subagents: true } }), ID).text.includes('You implement items carefully.'));
});
