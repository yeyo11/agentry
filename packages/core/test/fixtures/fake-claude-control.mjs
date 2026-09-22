#!/usr/bin/env node
// Stands in for `claude -p --permission-prompt-tool stdio` in the control protocol tests. It speaks
// the protocol the way CLI 2.1 was observed to: questions go out as `can_use_tool` control requests,
// an interrupt withdraws the pending one and ends the turn with `error_during_execution` while the
// process stays up, and a mode switch is echoed as a `system/status` event.
//
//   ASK <tool>     asks permission for <tool> and ends the turn with the decision it got back
//   BASH <command> starts that shell command and never answers it, like one that hangs
//   SLEEP <seconds> runs `sleep` as a real child process tree (`sh -c 'sleep N & wait $!'`) for a Bash call,
//                  reports a heartbeat for it, and answers the call with an error result when the tree
//                  is killed, or a plain one when it ends: what a hung command a person cancels looks like.
//                  `wait $!`, not a bare `wait`: that one returns 0 whatever its child died of, so a
//                  `sleep` killed before its shell made the shell exit cleanly and the call look done
//   REPLAY <file>  writes each JSON line of <file> to stdout, then ends the turn
//   … scriptPath "<file>" …  runs that workflow script as the Workflow tool would, with agents that
//                  answer "done:<label>" (or nothing, for a task whose prompt says FAIL-ONCE on a
//                  first run), and writes its record to $FAKE_WORKFLOW_DIR/<session>.json
//   (anything)     ends the turn at once
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
// $FAKE_CLAUDE_SPAWNS names a file each start appends `<pid> <argv>` to, so a test can read the flags a chat was given
if (process.env.FAKE_CLAUDE_SPAWNS) appendFileSync(process.env.FAKE_CLAUDE_SPAWNS, `${process.pid} ${args.join(' ')}\n`);
// Core lists the CLI's own sessions with this; without an answer it waits for stdin to close.
// $FAKE_CLAUDE_AGENTS names a file holding what `agents --json` should report, which is how a test
// puts a session in a terminal that Agentry knows nothing about
if (args[0] === 'agents') {
  process.stdout.write(process.env.FAKE_CLAUDE_AGENTS ? readFileSync(process.env.FAKE_CLAUDE_AGENTS, 'utf8') : '[]\n');
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
// Like the CLI (2.1.278), `--session-id` names the session, a fork's copy included; a fork given no
// id makes up its own, and a plain resume keeps the one it resumes
const sessionId = flag('--session-id') ?? (args.includes('--fork-session') ? randomUUID() : (flag('--resume') ?? randomUUID()));
// Reports `manual` the way the real CLI does, as `default`
const reported = (m) => (m === 'manual' ? 'default' : m);
let mode = flag('--permission-mode') ?? 'manual';
/** The permission request this turn is blocked on */
let pending = null;

// The real CLI reports the window of every model that answered, variant suffix included
const modelUsage = { 'claude-opus-5[1m]': { inputTokens: 1, outputTokens: 1, costUSD: 0.01, contextWindow: 1_000_000 } };
const result = (text, extra = {}) =>
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, modelUsage, result: text, ...extra });
const respond = (requestId, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.type === 'user') {
    const content = msg.message?.content;
    const prompt = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n');
    out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'fake', permissionMode: reported(mode), tools: [], argv: args });
    const script = /scriptPath "([^"]+)"/.exec(prompt);
    if (script) {
      // As CLI 2.1 does in -p: the tool runs in the background, so the turn ends at once and a
      // second one reports once the workflow's notification arrives
      runWorkflow(script[1], /resumeFromRunId "([^"]+)"/.exec(prompt)?.[1] ?? null).then(
        (text) => result(text),
        (err) => result(`workflow failed: ${err.message}`),
      );
      return result('Workflow is running (Task ID: fake). Waiting for completion notification.');
    }
    const bash = /^BASH (.+)$/m.exec(prompt);
    if (bash) {
      out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_bash_${randomUUID()}`, name: 'Bash', input: { command: bash[1] } }] } });
      return;
    }
    const sleep = /^SLEEP (\d+)/m.exec(prompt);
    if (sleep) {
      const id = `toolu_sleep_${randomUUID()}`;
      out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `sleep ${sleep[1]}` } }] } });
      // Its own process group, so that the fake going away takes the tree with it and no test leaves a `sleep` behind
      const child = spawn('sh', ['-c', `sleep ${sleep[1]} & wait $!`], { stdio: 'ignore', detached: true });
      const reap = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      };
      process.once('SIGTERM', () => {
        reap();
        process.exit(143);
      });
      process.once('exit', reap);
      out({ type: 'tool_progress', tool_use_id: id, tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 90, heartbeat: true });
      child.on('exit', (code, signal) => {
        const failed = signal !== null || code !== 0;
        out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: failed ? `Exit code ${code ?? 143}` : 'done', is_error: failed }] } });
        result(failed ? 'carried on after the command failed' : 'the command finished');
      });
      return;
    }
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

/** Runs a workflow script the way the Workflow tool does, reporting progress on the stream. */
async function runWorkflow(path, resumeFrom) {
  const source = readFileSync(path, 'utf8');
  const body = source.replace(/export const meta =/, 'const meta =');
  const taskId = `wf-task-${Math.floor(process.hrtime()[1] % 100000)}`;
  const agents = [];
  const progress = () => out({ type: 'system', subtype: 'task_progress', task_id: taskId, workflow_progress: agents.map((a) => ({ type: 'workflow_agent', ...a })) });
  out({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: 'local_workflow', workflow_name: 'fake', description: 'fake workflow' });
  await new Promise((r) => setTimeout(r, 20)); // after the turn that launched it has ended
  const agent = async (prompt, opts = {}) => {
    const entry = { index: agents.length + 1, label: opts.label ?? `agent-${agents.length + 1}`, state: 'start', agentId: `ag${agents.length}`, model: opts.model ?? null };
    agents.push(entry);
    progress();
    await new Promise((r) => setTimeout(r, 5));
    if (prompt.includes('FAIL-ONCE') && !resumeFrom) {
      entry.state = 'error';
      progress();
      return null;
    }
    entry.state = 'done';
    entry.resultPreview = `done:${entry.label}`;
    progress();
    return `done:${entry.label}${opts.model ? ` (${opts.model})` : ''}`;
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const returned = await new AsyncFunction('agent', 'phase', 'log', body)(agent, () => {}, () => {});
  const runId = resumeFrom ?? 'wf_fake-001';
  writeFileSync(`${process.env.FAKE_WORKFLOW_DIR}/${sessionId}.json`, JSON.stringify({ runId, taskId, status: 'completed', result: returned }));
  out({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', summary: 'fake workflow completed' });
  return `workflow ${runId} completed; args=${args.join(' ')}`;
}
