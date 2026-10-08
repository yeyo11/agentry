#!/usr/bin/env node
// Stands in for `claude -p --input-format stream-json` in the message-delivery audit
// (docs/reports/chat-audit/server.md). It keeps the queue the real CLI keeps, as its own transcripts
// show it (`queue-operation` lines): a user message that arrives while a turn runs is enqueued, and
// when the turn ends, or an interrupt ends it, every queued message is dequeued and read as one
// prompt, their texts joined by a newline.
//
//   HOLD <file>      the turn emits nothing until <file> exists, then answers and ends
//   SILENT <file>    the same, but the turn first streams a `message_start` partial, the way a turn
//                    that is thinking looks before its first whole message
//   (anything)       the turn answers and ends at once
//
//   FAKE_QUEUE_LOG=<file>   appends one JSON line per thing it did: { op: 'turn', prompt },
//                           { op: 'enqueue', text }, { op: 'control', subtype }, { op: 'eof' }
//   FAKE_LINGER_MS=<ms>     stays up that long after stdin closes, as the CLI does while it finishes
import { appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === 'agents') {
  process.stdout.write('[]\n');
  process.exit(0);
}
if (args[0] === '--version') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write('{"loggedIn":false}\n');
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID();
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const log = (entry) => {
  if (process.env.FAKE_QUEUE_LOG) appendFileSync(process.env.FAKE_QUEUE_LOG, `${JSON.stringify(entry)}\n`);
};

/** The turn running now: how to end it early */
let running = null;
const queue = [];
let inputClosed = false;

function startTurn(prompt) {
  log({ op: 'turn', prompt });
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'fake', permissionMode: 'default', tools: [] });
  const hold = /^(HOLD|SILENT) (\S+)/m.exec(prompt);
  let timer = null;
  const finish = (interrupted) => {
    if (timer) clearInterval(timer);
    running = null;
    if (interrupted) {
      out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.01 });
    } else {
      out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `answered: ${prompt}` }] } });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: `answered: ${prompt}` });
    }
    next();
  };
  running = { finish };
  if (!hold) return finish(false);
  if (hold[1] === 'SILENT') out({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { role: 'assistant' } } });
  timer = setInterval(() => {
    if (existsSync(hold[2])) finish(false);
  }, 20);
}

/** What the CLI does once a turn is over: everything queued is read as the next prompt */
function next() {
  if (queue.length > 0) {
    const prompt = queue.splice(0).join('\n');
    setImmediate(() => startTurn(prompt));
    return;
  }
  if (inputClosed) leave();
}

function leave() {
  setTimeout(() => process.exit(0), Number(process.env.FAKE_LINGER_MS ?? 0));
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    const content = msg.message?.content;
    const text = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n');
    if (running) {
      log({ op: 'enqueue', text });
      queue.push(text);
    } else startTurn(text);
    return;
  }
  if (msg.type === 'control_request') {
    const subtype = msg.request?.subtype;
    log({ op: 'control', subtype });
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: subtype === 'interrupt' ? { still_queued: [] } : {} } });
    if (subtype === 'interrupt' && running) running.finish(true);
  }
});
lines.on('close', () => {
  log({ op: 'eof' });
  inputClosed = true;
  if (!running && queue.length === 0) leave();
});
