// Step by step (docs/plans/changes-review.md, `steps`): every edit of the transcript in order, each
// with the sentence Claude wrote before it and its own patch; the arrows move between steps, the
// file filter narrows the list, and "See it in the conversation" opens the chat at that edit. A
// phone shows one step at a time with Previous and Next.
//
// It seeds a repository with a worktree and a transcript whose edits carry the patches the CLI
// stores (`structuredPatch`), so nothing needs a live process. Everything seeded is removed at the
// end, because other specs count what the sandbox holds.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION = 'e2e-steps-session';

const line = (o) => JSON.stringify(o);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

function seedRepo(root) {
  const main = join(root, 'app');
  const tree = join(root, 'app-steps');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'greet.ts'), ['export function greet(name: string) {', "  return 'hello ' + name;", '}', ''].join('\n'));
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'initial commit');
  git(main, 'worktree', 'add', '-q', '-b', 'feature/steps', tree);
  writeFileSync(join(tree, 'greet.ts'), ['export function greet(name: string) {', "  return `hello, ${name}!`;", '}', '// Said twice', ''].join('\n'));
  writeFileSync(join(tree, 'fresh.ts'), 'export const fresh = true;\n');
  return { main, tree };
}

/** Three edits: two on greet.ts and a new file, each after a sentence of Claude's */
function seedTranscript(configDir, { main, tree }) {
  const dir = join(configDir, 'projects', tree.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.now() - 600_000 + s * 1000).toISOString();
  let n = 0;
  const assistant = (content, s) =>
    line({ type: 'assistant', uuid: `st-${++n}`, timestamp: at(s), cwd: tree, message: { role: 'assistant', id: `msg-st-${n}`, model: 'claude-sonnet-5', content, usage: { input_tokens: 10, output_tokens: 10 } } });
  const result = (id, toolUseResult, s) =>
    line({ type: 'user', uuid: `st-${++n}`, timestamp: at(s), cwd: tree, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult });
  const edit = (id, file, s) => assistant([{ type: 'tool_use', id, name: 'Edit', input: { file_path: join(tree, file), old_string: 'a', new_string: 'b' } }], s);
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    [
      line({ type: 'worktree-state', worktreeSession: { worktreePath: tree, originalCwd: main, worktreeName: 'app-steps', worktreeBranch: 'feature/steps' } }),
      line({ type: 'user', uuid: `st-${++n}`, timestamp: at(0), cwd: tree, message: { role: 'user', content: 'Make greet friendlier' } }),
      assistant([{ type: 'text', text: 'The greeting gets a comma and a bang, with `name` in a template.' }], 1),
      edit('step-1', 'greet.ts', 2),
      result('step-1', { filePath: join(tree, 'greet.ts'), structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' export function greet(name: string) {', "-  return 'hello ' + name;", '+  return `hello, ${name}!`;', ' }'] }] }, 3),
      assistant([{ type: 'text', text: 'A new flag for the callers.' }], 4),
      assistant([{ type: 'tool_use', id: 'step-2', name: 'Write', input: { file_path: join(tree, 'fresh.ts'), content: 'export const fresh = true;\n' } }], 5),
      result('step-2', { type: 'create', filePath: join(tree, 'fresh.ts'), content: 'export const fresh = true;\n', structuredPatch: [] }, 6),
      assistant([{ type: 'text', text: 'A note at the end of greet.ts.' }], 7),
      edit('step-3', 'greet.ts', 8),
      result('step-3', { filePath: join(tree, 'greet.ts'), structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [' }', '+// Said twice'] }] }, 9),
    ].join('\n') + '\n',
  );
  return dir;
}

export default async ({ page, api, check }) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-e2e-steps-'));
  let seeded = null;
  try {
    const repo = seedRepo(root);
    const { configDir } = (await api.get('/system')).body;
    seeded = seedTranscript(configDir, repo);

    const steps = await api.get(`/chats/${SESSION}/changes/steps`);
    check(steps.status === 200 && steps.body.length === 3, `the chat has three steps (${steps.status}, ${steps.body?.length})`);

    // The lens opens on the latest step, with the list, the scrubber and the step itself
    await page.goto(`/chats/${SESSION}/changes?lens=steps`, 1500);
    await page.waitFor(`return document.querySelectorAll('.changes-review .edit-step').length === 3`, { label: 'the list of steps' });
    // textContent: the label is drawn in capitals, which innerText would hand back
    check(await page.eval(`return document.querySelector('.edit-step-bar')?.textContent.includes('Step 3 of 3')`), 'the latest step is shown first');
    check((await page.text('.edit-step-heading')).includes('A note at the end of greet.ts.'), 'the heading is what Claude wrote before the edit');
    check(await page.eval(`return document.querySelectorAll('.edit-scrub > i').length === 3 && !!document.querySelector('.edit-scrub > i.is-current:last-child')`), 'the scrubber has a dot per step, the last one current');
    check((await page.text('.edit-step-patch')).includes('// Said twice'), "the step's own patch is drawn");
    check(await page.eval(`return document.querySelectorAll('.edit-step-card').length === 2`), 'the other step on the same file is a card beside this one');

    // The arrows walk the steps; backticks read as code in the heading
    await page.press('ArrowLeft');
    await page.press('ArrowLeft');
    await page.waitFor(`return document.querySelector('.edit-step-bar')?.textContent.includes('Step 1 of 3')`, { label: '← goes back to the first step' });
    check(await page.eval(`return document.querySelector('.edit-step-heading code')?.textContent === 'name'`), 'what Claude put between backticks is code');
    check((await page.text('.edit-step-patch')).includes('hello, ${name}!'), 'the first patch is the greeting');
    await page.press('ArrowRight');
    await page.waitFor(`return document.querySelector('.edit-step-bar')?.textContent.includes('Step 2 of 3')`, { label: '→ moves on' });

    // The filter keeps one file's steps
    await page.focus('.edit-steps-filter');
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the file filter' });
    await page.click('[role=menu] [role^=menuitem]', 'greet.ts', 600);
    await page.waitFor(`return document.querySelectorAll('.changes-review .edit-step').length === 2`, { label: 'the filter keeps greet.ts' });

    const violations = await page.axe({ include: '.changes-review' });
    check(violations.length === 0, `Step by step has accessibility violations: ${JSON.stringify(violations)}`);

    // "See it in the conversation" opens the chat at the edit, marked
    await page.goto(`/chats/${SESSION}/changes?lens=steps&step=step-1`, 1500);
    await page.waitFor(`return !!document.querySelector('.edit-step-source a')`, { label: 'the link into the conversation' });
    await page.click('.edit-step-source a', 'See it in the conversation', 1500);
    await page.waitFor(`return location.pathname === '/chats/${SESSION}' && !location.search.includes('at=')`, { label: 'the chat opens and the link is read once' });
    await page.waitFor(`return !!document.querySelector('.run-scroll.is-at-jump [data-focused]')`, { label: 'the entry is marked' });
    check((await page.text('[data-focused]')).includes('greet.ts'), 'the marked entry is the edit');

    // A phone shows one step at a time, and Next moves on
    await page.viewport(390, 844);
    await page.goto(`/chats/${SESSION}/changes?lens=steps&step=step-1`, 1500);
    await page.waitFor(`return !!document.querySelector('.edit-steps-phone .diff')`, { label: 'one step on a phone' });
    await page.click('.edit-steps-phone-bar a', 'Next');
    await page.waitFor(`return document.querySelector('.edit-steps-phone-meta')?.textContent.includes('Step 2 of 3')`, { label: 'Next moves on' });
    const small = await page.eval(`return [...document.querySelectorAll('.edit-steps-phone-bar .btn')].every((b) => b.getBoundingClientRect().height >= 44)`);
    check(small, 'the phone buttons are at least 44 px tall');
  } finally {
    await page.viewport(1280, 900).catch(() => {});
    rmSync(root, { recursive: true, force: true });
    if (seeded) rmSync(seeded, { recursive: true, force: true });
  }
};
