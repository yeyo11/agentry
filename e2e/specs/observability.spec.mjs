// What a chat really did: the branch, the commits, the changed files with their +/− counts, a diff
// per file on the review screen, the chat's own checklist and what it is running.
//
// It builds a real git repository with a worktree in the sandbox and seeds a transcript that says
// the chat worked in it, so nothing here needs a live process. The health actions (cancel the
// command, send a hint, interrupt) act on a process the wrapper started: health-actions.spec.mjs
// covers them against the fake CLI of e2e/fake-cli.
// Everything seeded is removed at the end, because other specs count what the sandbox holds.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION = 'e2e-observe-session';

const line = (o) => JSON.stringify(o);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

/** A repository with a feature branch in its own worktree: one commit, one edit not committed, one new file. */
function seedRepo(root) {
  const main = join(root, 'app');
  const tree = join(root, 'app-feature');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'greet.ts'), ['export function greet(name: string) {', "  return 'hello ' + name;", '}', ''].join('\n'));
  writeFileSync(join(main, 'keep.ts'), 'export const keep = 1;\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'initial commit');
  git(main, 'worktree', 'add', '-q', '-b', 'feature/greeting', tree);
  writeFileSync(join(tree, 'greet.ts'), ['export function greet(name: string) {', "  return `hello, ${name}!`;", '}', ''].join('\n'));
  git(tree, 'add', '.');
  git(tree, 'commit', '-q', '-m', 'feat: greet with a comma and a bang');
  // Not committed yet: an edit to a tracked file and a file git has never seen
  writeFileSync(join(tree, 'keep.ts'), 'export const keep = 2;\nexport const extra = 3;\n');
  writeFileSync(join(tree, 'fresh.ts'), 'export const fresh = true;\n');
  return { main, tree };
}

function seedTranscript(configDir, { main, tree }) {
  const projectId = tree.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = join(configDir, 'projects', projectId);
  mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const assistant = (n, content, s) =>
    line({ type: 'assistant', uuid: `o-${n}`, timestamp: at(s), cwd: tree, message: { role: 'assistant', id: `msg-o-${n}`, model: 'claude-sonnet-5', content, usage: { input_tokens: 10, output_tokens: 10 } } });
  const user = (n, content, s) => line({ type: 'user', uuid: `o-${n}`, timestamp: at(s), cwd: tree, message: { role: 'user', content } });
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    [
      line({ type: 'worktree-state', worktreeSession: { worktreePath: tree, originalCwd: main, worktreeName: 'app-feature', worktreeBranch: 'feature/greeting' } }),
      user(1, 'Make greet friendlier', 0),
      assistant(
        2,
        [
          {
            type: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Change the greeting', status: 'completed', activeForm: 'Changing the greeting' },
                { content: 'Update the callers', status: 'in_progress', activeForm: 'Updating the callers' },
                { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
              ],
            },
          },
        ],
        1,
      ),
      user(3, [{ type: 'tool_result', tool_use_id: 'todo-1', content: 'ok' }], 2),
      assistant(4, [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: join(tree, 'greet.ts'), old_string: 'x', new_string: 'y' } }], 3),
      user(5, [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'edited' }], 4),
      // The last call has no result; with a process working on the chat it would be what it runs now
      assistant(6, [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pnpm test --filter greet' } }], 5),
    ].join('\n'),
  );
  return dir;
}

export default async ({ page, api, check }) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-e2e-observe-'));
  let seeded = null;
  try {
    const repo = seedRepo(root);
    const { configDir } = (await api.get('/system')).body;
    seeded = seedTranscript(configDir, repo);

    // The routes answer with what git says, before any of it is drawn
    const changes = await api.get(`/chats/${SESSION}/changes`);
    check(changes.status === 200 && changes.body.summary?.branch === 'feature/greeting', `the chat's summary is its branch (${changes.status})`);
    check(changes.body.summary.uncommitted.some((f) => f.path === 'fresh.ts'), 'a file git has never seen is among the uncommitted ones');

    await page.goto(`/chats/${SESSION}`, 1500);
    // What it changed is the inspector's Changes tab: a compact summary
    await page.click('.chat-inspector [role=tab]', 'Changes');
    await page.waitFor(`return !!document.querySelector('.obs-changes')`, { label: 'the changes card' });
    const card = await page.text('.obs-changes');
    check(card.includes('feature/greeting'), 'the branch is named');

    // Files with their counts, committed and not
    const files = await page.eval(`return [...document.querySelectorAll('.obs-file-name')].map((e) => e.textContent.trim())`);
    check(files.includes('greet.ts') && files.includes('keep.ts') && files.includes('fresh.ts'), `every changed file is listed (${files.join(', ')})`);
    // The counts are text, so they do not depend on colour
    check(await page.eval(`return [...document.querySelectorAll('.obs-file .obs-add')].some((e) => /^\\+\\d+$/.test(e.textContent.trim()))`), 'a file shows how many lines it added');
    check(await page.eval(`return [...document.querySelectorAll('.obs-file .obs-del')].some((e) => /^−\\d+$/.test(e.textContent.trim()))`), 'a file shows how many lines it removed');
    check(await page.eval(`return [...document.querySelectorAll('.obs-file-row .sr-only')].some((e) => /lines added/.test(e.textContent))`), 'the counts are also said in words for a screen reader');
    check(!(await page.eval(`return [...document.querySelectorAll('.obs-changes a')].some((a) => /^(vscode|cursor|zed):/.test(a.getAttribute('href') ?? ''))`)), 'nothing links out to an editor');

    // The branch, its base, the commits and the diff are on the review screen
    await page.click('.changes-review-link');
    await page.waitFor(`return location.pathname === ${JSON.stringify(`/chats/${SESSION}/changes`)} && !!document.querySelector('.changes-head')`, { label: 'the review opens' });
    // The header is drawn before the summary it reads has arrived
    await page.waitFor(`return document.querySelector('.changes-head')?.textContent.includes('feature/greeting')`, { label: 'the review names the branch' });
    const head = await page.text('.changes-head');
    check(/from [0-9a-f]{7}/.test(head), 'the commit it branched from is named');
    check(head.includes('1 commit'), 'how far ahead it is is said');
    await page.focus('.changes-scope');
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the scope menu' });
    const scopes = await page.eval(`return [...document.querySelectorAll('[role=menu] [role^=menuitem]')].map((i) => i.textContent.trim())`);
    check(scopes.some((s) => s.includes('feat: greet with a comma and a bang')), `the commit is listed by its subject (${scopes.join(' | ')})`);
    check(scopes.some((s) => s.includes('Not committed yet')), 'the uncommitted files have their own scope');
    await page.key('Escape');

    // A diff per file, drawn by Agentry's own comparator
    await page.goto(`/chats/${SESSION}/changes?file=greet.ts&mode=unified`, 1500);
    await page.waitFor(`return document.querySelector('.changes-review .diff')?.dataset.mode === 'unified' && document.querySelectorAll('.changes-review .diff-row').length > 0`, { label: 'the diff opens' });
    const rows = await page.eval(`return [...document.querySelectorAll('.changes-review .diff-row')].map((r) => [r.className, r.querySelector('.diff-code')?.textContent ?? ''])`);
    check(rows.some(([c, t]) => c.includes('is-del') && t.includes("return 'hello ' + name;")), 'the diff shows the removed line');
    check(rows.some(([c, t]) => !c.includes('is-del') && !c.includes('is-ctx') && t.includes('return `hello, ${name}!`;')), 'the diff shows the added line');

    // What it is doing now, and its own checklist, on the Activity tab
    await page.goto(`/chats/${SESSION}`, 1500);
    await page.click('.chat-inspector [role=tab]', 'Activity');
    await page.waitFor(`return !!document.querySelector('.insp-checklist')`, { label: 'the checklist' });
    const side = await page.text('.run-side');
    // Nothing works on this chat, so its unanswered call is a stale one and it is not said to be running
    check(!side.includes('Running Bash:'), 'a chat nobody is working on is not said to run a command');
    check(/Last event in the transcript .+ ago/.test(side), 'the time since its last event is shown');
    check(side.includes('1 of 3 done') && side.includes('working on: Update the callers'), 'the checklist says what is done and what it is on');
    check(await page.eval(`return [...document.querySelectorAll('.insp-checklist .step .sr-only')].map((e) => e.textContent.trim()).join('|') === 'Done|In progress|Not started'`), 'each checklist item says its state in words');
    // The header says how far along the checklist is, and opens it
    check(await page.eval(`return document.querySelector('.chat-checklist')?.textContent.includes('1/3') ?? false`), 'the header shows the checklist progress');

    // Accessibility of what was added (changes-review.spec.mjs scans the review screen)
    const violations = await page.axe({ include: '.run-side' });
    check(violations.length === 0, `the side cards have accessibility violations: ${JSON.stringify(violations)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (seeded) rmSync(seeded, { recursive: true, force: true });
  }
};
