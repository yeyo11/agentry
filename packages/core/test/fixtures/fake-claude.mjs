#!/usr/bin/env node
// Stands in for `claude -p` in orchestration tests: enough of the stream-json protocol for the
// runner, and just enough behaviour, driven by the prompt, to leave real git work behind.
//
//   FAKE-WRITE <file> <content>   writes a file and leaves it uncommitted, like most workers
//   (integrator prompt)           merges the listed branches, taking the incoming side on conflict
//   FAKE-HANG                     never answers, like a worker someone has to stop
//   FAKE-FAIL <message>           ends the turn with an error result
//   FAKE-FAIL-ONCE <message>      fails like that, and every later turn of the session succeeds and
//                                 answers `retried: <the prompt it got>`
//   FAKE-FAIL-ALWAYS <message>    fails like that, and so does every later turn of the session: a
//                                 fault a retry cannot mend, which the resumed prompt no longer names
//   FAKE-BUDGET                   ends the turn as the CLI does when --max-budget-usd ran out
//
//   FAKE-RESULT-<STAGE> <json>    with --json-schema, ends with that structured output; the stage
//                                 (REFINE, WORK, VERIFY) is read off the schema as a flow run's
//                                 differs by stage, so one item's description can script each role;
//                                 ASSISTANT is an assistant run's, whose schema asks for `read`
//   FAKE-STREAM-HOLD <file>       with a FAKE-RESULT, streams it first as the CLI does, as the input of
//                                 its StructuredOutput tool call: the first half, then, once <file>
//                                 exists, the rest, and only then the result
//
//   --model fake-refused          exits 1 at once with an error on stderr, as the CLI does with an
//                                 option it refuses: a chat that never starts its turn
//
//   FAKE_CLAUDE_SPAWNS=<file>     appends `<pid> <argv>` to <file> as it starts, so a test can count
//                                 every process spawned, tracked or not
//   FAKE_CLAUDE_LINGER_MS=<ms>    stays up that long after stdin closes, the way the CLI does while
//                                 background work finishes
//
// It reports the files it could see and its working directory, which is what the tests check.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_SPAWNS) appendFileSync(process.env.FAKE_CLAUDE_SPAWNS, `${process.pid} ${args.join(' ')}\n`);
// Core lists the CLI's own sessions with this; without an answer it waits for stdin to close, and a
// chat started through the API waits a minute for it
if (args[0] === 'agents') {
  process.stdout.write('[]\n');
  process.exit(0);
}
// The same for what building the API asks first: unanswered, each waits out the 20 s timeout of
// `execCli`, which a test file with the API in its `before` paid on its first test
if (args[0] === '--version') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write('{"loggedIn":false}\n');
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// As the CLI does with an option it refuses: a line on stderr and out, before any turn
if (flag('--model') === 'fake-refused') {
  process.stderr.write("error: model 'fake-refused' not found\n");
  process.exit(1);
}
const worktree = flag('--worktree');
// Like the CLI, adopt the worktree of that name, which lives under the main checkout's top level
// whichever subdirectory, or linked worktree, it is started in, and work at its root; unlike it,
// refuse to create one, so a test fails if the wrapper did not prepare it where the CLI looks
const topLevel = () =>
  dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const dir = worktree ? join(topLevel(), '.claude', 'worktrees', worktree) : process.cwd();
if (!existsSync(dir)) {
  process.stderr.write(`fake-claude: worktree ${dir} was not prepared\n`);
  process.exit(1);
}
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Worker', '-c', 'user.email=w@example.com', ...a], { stdio: 'pipe' });

const lines = createInterface({ input: process.stdin });
let handled = false;
lines.on('line', (line) => {
  if (handled || !line.trim()) return;
  handled = true;
  const content = JSON.parse(line).message?.content;
  const prompt = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n');
  const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID();
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: dir, model: 'fake', tools: [] });

  for (const [, file, text] of prompt.matchAll(/^FAKE-WRITE (\S+) (.*)$/gm)) writeFileSync(join(dir, file), `${text}\n`);
  if (prompt.includes('You are integrating the work')) {
    for (const [, branch] of prompt.matchAll(/^- (worktree-[\w-]+)$/gm)) {
      try {
        git('merge', '--no-ff', '--no-edit', branch);
      } catch {
        git('checkout', '--theirs', '.');
        git('add', '-A');
        git('commit', '--no-edit', '-q');
      }
    }
  }

  if (/^FAKE-HANG$/m.test(prompt)) return;
  if (/^FAKE-BUDGET$/m.test(prompt)) {
    out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 1, total_cost_usd: 0.01, result: 'budget reached' });
    return;
  }
  // What a session was told to keep failing with outlives the process, as its history does
  const fault = join(tmpdir(), `fake-claude-fault-${sessionId}`);
  const sticky = /^FAKE-FAIL-(ONCE|ALWAYS) (.*)$/m.exec(prompt);
  if (sticky) writeFileSync(fault, JSON.stringify({ mode: sticky[1], message: sticky[2] }));
  const known = existsSync(fault) ? JSON.parse(readFileSync(fault, 'utf8')) : null;
  if (known && (sticky || known.mode === 'ALWAYS')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.01, result: known.message });
    return;
  }
  if (known && !sticky) {
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: `retried: ${prompt}` });
    return;
  }
  const failure = /^FAKE-FAIL (.*)$/m.exec(prompt);
  if (failure) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.01, result: failure[1] });
    return;
  }

  const schema = flag('--json-schema');
  if (schema) {
    const props = JSON.parse(schema).properties ?? {};
    const stage = props.read ? 'ASSISTANT' : props.verdict ? 'VERIFY' : props.acceptanceCriteria ? 'REFINE' : 'WORK';
    const scripted = new RegExp(`^FAKE-RESULT-${stage} (.*)$`, 'm').exec(prompt);
    if (scripted) {
      const hold = /^FAKE-STREAM-HOLD (\S+)$/m.exec(prompt);
      if (hold) {
        const json = scripted[1];
        const half = Math.floor(json.length / 2);
        const block = (event) => out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event });
        const deltas = (text) => {
          for (let i = 0; i < text.length; i += 24) block({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text.slice(i, i + 24) } });
        };
        block({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fake', name: 'StructuredOutput', input: {} } });
        deltas(json.slice(0, half));
        const wait = setInterval(() => {
          if (!existsSync(hold[1])) return;
          clearInterval(wait);
          deltas(json.slice(half));
          block({ type: 'content_block_stop', index: 0 });
          out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: '', structured_output: JSON.parse(json) });
        }, 20);
        return;
      }
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: '', structured_output: JSON.parse(scripted[1]) });
      return;
    }
  }

  const files = readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: `cwd=${dir} files=${files.join(',')}` });
});
lines.on('close', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_LINGER_MS ?? 0)));
