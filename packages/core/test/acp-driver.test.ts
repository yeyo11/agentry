import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, describe, test } from 'node:test';
import type { ToolPolicy } from '@agentry/shared';
import { AcpDriver } from '../src/providers/acp/driver.ts';
import { neutralRequest, optionFor } from '../src/providers/acp/permissions.ts';
import { translateCopilotPolicy } from '../src/providers/acp/policy-copilot.ts';
import { geminiPolicyToml, translateGeminiPolicy } from '../src/providers/acp/policy-gemini.ts';
import { openCodePermission, translateOpenCodePolicy } from '../src/providers/acp/policy-opencode.ts';
import type { DriverEvent, DriverSession, SessionLaunch } from '../src/providers/driver.ts';
import { PROVIDER_MANIFESTS } from '../src/providers/registry.ts';
import { acpHarness } from './acp-harness.ts';

const root = mkdtempSync(join(tmpdir(), 'agentry-acp-driver-'));
const running: ChildProcessWithoutNullStreams[] = [];
after(() => {
  for (const child of running) child.kill();
  rmSync(root, { recursive: true, force: true });
});

const BASE: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'omit', gitPush: 'omit' };

// Built here, outside any test: the harness removes its shim directory when the file's last test ends
const harnesses = { copilot: acpHarness('copilot'), gemini: acpHarness('gemini'), opencode: acpHarness('opencode') };
const harnessFor = (id: 'copilot' | 'gemini' | 'opencode') => harnesses[id];

function manifest(id: string) {
  const found = PROVIDER_MANIFESTS.find((m) => m.id === id);
  assert.ok(found);
  return found;
}

function spec(over: Partial<SessionLaunch> = {}): SessionLaunch {
  return {
    id: 'chat-1',
    nativeId: null,
    created: false,
    forkFrom: null,
    name: 'chat',
    cwd: root,
    permissionMode: 'manual',
    permissionPrompts: 'host',
    account: null,
    policy: null,
    ...over,
  };
}

/** The driver on a shimmed fake, with the events its session emitted and the agent's own log of what it was sent. */
function start(id: 'copilot' | 'gemini' | 'opencode', over: Partial<SessionLaunch> = {}, env: Record<string, string> = {}) {
  const harness = harnessFor(id);
  const driver = new AcpDriver(manifest(id), { dataDir: join(root, 'data') });
  const log = join(root, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  const plan = driver.launch(spec(over));
  const child = spawn(plan.bin, plan.args, { cwd: root, env: { ...plan.env, ...harness.env, FAKE_ACP_LOG: log, ...env } });
  running.push(child);
  const events: DriverEvent[] = [];
  const session: DriverSession = driver.attach({ write: (t) => child.stdin.write(t), end: () => child.stdin.end(), up: () => child.exitCode === null }, (e) => events.push(e), driver.createBranches());
  createInterface({ input: child.stdout }).on('line', (line) => session.readLine(line));
  createInterface({ input: child.stderr }).on('line', (line) => session.readError(line));
  const sent = (): Array<{ dir: string; line: { method?: string; params?: Record<string, unknown> } }> =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { dir: string; line: { method?: string; params?: Record<string, unknown> } });
  const until = async (find: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 8000;
    while (!find()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { driver, child, session, events, sent, until, plan };
}

describe('launch', () => {
  test('Copilot never updates itself: the flag and the variable', () => {
    const plan = new AcpDriver(manifest('copilot')).launch(spec());
    assert.deepEqual(plan.args.slice(0, 3), ['--acp', '--no-auto-update', '--no-remote']);
    assert.equal(plan.env.COPILOT_AUTO_UPDATE, 'false');
  });

  test('Copilot gets the policy as flags, and a git push denial that outranks every allow', () => {
    const plan = new AcpDriver(manifest('copilot')).launch(spec({ policy: { ...BASE, commands: { allow: 'any' }, gitPush: 'deny' }, model: 'auto' }));
    assert.ok(plan.args.includes('--allow-tool=shell'));
    assert.ok(plan.args.includes('--deny-tool=shell(git push)'));
    assert.deepEqual(plan.args.slice(-2), ['--model', 'auto']);
    assert.equal(plan.env.COPILOT_AUTO_UPDATE, 'false');
  });

  test('Gemini writes its policy file for the launch and removes it when the chat ends', () => {
    const driver = new AcpDriver(manifest('gemini'), { dataDir: join(root, 'gemini-data') });
    const plan = driver.launch(spec({ policy: { ...BASE, gitPush: 'deny' } }));
    const at = plan.args.indexOf('--policy');
    assert.ok(at > 0, '--policy is passed');
    const file = String(plan.args[at + 1]);
    assert.match(readFileSync(file, 'utf8'), /commandPrefix = "git push"/);
    const session = driver.attach({ write: () => {}, end: () => {}, up: () => true }, () => {}, driver.createBranches());
    session.dispose('done');
    assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/);
  });

  test('OpenCode gets its permissions inline, with autoupdate off', () => {
    const plan = new AcpDriver(manifest('opencode')).launch(spec({ policy: { ...BASE, commands: { allow: 'any' }, gitPush: 'deny' } }));
    assert.deepEqual(plan.args, ['acp']);
    const config = JSON.parse(String(plan.env.OPENCODE_CONFIG_CONTENT)) as { autoupdate: boolean; permission: { bash: Record<string, string> } };
    assert.equal(config.autoupdate, false);
    assert.deepEqual(Object.entries(config.permission.bash), [['*', 'allow'], ['git push*', 'deny']], 'the git push denial is the last rule');
  });

  test('a chat with no policy adds nothing of its own', () => {
    for (const id of ['copilot', 'gemini', 'opencode']) {
      const plan = new AcpDriver(manifest(id)).launch(spec());
      assert.ok(!plan.args.some((a) => a.startsWith('--allow-tool') || a === '--policy'), id);
    }
  });
});

describe('modes', () => {
  test('no provider offers auto, and each lists the native value', () => {
    for (const id of ['copilot', 'gemini', 'opencode']) {
      const modes = new AcpDriver(manifest(id)).permissionModes();
      assert.ok(!modes.some((m) => m.mode === 'auto'), id);
      assert.deepEqual(modes.map((m) => m.mode).sort(), ['acceptEdits', 'bypassPermissions', 'dontAsk', 'manual', 'plan']);
    }
  });
});

describe('policy translations', () => {
  test('Copilot: patterns it cannot say go to the judge; a delegate denial is listed', () => {
    const t = translateCopilotPolicy({ ...BASE, commands: { allow: [{ command: 'git status', args: 'none' }, { pattern: 'npm test*' }, { pattern: 'a*b' }] }, delegate: 'deny' });
    assert.deepEqual(t.rules.allowedTools, ['shell(git status)', 'shell(npm test:*)']);
    assert.deepEqual(t.host, ['commands']);
    assert.deepEqual(t.unsupported, ['delegate']);
  });

  test('Gemini: a denied path becomes a rule on its read tool, and the TOML carries every rule', () => {
    const t = translateGeminiPolicy({ ...BASE, read: { allow: true, denyPaths: ['.env', 'secrets/**'] }, gitPush: 'deny' });
    const toml = geminiPolicyToml(t) ?? '';
    assert.equal((toml.match(/\[\[rule\]\]/g) ?? []).length, 3);
    assert.match(toml, /toolName = "read_file"/);
    assert.match(toml, /argsPattern = /);
    assert.deepEqual(t.host, ['commands', 'gitPush']);
    assert.equal(geminiPolicyToml(translateGeminiPolicy(BASE)), null);
  });

  test('OpenCode: edits limited to paths ask, and the judge decides by path', () => {
    const t = translateOpenCodePolicy({ ...BASE, edit: { allow: ['docs'] } });
    assert.deepEqual(openCodePermission(t), { edit: 'ask' });
    assert.deepEqual(t.host, ['edit']);
  });

  test('exclusive is listed where the person’s own config would still load', () => {
    for (const translate of [translateCopilotPolicy, translateGeminiPolicy, translateOpenCodePolicy]) {
      assert.ok(translate({ ...BASE, exclusive: true }).unsupported.includes('exclusive'));
    }
  });
});

describe('permission requests', () => {
  const call = (kind: string, rawInput: unknown, locations?: Array<{ path: string }>) => ({ toolCallId: 'c', title: 't', kind, rawInput, ...(locations ? { locations } : {}) });

  test('each kind of call is a neutral request', () => {
    assert.deepEqual(neutralRequest(call('execute', { command: 'git push' }), root), { kind: 'command', command: 'git push' });
    assert.deepEqual(neutralRequest(call('edit', {}, [{ path: `${root}/src/a.ts` }]), root), { kind: 'edit', paths: ['src/a.ts'] });
    assert.deepEqual(neutralRequest(call('delete', {}, [{ path: '/elsewhere/x' }]), root), { kind: 'edit', paths: ['/elsewhere/x'] });
    assert.deepEqual(neutralRequest(call('search', {}), root), { kind: 'read', paths: [] });
    assert.deepEqual(neutralRequest(call('fetch', { url: 'https://x.test' }), root), { kind: 'fetch', url: 'https://x.test' });
    assert.deepEqual(neutralRequest(call('think', {}), root), { kind: 'other' });
  });

  test('the option is chosen by kind: once, or always when the person chose it, or none', () => {
    const options = [
      { optionId: 'a', name: 'A', kind: 'allow_always' },
      { optionId: 'o', name: 'O', kind: 'allow_once' },
      { optionId: 'r', name: 'R', kind: 'reject_once' },
    ];
    assert.equal(optionFor(options, { behavior: 'allow' })?.optionId, 'o');
    assert.equal(optionFor(options, { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }] })?.optionId, 'a');
    assert.equal(optionFor(options, { behavior: 'deny' })?.optionId, 'r');
    assert.equal(optionFor([options[1]!], { behavior: 'deny' }), null);
  });
});

describe('a session', () => {
  test('the handshake confirms what initialize offers, and nothing else is spent', async () => {
    const harness = harnessFor('opencode');
    const driver = new AcpDriver(manifest('opencode'));
    const result = await driver.handshake({ ...process.env, ...harness.env }, new AbortController().signal);
    assert.equal(result.version, '1.18.34');
    assert.equal(result.account, null);
    assert.deepEqual(result.confirmed.sort(), ['fork', 'mcp', 'resume']);
  });

  test('a resume uses session/resume where it is offered and session/load where it is not, and drops the replay', async () => {
    const open = start('opencode', { created: true, nativeId: 'ses_earlier' });
    await open.until(() => open.events.some((e) => e.kind === 'init'), 'the init');
    assert.ok(open.sent().some((m) => m.dir === 'in' && m.line.method === 'session/resume' && m.line.params?.sessionId === 'ses_earlier'));
    assert.equal(open.events.find((e) => e.kind === 'init' && e.nativeSessionId === 'ses_earlier')?.kind, 'init');

    const load = start('copilot', { created: true, nativeId: 'earlier' });
    await load.until(() => load.events.some((e) => e.kind === 'init'), 'the init');
    assert.ok(load.sent().some((m) => m.dir === 'in' && m.line.method === 'session/load'));
    assert.ok(!load.events.some((e) => e.kind === 'message'), 'the replayed history is not in the feed');
  });

  test('the chat’s MCP servers go to session/new as stdio and http entries', async () => {
    const file = join(root, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { local: { command: 'node', args: ['s.js'], env: { K: 'v' } }, remote: { type: 'http', url: 'https://m.test/mcp', headers: { A: 'b' } } } }));
    const s = start('copilot', { mcpConfig: file });
    await s.until(() => s.events.some((e) => e.kind === 'init'), 'the init');
    const params = s.sent().find((m) => m.dir === 'in' && m.line.method === 'session/new')?.line.params;
    assert.deepEqual(params?.mcpServers, [
      { name: 'local', command: 'node', args: ['s.js'], env: [{ name: 'K', value: 'v' }] },
      { type: 'http', name: 'remote', url: 'https://m.test/mcp', headers: [{ name: 'A', value: 'b' }] },
    ]);
  });

  test('a signed-out agent fails the session with auth-required', async () => {
    const s = start('gemini', {}, { FAKE_ACP_SIGNED_OUT: '1' });
    await s.until(() => s.events.some((e) => e.kind === 'failed'), 'the failure');
    const failed = s.events.find((e) => e.kind === 'failed');
    assert.ok(failed?.kind === 'failed' && failed.reason.startsWith('auth-required: '));
  });

  test('the client offers no file system or terminal, and a text turn is a text block', async () => {
    const s = start('gemini');
    s.session.send({ text: 'hello', attachments: [] });
    await s.until(() => s.events.some((e) => e.kind === 'result'), 'the result');
    const log = s.sent();
    const init = log.find((m) => m.dir === 'in' && m.line.method === 'initialize')?.line.params;
    assert.deepEqual(init?.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    assert.deepEqual(log.find((m) => m.dir === 'in' && m.line.method === 'session/prompt')?.line.params?.prompt, [{ type: 'text', text: 'hello' }]);
    const result = s.events.find((e) => e.kind === 'result');
    assert.equal(result?.kind === 'result' ? result.text : '', 'Done. You said: hello');
  });

  test('a diff in a tool call reaches the transcript as an edit, and a plan as a task', async () => {
    const s = start('copilot');
    s.session.send({ text: 'go', attachments: [] });
    await s.until(() => s.events.some((e) => e.kind === 'result'), 'the result');
    const messages = s.events.flatMap((e) => (e.kind === 'message' ? [e.entry] : []));
    const edit = messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use' && (b.input as { kind?: string }).kind === 'edit');
    assert.ok(edit && edit.type === 'tool_use');
    assert.deepEqual((edit.input as { diffs: unknown[] }).diffs, [{ path: 'notes.txt', oldText: '', newText: 'hello\n' }]);
    const resultBlock = messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_result' && b.toolUseId === edit.id);
    assert.match(resultBlock?.type === 'tool_result' ? resultBlock.content : '', /\+hello/);
    assert.ok(s.events.some((e) => e.kind === 'task'));
  });

  test('acceptEdits grants an edit request itself on OpenCode, and asks for a command', async () => {
    const edit = start('opencode', { permissionMode: 'acceptEdits' });
    edit.session.send({ text: 'ASK edit', attachments: [] });
    await edit.until(() => edit.events.some((e) => e.kind === 'result'), 'the result');
    assert.ok(!edit.events.some((e) => e.kind === 'permission-request'));
    const command = start('opencode', { permissionMode: 'acceptEdits' });
    command.session.send({ text: 'ASK execute', attachments: [] });
    await command.until(() => command.events.some((e) => e.kind === 'permission-request'), 'the request');
  });
});
