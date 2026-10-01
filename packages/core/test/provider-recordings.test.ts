import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The Codex, Copilot, Gemini and OpenCode captures come from sandboxed runs, and one Copilot turn
// ran on the owner's account by accident. Like the sentinel for the code hosts' recordings, this
// check is written apart from the scrubbing so a rule that stops matching cannot blind it.
const ROOT = fileURLToPath(new URL('./fixtures/recordings/', import.meta.url));
const FOLDERS = ['codex', 'copilot', 'gemini', 'opencode'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const LEAKS: Array<[string, RegExp]> = [
  ['e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['home path', /\/home\//],
  ['temporary path', /\/tmp\/(?!opencode\b)/],
  ['GitHub token', /\bgh[opsu]_[A-Za-z0-9]{16,}/],
  ['API key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}/],
  ['owner name', /yeyo/i],
];

const recorded = FOLDERS.flatMap((folder) => files(join(ROOT, folder)));

test('the provider recordings are committed', () => {
  assert.ok(recorded.length > 50, `only ${recorded.length} files under ${FOLDERS.join(', ')}`);
  for (const folder of ['codex/0.159.3', 'copilot/1.0.65', 'copilot/1.0.90', 'gemini/0.62.0', 'opencode/1.18.34'])
    assert.ok(statSync(join(ROOT, folder)).isDirectory(), folder);
});

test('no provider recording carries a path, an account, an e-mail or a token', () => {
  const found: string[] = [];
  for (const file of recorded) {
    const text = readFileSync(file, 'utf8');
    for (const [kind, pattern] of LEAKS) {
      const match = pattern.exec(text);
      if (match) found.push(`${relative(ROOT, file)}: ${kind}: ${match[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(found, []);
});

test('the accidental Copilot turn keeps its event shapes and none of its text', () => {
  type Update = { sessionUpdate: string; content?: { text?: string } };
  const lines = readFileSync(join(ROOT, 'copilot/1.0.90/acp-prompt-with-owner-account-by-accident.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { line: { params?: { update?: Update } } }).line.params?.update);
  const chunks = lines.filter((u): u is Update => !!u && /^agent_(message|thought)_chunk$/.test(u.sessionUpdate));
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) assert.equal(chunk.content?.text, '<text>');
  const kinds = new Set(lines.map((u) => u?.sessionUpdate));
  for (const kind of ['tool_call', 'tool_call_update', 'usage_update', 'session_info_update']) assert.ok(kinds.has(kind), kind);
});
