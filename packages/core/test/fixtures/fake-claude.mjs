#!/usr/bin/env node
// Stands in for `claude -p` in orchestration tests: enough of the stream-json protocol for the
// runner, and just enough behaviour, driven by the prompt, to leave real git work behind.
//
//   FAKE-WRITE <file> <content>   writes a file and leaves it uncommitted, like most workers
//   (integrator prompt)           merges the listed branches, taking the incoming side on conflict
//
// It reports the files it could see and its working directory, which is what the tests check.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const worktree = flag('--worktree');
// Like the CLI, adopt the worktree of that name, which lives under the repository's top level
// whichever subdirectory it is started in, and work at its root; unlike it, refuse to create one,
// so a test fails if the wrapper did not prepare it where the CLI looks
const topLevel = () => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
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

  const files = readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: `cwd=${dir} files=${files.join(',')}` });
});
lines.on('close', () => process.exit(0));
