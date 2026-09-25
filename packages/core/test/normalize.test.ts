import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryText, normalizeMessage } from '@agentry/shared';

test('normalizes a stream-json assistant event', () => {
  const entry = normalizeMessage({
    type: 'assistant',
    uuid: 'u1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      model: 'claude-haiku',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  assert.ok(entry);
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.model, 'claude-haiku');
  assert.equal(entry.isSidechain, false);
  assert.deepEqual(entry.blocks.map((b) => b.type), ['text', 'tool_use']); // empty thinking dropped
  assert.equal(entryText(entry), 'hello');
});

test('normalizes tool results, including array content and truncation', () => {
  const entry = normalizeMessage({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out' }], is_error: true },
        { type: 'tool_result', tool_use_id: 't2', content: 'x'.repeat(30_000) },
      ],
    },
  });
  assert.ok(entry);
  const [first, second] = entry.blocks;
  assert.deepEqual(first, { type: 'tool_result', toolUseId: 't1', content: 'out', isError: true });
  assert.ok(second?.type === 'tool_result' && second.content.endsWith('[truncated]') && second.content.length < 21_000);
});

test('flags subagent messages and skips non-messages', () => {
  const side = normalizeMessage({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: 'hi' } });
  assert.equal(side?.isSidechain, true);
  assert.equal(side?.parentToolUseId, 'toolu_1');
  assert.equal(normalizeMessage({ type: 'system', subtype: 'init' }), null);
  assert.equal(normalizeMessage({ type: 'user', isMeta: true, message: { content: 'x' } }), null);
  assert.equal(normalizeMessage({ type: 'user', message: { content: '' } }), null);
});

test("reads a slash command's output, which the CLI writes as a system line", () => {
  const content = '<local-command-stdout>## Context Usage\n\n**Tokens:** 11.8k</local-command-stdout>';
  const entry = normalizeMessage({ type: 'system', subtype: 'local_command', uuid: 'c1', timestamp: '2026-09-25T18:13:43.794Z', isSidechain: false, isMeta: false, content });
  assert.ok(entry);
  assert.equal(entry.role, 'user');
  assert.equal(entry.uuid, 'c1');
  assert.equal(entry.model, null);
  assert.equal(entryText(entry), content);
  assert.equal(normalizeMessage({ type: 'system', subtype: 'local_command', content: '' }), null);
  assert.equal(normalizeMessage({ type: 'system', subtype: 'local_command', isMeta: true, content }), null);
});
