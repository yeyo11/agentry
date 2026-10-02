#!/usr/bin/env node
// Stands in for `codex app-server` in driver tests. It replays what was recorded from codex-cli 0.159.3
// (fixtures/recordings/codex/0.159.3): the replies to initialize, model/list, config/read,
// thread/start and permissionProfile/list are the recorded ones with the ids, the paths and the model
// swapped in; every other shape is the one in the generated protocol types next to them. It invents
// no event the protocol does not have. Like the real one it omits `jsonrpc` on what it sends, adds
// `emittedAtMs` to notifications, and exits 0 when stdin closes, even with a turn running.
//
// What a turn does is scripted by the first word of the prompt, as the Claude fake's is:
//
//   TURN (or anything else)   reasoning, a streamed answer `reply: <prompt>`, usage, rate limits
//   ASK <kind>                an approval the person answers: command | file | permissions | input.
//                             accept / acceptForSession run it, decline declines it, cancel ends the turn
//                             interrupted
//   GITPUSH                   an approval for `git push origin HEAD`, as ASK command
//   ODD                       a server request the driver does not know, then the turn goes on
//   STRUCTURED [json]         with outputSchema, the answer is that JSON (or {"ok":true}), streamed
//   RATE                      the account's usage limit: rateLimits/updated, then the turn fails
//   NOISY                     a line that is not JSON, ERROR lines on stderr, an unknown notification,
//                             a retried error and a warning, then an ordinary turn
//   DELEGATE                  a collabAgentToolCall that spawns an agent
//   AUTH                      the recorded signed-out turn: 401 retries, then the turn fails
//   HANG                      the recorded reconnect error, then nothing until turn/interrupt
//
// Environment:
//   FAKE_CODEX_SIGNED_OUT=1   account/read answers the recorded signed-out reply, rate limits refuse
//   FAKE_CODEX_PLAN=<plan>    the chatgpt plan type of the signed-in account (default plus)
//   FAKE_CODEX_USED=<percent> the primary window's use that account/rateLimits/read answers (default 30)
//   FAKE_CODEX_API_KEY=1     the signed-in account is an API key
//   FAKE_CODEX_STATE=<file>   keeps the threads there, so thread/resume and thread/fork work across
//                             processes; defaults to <CODEX_HOME>/fake-threads.json when CODEX_HOME
//                             is set, and to memory otherwise
//   FAKE_CODEX_LOG=<file>     appends one JSON line `{ dir, line }` per message in or out
//   FAKE_CODEX_SPAWNS=<file>  appends `<pid> <argv>` and the CODEX_HOME seen, as the Claude fake does
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_SPAWNS)
  appendFileSync(process.env.FAKE_CODEX_SPAWNS, `${JSON.stringify({ pid: process.pid, argv: args, codexHome: process.env.CODEX_HOME ?? null })}\n`);
if (args[0] !== 'app-server') {
  process.stderr.write(`fake codex: ${args.join(' ')} is not part of the fake\n`);
  process.exit(1);
}

const RECORDED = join(dirname(fileURLToPath(import.meta.url)), 'recordings/codex/0.159.3');
const HOME = process.env.CODEX_HOME ?? '<home>/.codex';
const SIGNED_OUT = process.env.FAKE_CODEX_SIGNED_OUT === '1';
const STATE = process.env.FAKE_CODEX_STATE ?? (process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'fake-threads.json') : null);
const LOG = process.env.FAKE_CODEX_LOG;

// The recorded replies, by the method that asked for them.
const recorded = { replies: new Map(), errors: new Map(), notifications: new Map() };
{
  const requests = new Map();
  for (const text of ['app-server-handshake.jsonl', 'app-server-interrupt-and-failed-turn.jsonl', 'app-server-turn-signed-out.jsonl']) {
    for (const row of readFileSync(join(RECORDED, text), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
      const m = row.line;
      if (!m) continue;
      if (row.dir === 'in' && m.id !== undefined) requests.set(m.id, m.method);
      else if (row.dir === 'out' && m.id !== undefined && requests.has(m.id)) {
        const method = requests.get(m.id);
        if (m.error && !recorded.errors.has(method)) recorded.errors.set(method, m.error);
        else if (m.result !== undefined && !recorded.replies.has(method)) recorded.replies.set(method, m.result);
      } else if (row.dir === 'out' && m.method && !recorded.notifications.has(m.method)) recorded.notifications.set(m.method, m.params);
    }
    requests.clear();
  }
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const uuid7 = () => {
  const hex = (Date.now().toString(16).padStart(12, '0') + '7' + randomBytes(9).toString('hex')).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function log(dir, line) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ dir, line })}\n`);
}
function write(message) {
  log('out', message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const reply = (id, result) => write({ id, result });
const fail = (id, code, message) => write({ id, error: { code, message } });
const notify = (method, params) => write({ method, params, emittedAtMs: Date.now() });

let nextServerId = 1;
const pendingServer = new Map();
function ask(method, params) {
  const id = nextServerId++;
  return new Promise((resolve) => {
    pendingServer.set(id, resolve);
    write({ id, method, params });
  });
}

// Threads, kept whole so a later process can resume or fork them.
const threads = new Map();
if (STATE && existsSync(STATE)) for (const t of JSON.parse(readFileSync(STATE, 'utf8'))) threads.set(t.id, t);
const save = () => {
  if (STATE) {
    // A real Codex makes its home as it needs it; the sandbox of a spec only names the directory
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify([...threads.values()]));
  }
};

const SANDBOXES = {
  'read-only': () => ({ type: 'readOnly', networkAccess: false }),
  'workspace-write': () => ({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }),
  'danger-full-access': () => ({ type: 'dangerFullAccess' }),
};
const sandboxPolicy = (mode, cwd) => (SANDBOXES[mode] ?? SANDBOXES['read-only'])(cwd);
const defaultModel = () => recorded.replies.get('model/list').data.find((m) => m.isDefault)?.id ?? 'gpt-6.1-sol';

function threadView(t, withTurns) {
  const now = Math.floor(Date.now() / 1000);
  const view = clone(recorded.replies.get('thread/start').thread);
  Object.assign(view, {
    id: t.id,
    sessionId: t.id,
    forkedFromId: t.forkedFromId ?? null,
    preview: t.turns[0]?.items.find((i) => i.type === 'userMessage')?.content[0]?.text ?? '',
    model: t.model,
    reasoningEffort: t.effort,
    createdAt: t.createdAt,
    updatedAt: now,
    recencyAt: now,
    status: t.running ? { type: 'active', activeFlags: [] } : { type: t.systemError ? 'systemError' : 'idle' },
    path: `${HOME}/sessions/rollout-${t.id}.jsonl`,
    cwd: t.cwd,
    environments: [{ environmentId: 'local', cwd: t.cwd, runtimeWorkspaceRoots: [t.cwd] }],
    turns: withTurns ? t.turns.map((turn) => ({ ...turn, itemsView: 'full' })) : [],
  });
  return view;
}

function threadResponse(t, extra = {}) {
  return {
    ...clone(recorded.replies.get('thread/start')),
    thread: threadView(t, extra.turns ?? false),
    model: t.model,
    cwd: t.cwd,
    instructionSources: t.developerInstructions ? [`${t.cwd}/AGENTS.md`] : [],
    approvalPolicy: t.approvalPolicy,
    sandbox: sandboxPolicy(t.sandbox, t.cwd),
    reasoningEffort: t.effort,
  };
}

function newThread(params, from, id = uuid7()) {
  const model = params.model ?? from?.model ?? defaultModel();
  const t = {
    id,
    cwd: params.cwd ?? from?.cwd ?? process.cwd(),
    model,
    effort: from?.effort ?? null,
    approvalPolicy: params.approvalPolicy ?? from?.approvalPolicy ?? 'on-request',
    sandbox: params.sandbox ?? from?.sandbox ?? 'workspace-write',
    developerInstructions: params.developerInstructions ?? from?.developerInstructions ?? null,
    createdAt: Math.floor(Date.now() / 1000),
    forkedFromId: from?.id ?? null,
    turns: from ? clone(from.turns) : [],
    running: null,
  };
  threads.set(t.id, t);
  save();
  return t;
}

function settings(t) {
  return {
    disabledPluginIds: [],
    cwd: t.cwd,
    approvalPolicy: t.approvalPolicy,
    approvalsReviewer: 'user',
    sandboxPolicy: sandboxPolicy(t.sandbox, t.cwd),
    activePermissionProfile: null,
    model: t.model,
    modelProvider: 'openai',
    serviceTier: null,
    effort: t.effort,
    summary: null,
    collaborationMode: { mode: 'default', settings: { model: t.model, reasoning_effort: t.effort, developer_instructions: null } },
    personality: null,
  };
}

const account = () => {
  if (SIGNED_OUT) return clone(recorded.replies.get('account/read'));
  if (process.env.FAKE_CODEX_API_KEY === '1') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true, workspaceRouting: null };
  return { account: { type: 'chatgpt', email: null, planType: process.env.FAKE_CODEX_PLAN ?? 'plus' }, requiresOpenaiAuth: true, workspaceRouting: null };
};

const rateWindow = (usedPercent, mins) => ({ usedPercent, windowDurationMins: mins, resetsAt: Math.floor(Date.now() / 1000) + mins * 60 });
const snapshot = (primary, secondary = 20) => ({
  limitId: 'codex', limitName: null, normalModelSlug: null,
  primary: rateWindow(primary, 300), secondary: rateWindow(secondary, 10080),
  credits: null, individualLimit: null, spendControlReached: null, planType: process.env.FAKE_CODEX_PLAN ?? 'plus', rateLimitReachedType: null,
});

// ---- A turn ---------------------------------------------------------------------------------------

class Aborted extends Error {}

const usage = (n) => ({
  total: { totalTokens: n * 3, inputTokens: n * 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: n, reasoningOutputTokens: 0 },
  last: { totalTokens: n * 3, inputTokens: n * 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: n, reasoningOutputTokens: 0 },
  modelContextWindow: 258400,
});

function turnFlow(t, turn, params) {
  const base = { threadId: t.id, turnId: turn.id };
  const step = async () => {
    await tick();
    if (turn.aborted) throw new Aborted();
  };
  const item = async (it) => {
    await step();
    notify('item/started', { item: it, ...base, startedAtMs: Date.now() });
  };
  const done = async (it) => {
    await step();
    notify('item/completed', { item: it, ...base, completedAtMs: Date.now() });
    turn.items.push(it);
  };
  const text = (params.input ?? []).filter((i) => i.type === 'text').map((i) => i.text).join('\n');
  const [word = 'TURN', ...rest] = text.trim().split(/\s+/);
  const tail = text.trim().slice(word.length).trim();

  const answer = async (body) => {
    const id = uuid7();
    const msg = { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
    await item({ ...msg });
    const half = Math.ceil(body.length / 2);
    for (const delta of [body.slice(0, half), body.slice(half)]) {
      if (!delta) continue;
      await step();
      notify('item/agentMessage/delta', { ...base, itemId: id, delta });
    }
    await done({ ...msg, text: body });
  };
  const think = async () => {
    const id = uuid7();
    await item({ type: 'reasoning', id, summary: [], content: [] });
    await step();
    notify('item/reasoning/summaryTextDelta', { ...base, itemId: id, delta: 'Looking at the request', summaryIndex: 0 });
    await done({ type: 'reasoning', id, summary: ['Looking at the request'], content: [] });
  };
  const tokens = async (n) => {
    await step();
    notify('thread/tokenUsage/updated', { ...base, tokenUsage: usage(n) });
  };
  const command = (id, cmd, status, extra = {}) => ({
    type: 'commandExecution', id, pluginId: null, scriptPath: null, command: cmd, cwd: t.cwd, processId: null, source: 'agent',
    status, commandActions: [{ type: 'unknown', command: cmd }], aggregatedOutput: null, exitCode: null, durationMs: null, ...extra,
  });
  // The person's answer to an approval; `cancel` ends the turn the way an interrupt does.
  const approval = async (method, body) => {
    const response = await ask(method, body);
    if (turn.aborted) throw new Aborted();
    const decision = response?.decision;
    if (decision === 'cancel') {
      await interrupt(t, turn);
      throw new Aborted();
    }
    return decision === 'accept' || decision === 'acceptForSession';
  };

  const scripts = {
    async ASK() {
      const kind = rest[0] ?? 'command';
      const id = uuid7();
      // What the turn's answer says the person decided, so a test can read it off the result
      let granted = true;
      if (kind === 'file') {
        const change = { path: `${t.cwd}/notes.txt`, kind: { type: 'add' }, diff: 'hello\n' };
        await item({ type: 'fileChange', id, changes: [change], status: 'inProgress' });
        const ok = await approval('item/fileChange/requestApproval', { ...base, itemId: id, startedAtMs: Date.now(), reason: 'write notes.txt', grantRoot: null });
        granted = ok;
        await done({ type: 'fileChange', id, changes: [change], status: ok ? 'completed' : 'declined' });
      } else if (kind === 'permissions') {
        granted = await approval('item/permissions/requestApproval', {
          ...base, itemId: id, environmentId: 'local', startedAtMs: Date.now(), cwd: t.cwd, reason: 'needs the network',
          permissions: { network: { enabled: true }, fileSystem: null },
        });
      } else if (kind === 'input') {
        await ask('item/tool/requestUserInput', {
          ...base, itemId: id, isBlocking: true, autoResolutionMs: null,
          questions: [{ id: 'q1', header: 'Choice', question: 'Which one?', isOther: false, isSecret: false, options: [{ label: 'a', description: 'first' }, { label: 'b', description: 'second' }] }],
        });
      } else {
        const cmd = rest.slice(1).join(' ') || 'npm test';
        granted = await runCommand(id, cmd);
      }
      await answer(granted ? 'done' : 'declined');
    },
    async GITPUSH() {
      const granted = await runCommand(uuid7(), 'git push origin HEAD');
      await answer(granted ? 'pushed' : 'declined');
    },
    async ODD() {
      await ask('item/odd/request', { ...base });
      await answer('reply: ODD');
    },
    async STRUCTURED() {
      await answer(params.outputSchema ? tail || '{"ok":true}' : tail || 'reply: STRUCTURED');
    },
    async RATE() {
      await think();
      await step();
      notify('account/rateLimits/updated', { rateLimits: snapshot(100) });
      await step();
      notify('error', {
        error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null },
        willRetry: false, ...base,
      });
      throw new Failed({ message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null });
    },
    async NOISY() {
      process.stdout.write('this is not json\n');
      process.stderr.write('ERROR codex_core::something: a log line, not a protocol message\n');
      process.stderr.write('ERROR codex_core::other: another one\n');
      await step();
      notify('fake/unknownNotification', { threadId: t.id });
      await step();
      notify('error', {
        error: { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 500 } }, additionalDetails: null, misalignment: null },
        willRetry: true, ...base,
      });
      await step();
      notify('warning', { threadId: t.id, message: 'Falling back from WebSockets to HTTPS transport.' });
      await scripts.TURN();
    },
    async DELEGATE() {
      const id = uuid7();
      const child = uuid7();
      const call = (status, states) => ({
        type: 'collabAgentToolCall', id, tool: 'spawnAgent', status, senderThreadId: t.id, receiverThreadIds: status === 'inProgress' ? [] : [child],
        prompt: tail || 'look around', model: t.model, reasoningEffort: null, agentsStates: states,
      });
      await item(call('inProgress', {}));
      await done(call('completed', { [child]: { status: 'completed', message: 'done' } }));
      await answer('delegated');
    },
    async AUTH() {
      const info = recorded.notifications.get('error');
      for (const n of [2, 3, 4, 5]) {
        await step();
        notify('error', { error: { ...clone(info.error), message: `Reconnecting... ${n}/5` }, willRetry: true, ...base });
      }
      await step();
      const error = { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null, misalignment: null };
      notify('thread/status/changed', { threadId: t.id, status: { type: 'systemError' } });
      t.systemError = true;
      notify('error', { error, willRetry: false, ...base });
      throw new Failed(error);
    },
    async HANG() {
      const info = recorded.notifications.get('error');
      notify('error', { error: { ...clone(info.error), message: 'Reconnecting... 2/5' }, willRetry: true, ...base });
      await new Promise((resolve) => (turn.release = resolve));
      throw new Aborted();
    },
    async TURN() {
      await think();
      await answer(`reply: ${text}`);
      await tokens(12);
      await step();
      notify('account/rateLimits/updated', { rateLimits: snapshot(30) });
    },
  };

  async function runCommand(id, cmd) {
    await item(command(id, cmd, 'inProgress'));
    const ok = await approval('item/commandExecution/requestApproval', {
      kind: 'command', ...base, itemId: id, startedAtMs: Date.now(), approvalId: null, environmentId: 'local',
      reason: null, command: cmd, cwd: t.cwd, commandActions: [{ type: 'unknown', command: cmd }],
    });
    if (!ok) {
      await done(command(id, cmd, 'declined'));
      return false;
    }
    await step();
    notify('item/commandExecution/outputDelta', { ...base, itemId: id, delta: 'ok\n' });
    await done(command(id, cmd, 'completed', { aggregatedOutput: 'ok\n', exitCode: 0, durationMs: 12 }));
    return true;
  }

  return async () => {
    await (scripts[word] ?? scripts.TURN)();
  };
}

class Failed extends Error {
  constructor(error) {
    super(error.message);
    this.turnError = error;
  }
}

async function startTurn(id, t, params) {
  t.systemError = false;
  const turn = { id: uuid7(), items: [], status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null, aborted: false };
  t.running = turn;
  const view = () => ({ id: turn.id, items: [], itemsView: 'notLoaded', status: turn.status, error: turn.error, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs });
  reply(id, { turn: view() });
  await tick();
  turn.startedAt = Math.floor(Date.now() / 1000);
  notify('thread/status/changed', { threadId: t.id, status: { type: 'active', activeFlags: [] } });
  notify('turn/started', { threadId: t.id, turn: view() });
  const userItem = { type: 'userMessage', id: uuid7(), clientId: params.clientUserMessageId ?? null, content: params.input ?? [] };
  const base = { threadId: t.id, turnId: turn.id };
  try {
    if (params.model && params.model !== t.model) {
      // Recorded: a model switch runs a compaction before the user message.
      const compaction = { type: 'contextCompaction', id: uuid7() };
      notify('item/started', { item: compaction, ...base, startedAtMs: Date.now() });
      notify('item/completed', { item: compaction, ...base, completedAtMs: Date.now() });
      turn.items.push(compaction);
      t.model = params.model;
    }
    if (params.effort) t.effort = params.effort;
    notify('item/started', { item: userItem, ...base, startedAtMs: Date.now() });
    notify('item/completed', { item: userItem, ...base, completedAtMs: Date.now() });
    turn.items.push(userItem);
    await turnFlow(t, turn, params)();
    await finish(t, turn, 'completed', null);
  } catch (e) {
    if (e instanceof Aborted) return;
    if (e instanceof Failed) await finish(t, turn, 'failed', e.turnError);
    else throw e;
  }
}

async function finish(t, turn, status, error) {
  if (t.running !== turn) return;
  turn.status = status;
  turn.error = error;
  turn.completedAt = Math.floor(Date.now() / 1000);
  turn.durationMs = Math.max(1, (turn.completedAt - turn.startedAt) * 1000);
  t.running = null;
  t.turns.push({ id: turn.id, items: turn.items, itemsView: 'full', status, error, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs });
  save();
  if (!error?.codexErrorInfo?.httpConnectionFailed) notify('thread/status/changed', { threadId: t.id, status: { type: 'idle' } });
  notify('turn/completed', {
    threadId: t.id,
    turn: { id: turn.id, items: [], itemsView: 'notLoaded', status, error, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs },
  });
}

async function interrupt(t, turn) {
  turn.aborted = true;
  turn.release?.();
  for (const [id, resolve] of pendingServer) {
    pendingServer.delete(id);
    resolve({ decision: 'cancel' });
  }
  await finish(t, turn, 'interrupted', null);
}

// ---- Requests -------------------------------------------------------------------------------------

const need = (id, params, key) => {
  const t = threads.get(params?.[key]);
  if (!t) fail(id, -32600, `thread not found: ${params?.[key]}`);
  return t;
};

const handlers = {
  initialize(id, params) {
    const result = clone(recorded.replies.get('initialize'));
    const name = params?.clientInfo?.name ?? 'agentry';
    result.userAgent = result.userAgent.replace(/^[^/]+/, name).replace(/\(agentry_recorder; 0\.0\.0\)/, `(${name}; ${params?.clientInfo?.version ?? '0.0.0'})`);
    result.codexHome = HOME;
    reply(id, result);
    notify('remoteControl/status/changed', clone(recorded.notifications.get('remoteControl/status/changed')));
  },
  'account/read': (id) => reply(id, account()),
  'account/rateLimits/read'(id) {
    if (SIGNED_OUT) return fail(id, recorded.errors.get('account/rateLimits/read').code, recorded.errors.get('account/rateLimits/read').message);
    const rateLimits = snapshot(Number(process.env.FAKE_CODEX_USED ?? 30));
    return reply(id, { rateLimits, rateLimitsByLimitId: { codex: rateLimits } });
  },
  'model/list': (id) => reply(id, clone(recorded.replies.get('model/list'))),
  'config/read': (id) => reply(id, clone(recorded.replies.get('config/read'))),
  'permissionProfile/list': (id) => reply(id, clone(recorded.replies.get('permissionProfile/list'))),
  'thread/start'(id, params) {
    const t = newThread(params ?? {});
    reply(id, threadResponse(t));
    notify('thread/started', { thread: threadView(t, false) });
  },
  'thread/resume'(id, params) {
    // Lenient about an id this process never saw: the rollout would be on disk for the real one.
    const t = threads.get(params?.threadId) ?? newThread(params ?? {}, undefined, params?.threadId);
    for (const key of ['model', 'cwd', 'approvalPolicy', 'sandbox', 'developerInstructions']) if (params?.[key]) t[key] = params[key];
    save();
    reply(id, { ...threadResponse(t, { turns: !params?.excludeTurns }), collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    notify('thread/started', { thread: threadView(t, false) });
  },
  'thread/fork'(id, params) {
    const from = need(id, params, 'threadId');
    if (!from) return;
    const t = newThread(params ?? {}, from);
    reply(id, threadResponse(t, { turns: !params?.excludeTurns }));
    notify('thread/started', { thread: threadView(t, false) });
  },
  'thread/settings/update'(id, params) {
    const t = need(id, params, 'threadId');
    if (!t) return;
    for (const key of ['model', 'cwd', 'approvalPolicy', 'sandbox']) if (params[key]) t[key] = params[key];
    if (params.effort) t.effort = params.effort;
    save();
    reply(id, {});
    notify('thread/settings/updated', { threadId: t.id, threadSettings: settings(t) });
  },
  'turn/start'(id, params) {
    const t = need(id, params, 'threadId');
    if (!t) return;
    if (t.running) return fail(id, -32600, 'a turn is already running on this thread');
    for (const key of ['cwd', 'approvalPolicy']) if (params[key]) t[key] = params[key];
    startTurn(id, t, params).catch((e) => process.stderr.write(`fake codex: ${e.stack}\n`));
  },
  'turn/interrupt'(id, params) {
    const t = need(id, params, 'threadId');
    if (!t) return;
    const turn = t.running;
    if (!turn || turn.id !== params.turnId) return fail(id, -32600, `turn not running: ${params.turnId}`);
    reply(id, {});
    interrupt(t, turn);
  },
  'thread/list'(id, params) {
    // recorded: a thread with no turn yet is not listed, its rollout is not written
    const all = [...threads.values()].filter((t) => t.turns.length > 0 && (!params?.cwd || t.cwd === params.cwd)).sort((a, b) => b.createdAt - a.createdAt);
    reply(id, { data: all.map((t) => threadView(t, false)), nextCursor: null, backwardsCursor: null });
  },
  'thread/loaded/list': (id) => reply(id, { data: [...threads.values()].filter((t) => t.running).map((t) => t.id), nextCursor: null }),
  'thread/read'(id, params) {
    const t = need(id, params, 'threadId');
    if (!t) return;
    if (params.includeTurns) notify('deprecationNotice', clone(recorded.notifications.get('deprecationNotice')));
    reply(id, { thread: threadView(t, !!params.includeTurns) });
  },
  'thread/turns/list'(id, params) {
    const t = need(id, params, 'threadId');
    if (!t) return;
    reply(id, { data: t.turns.map((turn) => ({ ...turn, itemsView: params.itemsView ?? 'full' })), nextCursor: null, backwardsCursor: null });
  },
  'thread/items/list'(id, params) {
    const t = need(id, params, 'threadId');
    if (!t) return;
    const data = t.turns
      .filter((turn) => !params.turnId || turn.id === params.turnId)
      .flatMap((turn) => turn.items.map((it) => ({ turnId: turn.id, item: it, startedAtMs: null, completedAtMs: null })));
    reply(id, { data, nextCursor: null, backwardsCursor: null });
  },
};

function unknownMethod(id, method) {
  const recordedError = recorded.errors.get('no/such/method');
  fail(id, recordedError.code, recordedError.message.replace('`no/such/method`', `\`${method}\``));
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  log('in', message);
  // A reply to a request this process sent.
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pendingServer.get(message.id);
    pendingServer.delete(message.id);
    resolve?.(message.result ?? message.error);
    return;
  }
  if (message.id === undefined) return; // `initialized`
  const handler = handlers[message.method];
  if (handler) handler(message.id, message.params);
  else unknownMethod(message.id, message.method);
});

// The real one ends with its stdin, even with a turn in flight.
process.stdin.on('end', () => process.exit(0));
