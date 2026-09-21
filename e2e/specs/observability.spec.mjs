// What a chat really did, and how a person reaches it in their editor: the branch, the commits, the
// changed files with their +/− counts, a diff per file, the chat's own checklist, what it is
// running, and the editor settings that turn a path and a line into a link.
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

const EDITOR_KEY = 'agentry-editor:v1';
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

    // The editor settings live on the server; a browser's old copy moves there once, while the
    // server has none. Only a first run in a fresh sandbox can see that, so it is checked when it can
    const before = await api.get('/settings/editor');
    check(before.status === 200, `the editor settings are read (${before.status})`);
    await page.goto('/', 500);
    if (!before.body.stored) {
      const legacy = { template: 'zed://{path}:{line}', pathMap: [{ from: '/srv/app', to: '/home/dev/app' }] };
      await page.eval(`localStorage.setItem(${JSON.stringify(EDITOR_KEY)}, ${JSON.stringify(JSON.stringify(legacy))}); return true`);
      await page.goto('/settings?tab=editor', 1500);
      await page.waitFor(`return !!document.querySelector('[data-testid=editor-preview]') && localStorage.getItem(${JSON.stringify(EDITOR_KEY)}) === null`, {
        label: "the browser's copy moves to the server",
      });
      const migrated = await api.get('/settings/editor');
      check(migrated.body.stored === true && migrated.body.settings.template === legacy.template, `the server has the browser's template (${JSON.stringify(migrated.body)})`);
      check(migrated.body.settings.pathMap?.[0]?.to === '/home/dev/app', "the server has the browser's path mapping");
    }
    // Every browser starts from the default template for what follows
    const reset = await api.put('/settings/editor', { template: 'vscode://file/{path}:{line}' });
    check(reset.status === 200, `the editor settings are reset (${reset.status})`);
    await page.eval(`localStorage.removeItem(${JSON.stringify(EDITOR_KEY)}); return true`);
    // A full load: the page's copy of the settings was read before the reset
    await page.goto('/', 500);
    await page.goto(`/chats/${SESSION}`, 1500);
    await page.waitFor(`return !!document.querySelector('.obs-changes')`, { label: 'the changes card' });

    // Branch, base and the commit
    const card = await page.text('.obs-changes');
    check(card.includes('feature/greeting'), 'the branch is named');
    check(/from [0-9a-f]{8}/.test(card), 'the commit it branched from is named');
    check(card.includes('1 commit ahead'), 'how far ahead it is is said');
    check(card.includes('feat: greet with a comma and a bang'), 'the commit is listed by its subject');

    // Files with their counts, committed and not
    const files = await page.eval(`return [...document.querySelectorAll('.obs-file-name')].map((e) => e.textContent.trim())`);
    check(files.includes('greet.ts') && files.includes('keep.ts') && files.includes('fresh.ts'), `every changed file is listed (${files.join(', ')})`);
    check(card.includes('Not committed yet'), 'the uncommitted files have their own list');
    // The counts are text, so they do not depend on colour
    check(await page.eval(`return [...document.querySelectorAll('.obs-file .obs-add')].some((e) => /^\\+\\d+$/.test(e.textContent.trim()))`), 'a file shows how many lines it added');
    check(await page.eval(`return [...document.querySelectorAll('.obs-file .obs-del')].some((e) => /^−\\d+$/.test(e.textContent.trim()))`), 'a file shows how many lines it removed');
    check(await page.eval(`return [...document.querySelectorAll('.obs-file-row .sr-only')].some((e) => /lines added/.test(e.textContent))`), 'the counts are also said in words for a screen reader');

    // A diff per file, highlighted, in a dialog of its own
    await page.click('.obs-file-name', 'greet.ts');
    await page.waitFor(`return !!document.querySelector('[role=dialog] .obs-diff pre.code')`, { label: 'the diff opens' });
    const diff = await page.text('[role=dialog] .obs-diff');
    check(diff.includes('+  return `hello, ${name}!`;') && diff.includes("-  return 'hello ' + name;"), 'the diff shows the removed and the added line');
    check(await page.eval(`return !!document.querySelector('[role=dialog] pre.code[data-lang="diff"]')`), 'the diff is drawn as a highlighted diff block');

    // A link into the editor at the changed line, from the default template
    const linkAt = await page.eval(`return document.querySelector('[role=dialog] .obs-hunks a')?.getAttribute('href') ?? null`);
    check(linkAt === `vscode://file${repo.tree}/greet.ts:2`, `the hunk links to the first changed line (${linkAt})`);
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'Escape closes the diff' });

    // The worktree opens in the editor too
    const worktreeLink = await page.eval(`return [...document.querySelectorAll('.obs-changes a.btn')].find((a) => a.textContent.includes('Open worktree in editor'))?.getAttribute('href') ?? null`);
    check(worktreeLink === `vscode://file${repo.tree}`, `the worktree link has no line (${worktreeLink})`);

    // What it is doing now, and its own checklist
    const side = await page.text('.run-side');
    // Nothing works on this chat, so its unanswered call is a stale one and it is not said to be running
    check(!side.includes('Running Bash:'), 'a chat nobody is working on is not said to run a command');
    check(/Last event in the transcript .+ ago/.test(side), 'the time since its last event is shown');
    check(side.includes('1 of 3 done') && side.includes('working on: Update the callers'), 'the checklist says what is done and what it is on');
    check(await page.eval(`return [...document.querySelectorAll('.obs-check .sr-only')].map((e) => e.textContent.trim()).join('|') === 'Done:|In progress:|To do:'`), 'each checklist item says its state in words');

    // The editor settings: the template, the container-to-host mapping and the diff command
    await page.goto('/settings?tab=editor', 1500);
    await page.waitFor(`return !!document.querySelector('[data-testid=editor-preview]')`, { label: 'the editor settings' });
    check((await page.text('[data-testid=editor-preview]')).startsWith('vscode://file/workspace/app/src/index.ts:42'), 'the preview shows the default link');
    await page.fill('main .field input', 'cursor://file/{path}:{line}');
    await page.click('.obs-map .btn', 'Add a path');
    await page.fill('.obs-map-row input', repo.tree);
    await page.fill('.obs-map-row input:nth-of-type(2)', '/home/dev/feature');
    await page.click('main .btn-primary', 'Save');
    await page.waitFor(`return document.body.innerText.includes('Editor settings saved')`, { label: 'the settings are saved' });
    const stored = (await api.get('/settings/editor')).body.settings;
    check(stored?.template === 'cursor://file/{path}:{line}', 'the template is stored on the server');
    check(stored?.pathMap?.[0]?.to === '/home/dev/feature', 'the path mapping is stored on the server');
    check((await page.eval(`return localStorage.getItem(${JSON.stringify(EDITOR_KEY)})`)) === null, 'nothing is kept in the browser');
    // The server refuses what the form refuses, for a client that skips the form
    const unsafe = await api.put('/settings/editor', { template: 'javascript:alert({path})' });
    check(unsafe.status === 400, `the server refuses an unsafe template (${unsafe.status})`);

    // A template that could run script is refused before it is ever a link
    await page.fill('main .field input', 'javascript:alert({path})');
    await page.waitFor(`return document.body.innerText.includes('That scheme is not allowed')`, { label: 'the unsafe scheme is refused' });
    check(await page.eval(`return document.querySelector('main .btn-primary').disabled`), 'an unsafe template cannot be saved');

    // Back on the chat, the link follows the setting and the host path
    await page.goto(`/chats/${SESSION}`, 1500);
    await page.waitFor(`return !!document.querySelector('.obs-changes')`, { label: 'the changes card again' });
    const mapped = await page.eval(`return [...document.querySelectorAll('.obs-changes a.btn')].find((a) => a.textContent.includes('Open worktree in editor'))?.getAttribute('href') ?? null`);
    check(mapped === 'cursor://file/home/dev/feature', `the worktree link uses the template and the host path (${mapped})`);

    // Accessibility of what was added: the card, and the dialog that opens over it
    const violations = await page.axe({ include: '.run-side' });
    check(violations.length === 0, `the side cards have accessibility violations: ${JSON.stringify(violations)}`);
    await page.click('.obs-file-name', 'greet.ts');
    await page.waitFor(`return !!document.querySelector('[role=dialog] .obs-diff')`, { label: 'the diff opens again' });
    const dialog = await page.axe({ include: '[role=dialog]' });
    check(dialog.length === 0, `the diff dialog has accessibility violations: ${JSON.stringify(dialog)}`);
  } finally {
    await page.eval(`localStorage.removeItem(${JSON.stringify(EDITOR_KEY)}); return true`).catch(() => {});
    await api.put('/settings/editor', { template: 'vscode://file/{path}:{line}' }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
    if (seeded) rmSync(seeded, { recursive: true, force: true });
  }
};
