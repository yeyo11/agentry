// The fake CLI's own test: `node --test e2e/fake-cli/claude.test.mjs`. It speaks to the fake the way
// the wrapper does (stream-json on stdin and stdout), so a spec that fails can be told apart from a
// fake that stopped answering. Needs no build, no browser and no server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), 'claude');
const linux = existsSync('/proc/self/stat');
/** A pid and every process under it, read from /proc: what the wrapper's cancel signals. */
function tree(root) {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const name of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === out[i]) out.push(Number(name));
      } catch {
        // gone in between
      }
    }
  }
  return out;
}
const alive = (pid) => {
  try {
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+/s, '').startsWith('Z');
  } catch {
    return false;
  }
};

/** A chat with the fake: `send` writes a line, `next(match)` waits for the first event after the last one read that matches. */
function chat(env = {}, { args = [], setup } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-fake-cli-'));
  const logFile = join(dir, 'log.jsonl');
  setup?.(dir);
  const proc = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', 'fake-session', '--model', 'haiku', ...args], {
    cwd: dir,
    env: { ...process.env, AGENTRY_FAKE_CLI_LOG: logFile, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events = [];
  const waiters = [];
  createInterface({ input: proc.stdout }).on('line', (line) => {
    events.push(JSON.parse(line));
    for (const w of waiters.splice(0)) w();
  });
  let read = 0;
  const exited = new Promise((r) => proc.on('exit', r));
  return {
    proc,
    dir,
    events,
    exited,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    send: (message) => proc.stdin.write(`${JSON.stringify(message)}\n`),
    say: (text) => proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`),
    async next(match, timeout = 5000) {
      const end = Date.now() + timeout;
      for (;;) {
        const at = events.slice(read).findIndex(match);
        if (at !== -1) {
          read += at + 1;
          return events[read - 1];
        }
        if (Date.now() > end) throw new Error(`no matching event; saw ${JSON.stringify(events.slice(read))}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
    done() {
      proc.kill('SIGTERM');
      return exited.finally(() => rmSync(dir, { recursive: true, force: true }));
    },
  };
}

const toolUse = (e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use');
const text = (e) => (e.type === 'assistant' ? e.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

test('answers the subcommands the wrapper runs, and refuses the rest', () => {
  assert.match(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout, /^2\.1\.1-fake \(Claude Code\)/);
  assert.equal(JSON.parse(spawnSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8' }).stdout).loggedIn, true);
  assert.deepEqual(JSON.parse(spawnSync(bin, ['agents', '--json'], { encoding: 'utf8' }).stdout), []);
  assert.deepEqual(JSON.parse(spawnSync(bin, ['plugin', 'list', '--json'], { encoding: 'utf8' }).stdout), []);
  const unknown = spawnSync(bin, ['update'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /not part of the fake/);
});

test('a turn runs its commands for real and ends with a result', async () => {
  const c = chat();
  const init = await c.next((e) => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.session_id, 'fake-session');
  assert.equal(init.model, 'claude-haiku-5');
  c.say('run: echo one\nrun: echo two');
  const first = await c.next(toolUse);
  assert.equal(first.message.content[0].input.command, 'echo one');
  const result1 = await c.next((e) => e.type === 'user');
  assert.equal(result1.message.content[0].content, 'one');
  assert.equal(result1.message.content[0].is_error, false);
  await c.next((e) => toolUse(e) && e.message.content[0].input.command === 'echo two');
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, false);
  c.say('thanks');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Heard: thanks');
  await c.next((e) => e.type === 'result');
  await c.done();
});

test('a running command beats with the elapsed time offset, and hears messages at its next step', { skip: !linux && 'needs /proc' }, async () => {
  const c = chat({ AGENTRY_FAKE_CLI_HEARTBEAT_MS: '100' });
  c.say('elapsed: 200\nrun: sleep 30\nrun: sleep 31');
  const call = await c.next(toolUse);
  const id = call.message.content[0].id;
  const beat = await c.next((e) => e.type === 'tool_progress');
  assert.equal(beat.tool_use_id, id);
  assert.ok(beat.elapsed_time_seconds >= 200);
  c.say('a hint');
  // What the wrapper's cancel does: the command's tree goes, the turn goes on
  const started = c.log().find((l) => l.event === 'command');
  assert.ok(alive(started.commandPid));
  for (const pid of tree(started.commandPid).reverse()) process.kill(pid, 'SIGTERM');
  const failed = await c.next((e) => e.type === 'user');
  assert.equal(failed.message.content[0].is_error, true);
  assert.equal(text(await c.next((e) => e.type === 'assistant' && text(e) !== '')), 'Heard: a hint');
  await c.next((e) => toolUse(e) && e.message.content[0].input.command === 'sleep 31');
  assert.ok(c.log().some((l) => l.event === 'stdin' && l.text === 'a hint'));

  // An interrupt ends the turn and takes its command down with it
  const second = c.log().filter((l) => l.event === 'command')[1];
  const secondTree = tree(second.commandPid);
  assert.ok(secondTree.every(alive));
  c.send({ type: 'control_request', request_id: 'r-1', request: { subtype: 'interrupt' } });
  const answer = await c.next((e) => e.type === 'control_response');
  assert.deepEqual(answer.response, { subtype: 'success', request_id: 'r-1', response: {} });
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(secondTree.filter(alive), []);
  await c.done();
});

test('closing stdin ends the turn with a result and leaves no command behind', { skip: !linux && 'needs /proc' }, async () => {
  const c = chat();
  c.say('run: sleep 30');
  await c.next(toolUse);
  const started = c.log().find((l) => l.event === 'command');
  c.proc.stdin.end();
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, true);
  assert.equal(await c.exited, 0);
  assert.equal(alive(started.commandPid), false);
  await c.done();
});

test('an unknown control request gets an error answer, never silence', async () => {
  const c = chat();
  c.send({ type: 'control_request', request_id: 'r-2', request: { subtype: 'mcp_status' } });
  const answer = await c.next((e) => e.type === 'control_response');
  assert.equal(answer.response.subtype, 'error');
  await c.done();
});

test('say: lines are the assistant\'s own prose, in their place among the calls', async () => {
  const c = chat();
  c.say('say: Looking at the routes first.\nrun: echo routes\nsay: Two handlers, both tested.');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Looking at the routes first.');
  await c.next((e) => toolUse(e) && e.message.content[0].input.command === 'echo routes');
  assert.equal(text(await c.next((e) => e.type === 'assistant' && text(e) !== '')), 'Two handlers, both tested.');
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.result, 'Two handlers, both tested.');
  assert.ok(!c.events.some((e) => /^Running|^All done/.test(text(e))), 'a scripted turn has none of the fake\'s own words');
  await c.done();
});

test('a review.triage question is answered without a script: the first thread to the agent, the rest to a person', async () => {
  const c = chat();
  c.say('Answer the questions below.\n\nQuestions:\n\nPRRT_a: Who should take this review comment on src/cart.ts?\n  - agent: An agent\n\nPRRT_b: Who should take this review comment?\n  - agent: An agent');
  const result = await c.next((e) => e.type === 'result');
  assert.deepEqual(result.structured_output, { PRRT_a: 'agent', PRRT_b: 'person' });
  await c.done();
});

test('an issue.triage question is answered without a script: the marks go round in the order asked', async () => {
  const c = chat();
  c.say('Answer the questions below.\n\nQuestions:\n\n32: Can an agent start on issue 32 ("Coupon") as written?\n  - ready: Ready\n\n33: Can an agent start on issue 33 as written?\n  - ready: Ready\n\n34: Can an agent start on issue 34 as written?\n  - ready: Ready\n\n35: Can an agent start on issue 35 as written?\n  - ready: Ready');
  const result = await c.next((e) => e.type === 'result');
  assert.deepEqual(result.structured_output, { 32: 'ready', 33: 'needs-refining', 34: 'not-for-agents', 35: 'ready' });
  await c.done();
});

test('read: holds a Read call open, and json: is the structured output of the result', async () => {
  const c = chat({ AGENTRY_FAKE_CLI_READ_MS: '50' }, { setup: (dir) => writeFileSync(join(dir, 'README.md'), '# hello\n') });
  c.say('read: README.md\nread: missing.md\njson: {"summary":"ok","workItems":[]}');
  const first = await c.next((e) => toolUse(e) && e.message.content[0].name === 'Read');
  assert.match(first.message.content[0].input.file_path, /README\.md$/);
  const answer = await c.next((e) => e.type === 'user' && e.message.content[0].type === 'tool_result');
  assert.equal(answer.message.content[0].content, '# hello\n');
  await c.next((e) => toolUse(e) && /missing\.md$/.test(e.message.content[0].input.file_path));
  const missing = await c.next((e) => e.type === 'user' && e.message.content[0].type === 'tool_result');
  assert.equal(missing.message.content[0].content, '(file not found)');
  const result = await c.next((e) => e.type === 'result');
  assert.deepEqual(result.structured_output, { summary: 'ok', workItems: [] });
  assert.equal(result.is_error, false);
  await c.done();
});

test('stream: hands the structured output over as StructuredOutput deltas, and hold: keeps it half-written', async () => {
  const c = chat();
  const json = '{"resources":[{"kind":"agents","name":"glossary-reviewer","content":"---\\nname: glossary-reviewer\\n---\\n"}]}';
  c.say(`stream: ${json}\nhold: release\nsay: Written.`);
  const start = await c.next((e) => e.type === 'stream_event' && e.event.type === 'content_block_start');
  assert.equal(start.event.content_block.name, 'StructuredOutput');
  const partial = () =>
    c.events
      .filter((e) => e.type === 'stream_event' && e.event.delta?.type === 'input_json_delta')
      .map((e) => e.event.delta.partial_json)
      .join('');
  await new Promise((r) => setTimeout(r, 300));
  // Held: half the file is out, and no result yet
  assert.equal(partial(), json.slice(0, Math.floor(json.length / 2)));
  assert.ok(!c.events.some((e) => e.type === 'result'));
  writeFileSync(join(c.dir, 'release'), '');
  const result = await c.next((e) => e.type === 'result');
  assert.equal(partial(), json);
  assert.ok(c.events.some((e) => e.type === 'stream_event' && e.event.type === 'content_block_stop'));
  assert.deepEqual(result.structured_output, JSON.parse(json));
  assert.equal(result.result, 'Written.');
  await c.done();
});

test('an interrupt during a read ends the turn at once', async () => {
  const c = chat({ AGENTRY_FAKE_CLI_READ_MS: '60000' });
  c.say('read: README.md');
  await c.next((e) => toolUse(e) && e.message.content[0].name === 'Read');
  c.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } });
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, true);
  await c.done();
});

test('a message holding a key of the scripts file is played as its script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-fake-cli-scripts-'));
  const scripts = join(dir, 'scripts.json');
  writeFileSync(scripts, JSON.stringify({ 'Tidy the imports': 'say: Sorted them.\nrun: echo sorted' }));
  const c = chat({ AGENTRY_FAKE_CLI_SCRIPTS: scripts });
  c.say('You are a worker.\n\nYour task (tidy):\nTidy the imports\n\nFinish with a report.');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Sorted them.');
  await c.next((e) => toolUse(e) && e.message.content[0].input.command === 'echo sorted');
  await c.next((e) => e.type === 'result');
  c.say('anything else');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Heard: anything else');
  await c.done();
  rmSync(dir, { recursive: true, force: true });
});

test('FAKE-LIMIT reports a rejected window, then a 429 result, every time it is sent', async () => {
  const c = chat();
  for (let i = 0; i < 2; i++) {
    c.say('FAKE-LIMIT');
    const event = await c.next((e) => e.type === 'rate_limit_event');
    assert.equal(event.rate_limit_info.status, 'rejected');
    assert.ok(event.rate_limit_info.resetsAt > Date.now() / 1000);
    const result = await c.next((e) => e.type === 'result');
    assert.equal(result.is_error, true);
    assert.equal(result.api_error_status, 429);
  }
  await c.done();
});

test('FAKE-LIMIT-CLEAR reports the window allowed again at no use, and the turn ends well', async () => {
  const c = chat();
  c.say('FAKE-LIMIT-CLEAR');
  const event = await c.next((e) => e.type === 'rate_limit_event');
  assert.equal(event.rate_limit_info.status, 'allowed');
  assert.equal(event.rate_limit_info.unifiedWindows['5h'].utilization, 0);
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, false);
  await c.done();
});

test('--worktree works in a worktree of the repository, on its own branch, as the CLI does', async () => {
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fake', GIT_AUTHOR_EMAIL: 'fake@example.com', GIT_COMMITTER_NAME: 'Fake', GIT_COMMITTER_EMAIL: 'fake@example.com' } });
  const c = chat({}, {
    args: ['--worktree', 'tidy'],
    setup: (dir) => {
      git(dir, 'init', '-q');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
    },
  });
  const init = await c.next((e) => e.type === 'system' && e.subtype === 'init');
  assert.match(init.cwd, /\/\.claude\/worktrees\/tidy$/);
  assert.equal(git(init.cwd, 'branch', '--show-current').stdout.trim(), 'worktree-tidy');
  c.say('run: pwd');
  await c.next(toolUse);
  assert.equal((await c.next((e) => e.type === 'user')).message.content[0].content, init.cwd);
  await c.done();
});
