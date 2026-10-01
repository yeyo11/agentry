#!/usr/bin/env node
// Stands in for `copilot --acp`, `gemini --acp` and `opencode acp` in core tests: the Agent Client
// Protocol over stdio, one JSON-RPC message per line. It replays what the recordings under
// recordings/{copilot,gemini,opencode} show (the `initialize` reply, the `session/new` reply, the
// update shapes of a turn, which methods answer -32601) and invents no event of its own.
//
//   --profile copilot|gemini|opencode   which agent to be (every other argument is ignored, as the
//                                       real ones would take --acp, --no-auto-update and the rest)
//   --version                           prints what the recorded `--version` printed
//
//   FAKE_ACP_VERSION=1.0.65|1.0.90      Copilot only: which recorded handshake to answer
//   FAKE_ACP_SIGNED_OUT=1               `session/new` answers -32000, as Gemini recorded; a profile whose
//                                       real agent starts without a credential (OpenCode) is unchanged
//   FAKE_ACP_LOG=<file>                 appends one JSON line per message, `{ dir: 'in' | 'out', line }`,
//                                       and a first `{ dir: 'start', argv, env }`, so a test can read
//                                       what the driver sent and the process was started with
//   FAKE_ACP_STEP_MS=<n>                pause between the steps of a turn (default 2)
//
// What the prompt text scripts, as the Claude fake's does:
//   TURN (or anything else)   thought, a command tool, an edit with a diff, a plan, the answer
//   ASK <kind>                a session/request_permission for a tool of that kind (execute, edit,
//                             delete, fetch, ...; default execute), then the turn goes on by the answer
//   GITPUSH                   a request to run `git push`, as ASK execute with that command
//   ODD                       an agent request the driver does not know (`fake/unknown`); the turn goes
//                             on once it answers, whatever it answered
//   NOISY                     fifty small chunks, and stderr lines the agent logs
//   AUTH                      the prompt fails with -32000, as an agent that lost its credential does
//   HOLD                      one chunk, then nothing until session/cancel
//   CANCEL-WAIT               a permission request held until session/cancel (the driver answers it
//                             `cancelled`), then the prompt ends `cancelled`
// Not scripted, because ACP has nothing to replay for them: STRUCTURED, RATE and DELEGATE.
//
// Where a recording does not show the shape (Gemini's successful `session/new`, the permission
// options, Gemini's session id, the reply of `session/load`), the shape comes from the protocol's
// documented one and the bundle source the plan cites, and is marked "unrecorded" below.

import { appendFileSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const RECORDINGS = fileURLToPath(new URL('./recordings/', import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const profile = flag('--profile') ?? 'copilot';

const PROFILES = {
  copilot: {
    dir: (v) => `copilot/${v}`,
    versions: ['1.0.65', '1.0.90'],
    file: { '1.0.65': 'acp-initialize.jsonl', '1.0.90': 'acp-prompt-with-owner-account-by-accident.jsonl' },
    versionText: { '1.0.65': 'GitHub Copilot CLI 1.0.65.', '1.0.90': 'GitHub Copilot CLI 1.0.90.' },
    methods: ['session/new', 'session/load', 'session/list', 'session/set_mode', 'session/set_config_option', 'session/prompt'],
    extraMethods: { '1.0.90': ['session/close'] },
    newId: () => randomUUID(),
    authMessage: 'Authentication required. Run `copilot login`.',
    titles: true,
    promptUsage: true,
  },
  gemini: {
    dir: () => 'gemini/0.62.0',
    versions: ['0.62.0'],
    file: { '0.62.0': 'acp-initialize.jsonl' },
    versionText: { '0.62.0': '0.62.0' },
    // `session/list` answered -32601 (recorded). The model setter is the bundle's
    // `unstable_setSessionModel` (unrecorded on the wire).
    methods: ['session/new', 'session/load', 'session/set_mode', 'session/set_model', 'session/prompt'],
    extraMethods: {},
    newId: () => randomUUID(),
    authMessage: 'Gemini API key is missing or not configured.',
    titles: false,
    promptUsage: false,
  },
  opencode: {
    dir: () => 'opencode/1.18.34',
    versions: ['1.18.34'],
    file: { '1.18.34': 'acp-initialize.jsonl' },
    versionText: { '1.18.34': '1.18.34' },
    methods: [
      'session/new', 'session/load', 'session/list', 'session/set_mode', 'session/set_config_option',
      'session/prompt', 'session/close', 'session/fork', 'session/resume',
    ],
    extraMethods: {},
    newId: () => `ses_${randomBytes(13).toString('hex').slice(0, 26)}`,
    authMessage: 'Authentication required. Run `opencode auth login`.',
    titles: false,
    promptUsage: false,
  },
};
const spec = PROFILES[profile];
if (!spec) {
  process.stderr.write(`fake-acp-agent: unknown profile ${profile}\n`);
  process.exit(2);
}
const version = process.env.FAKE_ACP_VERSION && spec.versions.includes(process.env.FAKE_ACP_VERSION)
  ? process.env.FAKE_ACP_VERSION
  : spec.versions[spec.versions.length - 1];

if (argv.includes('--version')) {
  process.stdout.write(`${spec.versionText[version]}\n`);
  process.exit(0);
}

const supported = new Set([...spec.methods, ...(spec.extraMethods[version] ?? [])]);
const STEP = Number(process.env.FAKE_ACP_STEP_MS ?? 2);
const LOG = process.env.FAKE_ACP_LOG;
const SIGNED_OUT = process.env.FAKE_ACP_SIGNED_OUT === '1' && profile !== 'opencode';

// What the recording said, read once: the reply to the request with that method.
const recorded = readFileSync(`${RECORDINGS}${spec.dir(version)}/${spec.file[version]}`, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const replyTo = (method) => {
  const req = recorded.find((r) => r.dir === 'in' && r.line.method === method);
  if (!req) return undefined;
  return recorded.find((r) => r.dir === 'out' && r.line.id === req.line.id && r.line.result)?.line.result;
};
const updatesAfterNew = () =>
  recorded
    .filter((r) => r.dir === 'out' && r.line.method === 'session/update' && r.line.params.update.sessionUpdate === 'available_commands_update')
    .slice(0, 1)
    .map((r) => r.line.params.update);

const PERMISSION_OPTIONS = [
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

const log = (dir, line) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ dir, line })}\n`);
};
if (LOG) {
  appendFileSync(
    LOG,
    `${JSON.stringify({ dir: 'start', argv, env: { COPILOT_AUTO_UPDATE: process.env.COPILOT_AUTO_UPDATE ?? null, OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null } })}\n`,
  );
}
const send = (msg) => {
  log('out', msg);
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
};
const notify = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const methodNotFound = (id, method) =>
  send({ id, error: { code: -32601, message: `"Method not found": ${method}`, data: { method } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessions = new Map();
const pendingClient = new Map(); // id of a request we sent -> resolve
let nextRequest = 1000;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequest++;
    pendingClient.set(id, resolve);
    send({ id, method, params });
  });

const sessionNewResult = (id, cwd) => {
  const base = replyTo('session/new');
  if (base) return { ...base, sessionId: id };
  // Gemini's successful reply is unrecorded (it was refused); the bundle source names these fields.
  return {
    sessionId: id,
    modes: {
      availableModes: ['default', 'auto_edit', 'yolo', 'plan'].map((m) => ({ id: m, name: m })),
      currentModeId: 'default',
    },
    models: { availableModels: [{ modelId: 'fake-model', name: 'Fake model' }], currentModelId: 'fake-model' },
  };
};

const textOf = (prompt) =>
  (Array.isArray(prompt) ? prompt : []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');

const toolCall = (kind, extra = {}) => ({
  sessionUpdate: 'tool_call',
  toolCallId: `call_${randomBytes(12).toString('hex')}`,
  status: 'pending',
  kind,
  ...extra,
});

async function runTurn(session, text, reply) {
  const sid = session.id;
  const step = async () => {
    if (STEP > 0) await sleep(STEP);
    return !session.cancelled;
  };
  const end = (stopReason) => {
    const result = { stopReason };
    if (spec.promptUsage && stopReason === 'end_turn') {
      result.usage = { inputTokens: 120, outputTokens: 40, totalTokens: 160, thoughtTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0 };
    }
    reply({ result });
  };
  const chunk = (t) => notify(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
  const script = text.trim().split(/\s+/)[0] ?? '';

  if (script === 'AUTH') return reply({ error: { code: -32000, message: spec.authMessage } });

  if (spec.titles && !session.titled) {
    session.titled = true;
    notify(sid, { sessionUpdate: 'session_info_update', title: text.slice(0, 60), updatedAt: new Date().toISOString() });
  }

  if (script === 'HOLD') {
    chunk('holding');
    while (!session.cancelled) await sleep(10);
    return end('cancelled');
  }

  if (script === 'NOISY') {
    for (let i = 0; i < 50; i++) {
      chunk(`chunk ${i} `);
      if (i % 10 === 0) process.stderr.write(`agent log line ${i}\n`);
      // A line on stdout that is not the protocol, as a CLI that prints a banner would
      if (i === 5) process.stdout.write('agent banner, not json\n');
    }
    return end('end_turn');
  }

  if (script === 'ODD') {
    await ask('fake/unknown', { sessionId: sid });
  }

  notify(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  if (!(await step())) return end('cancelled');

  const wantsPermission = script === 'ASK' || script === 'GITPUSH' || script === 'CANCEL-WAIT';
  if (wantsPermission) {
    const git = script === 'GITPUSH';
    const kind = git || script === 'CANCEL-WAIT' ? 'execute' : (text.trim().split(/\s+/)[1] ?? 'execute');
    const command = git ? 'git push origin main' : 'ls -la';
    const call = toolCall(kind, {
      title: kind === 'execute' ? command : `${kind} a file`,
      rawInput: kind === 'execute' ? { command } : { path: 'notes.txt' },
      ...(kind === 'execute' ? {} : { locations: [{ path: 'notes.txt' }] }),
    });
    notify(sid, call);
    const asked = ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: call.toolCallId, title: call.title, kind, status: 'pending', rawInput: call.rawInput, ...(call.locations ? { locations: call.locations } : {}) },
      options: PERMISSION_OPTIONS,
    });
    const cancelled = new Promise((resolve) => { session.onCancel = () => resolve('cancelled'); });
    const answer = await Promise.race([asked, cancelled]);
    session.onCancel = undefined;
    // A cancelled turn is ended by us once the driver answered (or we saw the cancel).
    const outcome = answer === 'cancelled' ? 'cancelled' : (answer?.result?.outcome?.outcome ?? 'error');
    if (outcome === 'cancelled' || session.cancelled) return end('cancelled');
    const optionId = answer?.result?.outcome?.optionId;
    const allowed = PERMISSION_OPTIONS.find((o) => o.optionId === optionId)?.kind?.startsWith('allow');
    notify(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: call.toolCallId,
      status: allowed ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: allowed ? 'done' : 'rejected by the user' } }],
      rawOutput: { content: allowed ? 'done' : 'rejected by the user' },
    });
    chunk(allowed ? 'It ran. ' : 'It was refused. ');
    return end('end_turn');
  }

  // A plain turn: a command tool, an edit with a diff, a plan, the answer.
  const run = toolCall('execute', { title: 'echo hello', rawInput: { command: 'echo hello' } });
  notify(sid, run);
  notify(sid, { sessionUpdate: 'tool_call_update', toolCallId: run.toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hello' } }], rawOutput: { content: 'hello' } });
  if (!(await step())) return end('cancelled');
  const edit = toolCall('edit', {
    title: 'edit notes.txt',
    rawInput: { path: 'notes.txt', file_text: 'hello\n' },
    locations: [{ path: 'notes.txt' }],
    content: [{ type: 'diff', path: 'notes.txt', oldText: '', newText: 'hello\n' }],
  });
  notify(sid, edit);
  notify(sid, { sessionUpdate: 'plan', entries: [{ content: 'Write notes.txt', priority: 'medium', status: 'completed' }] });
  notify(sid, { sessionUpdate: 'tool_call_update', toolCallId: edit.toolCallId, status: 'completed', content: [{ type: 'diff', path: 'notes.txt', oldText: '', newText: 'hello\n' }], rawOutput: { content: 'ok' } });
  notify(sid, { sessionUpdate: 'usage_update', used: 1200, size: 128000 });
  if (!(await step())) return end('cancelled');
  chunk('Done. ');
  chunk(`You said: ${text}`);
  return end('end_turn');
}

function handle(msg) {
  const { id, method, params } = msg;
  const ok = (result) => send({ id, result });

  if (method === 'initialize') return ok(replyTo('initialize'));
  if (method === 'session/cancel') {
    const s = sessions.get(params?.sessionId);
    if (s) {
      s.cancelled = true;
      s.onCancel?.();
    }
    return;
  }
  if (id === undefined) return; // any other notification
  if (!supported.has(method)) return methodNotFound(id, method);

  if (method === 'session/new') {
    if (SIGNED_OUT) return send({ id, error: { code: -32000, message: spec.authMessage } });
    if (profile === 'gemini') {
      process.stderr.write('Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.\n');
    }
    const sid = spec.newId();
    sessions.set(sid, { id: sid, cwd: params?.cwd, createdAt: new Date().toISOString() });
    ok(sessionNewResult(sid, params?.cwd));
    for (const u of updatesAfterNew()) notify(sid, u);
    return;
  }

  const sid = params?.sessionId;
  const needSession = () => {
    const s = sessions.get(sid);
    if (!s) send({ id, error: { code: -32602, message: `Session not found: ${sid}` } });
    return s;
  };

  switch (method) {
    case 'session/load':
    case 'session/resume': {
      if (SIGNED_OUT) return send({ id, error: { code: -32000, message: spec.authMessage } });
      // A load replays the history as updates before it answers (ACP); the driver drops them. An
      // unknown id is accepted: the real agents' stores are on disk, which the fake does not have.
      const s = sessions.get(sid) ?? { id: sid, cwd: params?.cwd, createdAt: new Date().toISOString() };
      sessions.set(sid, s);
      if (method === 'session/load') {
        notify(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed prompt' } });
        notify(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed answer' } });
      }
      return ok(sessionNewResult(sid, s.cwd));
    }
    case 'session/fork': {
      // As a load does, a source this process has not seen is accepted: the real stores are on disk
      const forked = spec.newId();
      sessions.set(forked, { id: forked, cwd: params?.cwd, createdAt: new Date().toISOString() });
      return ok({ ...sessionNewResult(forked, params?.cwd) });
    }
    case 'session/close':
      sessions.delete(sid);
      return ok({});
    case 'session/list':
      return ok({
        sessions: [...sessions.values()].map((s) => ({ sessionId: s.id, cwd: s.cwd, title: `New session - ${s.createdAt}`, updatedAt: s.createdAt })),
      });
    case 'session/set_mode': {
      if (!needSession()) return;
      notify(sid, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
      return ok({});
    }
    case 'session/set_model':
      if (!needSession()) return;
      return ok({});
    case 'session/set_config_option': {
      if (!needSession()) return;
      const options = (replyTo('session/new')?.configOptions ?? []).map((o) =>
        o.id === params.configId ? { ...o, currentValue: params.value } : o,
      );
      return ok({ configOptions: options });
    }
    case 'session/prompt': {
      const s = needSession();
      if (!s) return;
      s.cancelled = false;
      void runTurn(s, textOf(params.prompt), (r) => send({ id, ...r }));
      return;
    }
    default:
      return methodNotFound(id, method);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  log('in', msg);
  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = pendingClient.get(msg.id);
    pendingClient.delete(msg.id);
    resolve?.(msg);
    return;
  }
  handle(msg);
});
rl.on('close', () => {
  if (profile === 'copilot') process.stderr.write('Received EOF on stdin, shutting down\n');
  process.exit(0);
});
