import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { entryText } from '@agentry/shared';
import { followUpsOf } from '../src/handoff.ts';
import { Core } from '../src/index.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

// A message the CLI takes into the turn it is running is written only as an `attachment` line of type
// `queued_command` (docs/chat-delivery.md). Every reader of the transcript has to see it as the
// person's message: the page, the export, the search and the handoff of a move.

const FAKE_QUEUE = fileURLToPath(new URL('./fixtures/fake-claude-queue.mjs', import.meta.url));
const SESSION = '5d2c8f1a-3b7e-4c09-8a61-2f4e9d0b7c35';
const SENT_AS = '9a3e7c51-6d2b-4f08-b1e4-7c5a2d9f0e63';

/** A transcript in the shape CLI 2.1 writes when a stream-json message arrives during a tool call (ids and text replaced). */
function withAbsorbedMessage() {
  const config = { ...tempConfig(), claudeBin: FAKE_QUEUE };
  const cwd = join(config.workspaceDir, 'project');
  mkdirSync(cwd, { recursive: true });
  const dir = join(config.projectsDir, encodeProjectId(cwd));
  mkdirSync(dir, { recursive: true });
  const at = '2026-10-08T11:36:19.088Z';
  const sessionId = SESSION;
  const lines = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId, content: 'tidy the scripts' },
    { type: 'queue-operation', operation: 'dequeue', timestamp: at, sessionId },
    { type: 'user', uuid: 'u1', timestamp: at, cwd, sessionId, message: { role: 'user', content: 'tidy the scripts' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at, cwd, sessionId, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls scripts' } }] } },
    { type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId, content: 'also list the lint rules' },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: at, cwd, sessionId, message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'a.sh', is_error: false }] } },
    {
      parentUuid: 'u2',
      isSidechain: false,
      attachment: { type: 'queued_command', prompt: 'also list the lint rules', source_uuid: SENT_AS, delivery_id: 'd1', commandMode: 'prompt', timestamp: at },
      type: 'attachment',
      uuid: 'q1',
      timestamp: at,
      sessionId,
      cwd,
    },
    { type: 'queue-operation', operation: 'remove', timestamp: at, sessionId, content: 'also list the lint rules', reason: 'absorbed_mid_turn', commandUuid: SENT_AS },
    { type: 'assistant', uuid: 'a2', parentUuid: 'q1', timestamp: at, cwd, sessionId, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Scripts tidied; the lint rules are in .eslintrc.' }] } },
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  const core = new Core(config);
  return {
    core,
    close: () => {
      core.shutdown();
      rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
    },
  };
}

test('a message read mid-turn is in the transcript where the agent read it, under the id it was sent with', async () => {
  const { core, close } = withAbsorbedMessage();
  try {
    const detail = await core.chats.detail(SESSION);
    const said = detail.entries.map((e) => `${e.role}:${e.uuid}`);
    assert.deepEqual(said, ['user:u1', 'assistant:a1', 'user:u2', `user:${SENT_AS}`, 'assistant:a2']);
    const entry = detail.entries.find((e) => e.uuid === SENT_AS);
    assert.ok(entry && entryText(entry) === 'also list the lint rules');
  } finally {
    close();
  }
});

test('the export of a chat holds a message read mid-turn', async () => {
  const { core, close } = withAbsorbedMessage();
  try {
    const exported = await core.chats.export(SESSION);
    assert.ok(exported.entries.some((e) => e.role === 'user' && entryText(e) === 'also list the lint rules'));
  } finally {
    close();
  }
});

test('the search of a chat finds a message read mid-turn', async () => {
  const { core, close } = withAbsorbedMessage();
  try {
    const found = await core.chats.search(SESSION, 'lint rules');
    // The message itself and the answer that names it
    assert.equal(found.hits.length, 2);
  } finally {
    close();
  }
});

test('the handoff of a move carries what the person said mid-turn', async () => {
  const { core, close } = withAbsorbedMessage();
  try {
    const exported = await core.chats.export(SESSION);
    assert.deepEqual(followUpsOf(exported.entries), ['also list the lint rules']);
  } finally {
    close();
  }
});

test('the handoff leaves out the lines the CLI writes as the person', () => {
  const entry = (text: string, uuid: string) => ({ uuid, role: 'user' as const, timestamp: null, model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'text' as const, text }] });
  const entries = [
    entry('fix the build', 'u1'),
    entry('[Request interrupted by user]', 'u2'),
    entry('<local-command-stdout>ok</local-command-stdout>', 'u3'),
    entry('and the tests', 'u4'),
  ];
  assert.deepEqual(followUpsOf(entries), ['and the tests']);
});
