#!/usr/bin/env node
// Stands in for `claude -p --permission-prompt-tool stdio` in the control protocol tests. It speaks
// the protocol the way CLI 2.1 was observed to: questions go out as `can_use_tool` control requests,
// an interrupt withdraws the pending one and ends the turn with `error_during_execution` while the
// process stays up, and a mode switch is echoed as a `system/status` event.
//
//   ASK <tool>     asks permission for <tool> and ends the turn with the decision it got back
//   REPLAY <file>  writes each JSON line of <file> to stdout, then ends the turn
//   (anything)     ends the turn at once
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID();
// Reports `manual` the way the real CLI does, as `default`
const reported = (m) => (m === 'manual' ? 'default' : m);
let mode = flag('--permission-mode') ?? 'manual';
/** The permission request this turn is blocked on */
let pending = null;

const result = (text, extra = {}) =>
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: text, ...extra });
const respond = (requestId, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.type === 'user') {
    const content = msg.message?.content;
    const prompt = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n');
    out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'fake', permissionMode: reported(mode), tools: [], argv: args });
    const replay = /^REPLAY (\S+)/.exec(prompt);
    if (replay) {
      for (const line of readFileSync(replay[1], 'utf8').split('\n')) if (line.trim()) process.stdout.write(`${line}\n`);
      return result('replayed');
    }
    const ask = /^ASK (\S+)/.exec(prompt);
    if (!ask) return result(`args=${args.join(' ')}`);
    if (!args.includes('--permission-prompt-tool')) return result('denied: nobody to ask');
    pending = randomUUID();
    const tool = ask[1];
    out({
      type: 'control_request',
      request_id: pending,
      request: {
        subtype: 'can_use_tool',
        tool_name: tool,
        input: tool === 'AskUserQuestion' ? { questions: [{ question: 'Color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] } : { command: 'ls' },
        tool_use_id: 'toolu_fake',
        description: `wants ${tool}`,
        permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        ...(tool === 'AskUserQuestion' ? { requires_user_interaction: true } : {}),
      },
    });
    return;
  }

  if (msg.type === 'control_response') {
    const response = msg.response ?? {};
    if (response.request_id !== pending) return;
    pending = null;
    return result(`decision=${JSON.stringify(response.response)}`);
  }

  if (msg.type === 'control_request') {
    const request = msg.request ?? {};
    if (request.subtype === 'interrupt') {
      if (pending) out({ type: 'control_cancel_request', request_id: pending });
      respond(msg.request_id, { still_queued: [] });
      if (pending) {
        pending = null;
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.01 });
      }
    } else if (request.subtype === 'set_permission_mode') {
      mode = request.mode;
      respond(msg.request_id, { mode: reported(mode) });
      out({ type: 'system', subtype: 'status', status: null, permissionMode: reported(mode), session_id: sessionId });
    } else if (request.subtype === 'set_model') {
      respond(msg.request_id, undefined);
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported control request subtype: ${request.subtype}` } });
    }
  }
});
