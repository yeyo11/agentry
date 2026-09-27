// The review of a chat's changes, read inside Agentry (docs/plans/changes-review.md): opened from
// the inspector's summary, the file map and its scopes, one file's diff in Reading, Unified and Side
// by side, a gap that asks for the whole file, "seen" kept across a reload, and a phone that opens a
// file as a screen of its own and moves with its bottom bar.
//
// It builds a real repository with a worktree, as observability.spec.mjs does, and seeds a
// transcript that says the chat worked there, so nothing needs a live process. Everything seeded is
// removed at the end, because other specs count what the sandbox holds.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION = 'e2e-review-session';
const SEEN_KEY = `agentry-review-seen:v1:chat:${SESSION}`;
const MODE_KEY = 'agentry-diff-mode';

const line = (o) => JSON.stringify(o);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

/** 40 lines, so two changes far apart leave a gap between their hunks */
const longFile = (first, last) =>
  Array.from({ length: 40 }, (_, i) => (i === 2 ? first : i === 36 ? last : `export const line${i + 1} = ${i + 1};`)).join('\n') + '\n';

/** A feature branch in its own worktree: one commit, one edit not committed, one new file. */
function seedRepo(root) {
  const main = join(root, 'app');
  const tree = join(root, 'app-review');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'greet.ts'), ['export function greet(name: string) {', "  return 'hello ' + name;", '}', ''].join('\n'));
  writeFileSync(join(main, 'keep.ts'), 'export const keep = 1;\n');
  writeFileSync(join(main, 'long.ts'), longFile('export const start = 1;', 'export const end = 1;'));
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'initial commit');
  git(main, 'worktree', 'add', '-q', '-b', 'feature/review', tree);
  writeFileSync(join(tree, 'greet.ts'), ['export function greet(name: string) {', "  return `hello, ${name}!`;", '}', ''].join('\n'));
  writeFileSync(join(tree, 'long.ts'), longFile('export const start = 2;', 'export const end = 2;'));
  git(tree, 'add', '.');
  git(tree, 'commit', '-q', '-m', 'feat: greet with a comma and a bang');
  // Not committed yet: an edit to a tracked file and a file git has never seen
  writeFileSync(join(tree, 'keep.ts'), 'export const keep = 2;\nexport const extra = 3;\n');
  writeFileSync(join(tree, 'fresh.ts'), 'export const fresh = true;\n');
  return { main, tree };
}

function seedTranscript(configDir, { main, tree }) {
  const dir = join(configDir, 'projects', tree.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const assistant = (n, content, s) =>
    line({ type: 'assistant', uuid: `rv-${n}`, timestamp: at(s), cwd: tree, message: { role: 'assistant', id: `msg-rv-${n}`, model: 'claude-sonnet-5', content, usage: { input_tokens: 10, output_tokens: 10 } } });
  const user = (n, content, s, extra = {}) => line({ type: 'user', uuid: `rv-${n}`, timestamp: at(s), cwd: tree, message: { role: 'user', content }, ...extra });
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    [
      line({ type: 'worktree-state', worktreeSession: { worktreePath: tree, originalCwd: main, worktreeName: 'app-review', worktreeBranch: 'feature/review' } }),
      user(1, 'Make greet friendlier', 0),
      assistant(2, [{ type: 'text', text: 'A comma and a bang read friendlier.' }], 1),
      assistant(3, [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: join(tree, 'greet.ts'), old_string: 'x', new_string: 'y' } }], 2),
      user(4, [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'edited' }], 3, {
        toolUseResult: {
          filePath: join(tree, 'greet.ts'),
          structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' export function greet(name: string) {', "-  return 'hello ' + name;", '+  return `hello, ${name}!`;', ' }'] }],
        },
      }),
    ].join('\n'),
  );
  return dir;
}

export default async ({ page, api, check }) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-e2e-review-'));
  let seeded = null;
  const review = `/chats/${SESSION}/changes`;
  const current = () => page.eval(`return document.querySelector('.changes-file[aria-current=page], .changes-rail-file[aria-current=page]')?.getAttribute('aria-label')?.split(' · ')[0] ?? null`);
  const mode = () => page.eval(`return document.querySelector('.changes-review .diff')?.dataset.mode ?? null`);
  try {
    const repo = seedRepo(root);
    const { configDir } = (await api.get('/system')).body;
    seeded = seedTranscript(configDir, repo);
    await page.viewport(1440, 1024);
    await page.goto('/', 500);
    await page.eval(`localStorage.removeItem(${JSON.stringify(SEEN_KEY)}); localStorage.removeItem(${JSON.stringify(MODE_KEY)}); return true`);

    // ---------- the entry point: the inspector's summary opens the review ----------
    await page.goto(`/chats/${SESSION}`, 1500);
    await page.click('.chat-inspector [role=tab]', 'Changes');
    await page.click('.changes-review-link');
    await page.waitFor(`return location.pathname === ${JSON.stringify(review)} && !!document.querySelector('.changes-review')`, { label: 'the review opens from the summary' });

    // ---------- header and file map ----------
    await page.waitFor(`return document.querySelectorAll('.changes-file').length >= 4`, { label: 'the file map' });
    const head = await page.text('.changes-head');
    check(head.includes('feature/review'), 'the header names the branch');
    check(/from [0-9a-f]{7}/.test(head), 'the header names the commit it branched from');
    check(head.includes('1 commit') && head.includes('4 files'), `the header counts the commits and the files (${head.replace(/\s+/g, ' ')})`);
    const listed = await page.eval(`return [...document.querySelectorAll('.changes-file')].map((e) => e.getAttribute('aria-label'))`);
    for (const name of ['greet.ts', 'keep.ts', 'fresh.ts', 'long.ts']) check(listed.some((l) => l.startsWith(`${name} ·`)), `${name} is in the file map (${listed.join(' | ')})`);
    check(listed.some((l) => l.startsWith('fresh.ts · added') && l.includes('Not committed yet')), 'a file git has never seen is added and not committed yet');
    check(await page.eval(`return !!document.querySelector('.changes-print a[aria-current=true]')`), 'the fingerprint rings the current file');

    // ---------- scopes: a commit, and what is not committed yet ----------
    await page.focus('.changes-scope');
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the scope menu' });
    const scopes = await page.eval(`return [...document.querySelectorAll('[role=menu] [role^=menuitem]')].map((i) => i.textContent.trim())`);
    check(scopes.some((s) => s.includes('feat: greet with a comma and a bang')), `the scope menu lists the commit by its subject (${scopes.join(' | ')})`);
    await page.click('[role=menu] [role^=menuitem]', 'Not committed yet', 900);
    await page.waitFor(`return new URLSearchParams(location.search).get('scope') === 'uncommitted'`, { label: 'the uncommitted scope' });
    const uncommitted = await page.eval(`return [...document.querySelectorAll('.changes-file')].map((e) => e.getAttribute('aria-label').split(' · ')[0]).sort().join(',')`);
    check(uncommitted === 'fresh.ts,keep.ts', `"Not committed yet" lists only the uncommitted files (${uncommitted})`);

    // ---------- Reading: the file as it is now, the removed line folded into a pill ----------
    await page.goto(`${review}?file=greet.ts`, 1500);
    await page.waitFor(`return document.querySelectorAll('.changes-review .diff-row').length > 0`, { label: 'the Reading rows' });
    check((await mode()) === 'reading', 'Reading is the default mode');
    check((await current()) === 'greet.ts', '?file= picks the file');
    const reading = await page.text('.changes-review .diff');
    check(reading.includes('return `hello, ${name}!`;') && !reading.includes("'hello ' + name"), 'Reading shows the file as it is now, without the removed line');
    check(await page.eval(`return document.querySelector('.diff-fold-pill')?.getAttribute('aria-expanded') === 'false'`), 'the removed line is a closed pill');
    await page.click('.diff-fold-pill');
    await page.waitFor(`return document.querySelector('.diff-fold-pill')?.getAttribute('aria-expanded') === 'true' && !!document.querySelector('.changes-review .diff-row.is-del')`, { label: 'the pill opens' });
    check((await page.text('.changes-review .diff-row.is-del')).includes("'hello ' + name"), 'the opened pill shows the removed line in place');
    check((await page.text('.changes-why')).includes('A comma and a bang read friendlier.'), 'the why line quotes what Claude wrote before the edit');

    // ---------- Unified and Side by side ----------
    await page.click('.changes-modes [role=radio]', 'Unified');
    await page.waitFor(`return document.querySelector('.changes-review .diff')?.dataset.mode === 'unified'`, { label: 'Unified' });
    check((await page.text('.changes-review .diff')).includes("'hello ' + name"), 'Unified shows the removed line beside the added one');
    await page.click('.changes-modes [role=radio]', 'Side by side');
    await page.waitFor(`return document.querySelector('.changes-review .diff')?.dataset.mode === 'split'`, { label: 'Side by side' });
    check(await page.eval(`return !!document.querySelector('.changes-map.is-folded')`), 'Side by side folds the file map into a rail');
    check((await page.eval(`return localStorage.getItem(${JSON.stringify(MODE_KEY)})`)) === 'split', 'the mode is remembered in this browser');

    // ---------- deep links, and a gap that asks for the whole file once ----------
    await page.goto(`${review}?file=long.ts&mode=unified`, 1500);
    await page.waitFor(`return document.querySelector('.changes-review .diff')?.dataset.mode === 'unified'`, { label: '?mode= picks the mode' });
    check((await current()) === 'long.ts', '?file= picks long.ts');
    await page.waitFor(`return !!document.querySelector('.diff-gap button')`, { label: 'a gap with Show' });
    const rowsBefore = await page.eval(`return document.querySelectorAll('.changes-review .diff-row').length`);
    await page.click('.diff-gap button', 'Show', 1200);
    await page.waitFor(`return document.querySelectorAll('.changes-review .diff-row').length > ${rowsBefore}`, { label: 'the gap opens' });
    check(
      await page.eval(`return performance.getEntriesByType('resource').some((e) => e.name.includes('/changes/diff') && e.name.includes('context=full'))`),
      'opening a gap the diff does not carry asks for the whole file',
    );
    check((await page.text('.changes-review .diff')).includes('export const line20 = 20;'), 'the gap shows the lines it hid');

    // ---------- seen survives a reload ----------
    await page.click('.changes-seen button[role=checkbox]');
    await page.waitFor(`return document.querySelector('.changes-seen button[role=checkbox]')?.getAttribute('aria-checked') === 'true'`, { label: 'marked as seen' });
    await page.goto(`${review}?file=long.ts&mode=reading`, 1500);
    await page.waitFor(`return !!document.querySelector('.changes-seen button[role=checkbox]')`, { label: 'the file again' });
    check((await page.eval(`return document.querySelector('.changes-seen button[role=checkbox]').getAttribute('aria-checked')`)) === 'true', 'seen survives a reload');
    check((await page.text('.changes-map-head')).includes('1 of 4 seen'), 'the map counts what was seen');
    check(await page.eval(`return !!document.querySelector('.changes-file.is-seen[aria-label^="long.ts"]')`), 'the seen file is marked in the map');

    // ---------- keyboard: j moves between blocks, p to the previous file (long.ts is the last) ----------
    await page.key('j');
    check((await page.text('.changes-blocks-count')).includes('1 /'), 'j moves to the first block');
    const before = await current();
    await page.key('p');
    await page.waitFor(`return document.querySelector('.changes-file[aria-current=page], .changes-rail-file[aria-current=page]')?.getAttribute('aria-label')?.split(' · ')[0] !== ${JSON.stringify(before)}`, { label: 'p opens the previous file' });

    // ---------- accessibility ----------
    // The chrome of the screen in full; the diff's own dimmed context and line numbers are the
    // comparator's design (design system §5) and are scanned without the contrast rule
    for (const part of ['.changes-head', '.changes-map', '.changes-file-head']) {
      const found = await page.axe({ include: part });
      check(found.length === 0, `${part} has accessibility violations: ${JSON.stringify(found)}`);
    }
    const diffScan = await page.axe({ include: '.changes-review', rules: { 'color-contrast': { enabled: false } } });
    check(diffScan.length === 0, `the review has accessibility violations: ${JSON.stringify(diffScan)}`);

    // ---------- a phone: the files as cells, a file as its own screen ----------
    await page.viewport(390, 844);
    await page.goto(review, 1500);
    await page.waitFor(`return document.querySelectorAll('.changes-cell').length >= 4`, { label: 'the files as cells' });
    check(await page.eval(`return !document.querySelector('.tabbar') || getComputedStyle(document.querySelector('.tabbar')).display === 'none' || document.querySelector('.tabbar').offsetParent === null`), 'the review hides the tab bar');
    await page.click('.changes-cell', 'greet.ts', 1200);
    await page.waitFor(`return !!document.querySelector('.changes-phone-file .diff.diff-wrap')`, { label: 'a file opens as its own screen, wrapped' });
    check(!(await page.eval(`return [...document.querySelectorAll('.changes-modes [role=radio], .changes-phone-modes [role=radio]')].some((r) => r.textContent.includes('Side by side'))`)), 'a phone offers no Side by side');
    const phoneName = await page.text('.changes-phone-name');
    await page.click('.changes-phone-bar .changes-phone-step.is-next', undefined, 1200);
    await page.waitFor(`return document.querySelector('.changes-phone-name')?.textContent !== ${JSON.stringify(phoneName)}`, { label: 'the bottom bar moves to the next file' });
    const sizes = await page.eval(`return [...document.querySelectorAll('.changes-phone-bar .icon-btn')].map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); })`);
    check(sizes.length === 2 && sizes.every((s) => s >= 44), `the block buttons are 44 px (${sizes.join(', ')})`);
    const phoneScan = await page.axe({ include: '.changes-review', rules: { 'color-contrast': { enabled: false } } });
    check(phoneScan.length === 0, `the phone screen has accessibility violations: ${JSON.stringify(phoneScan)}`);
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem(${JSON.stringify(SEEN_KEY)}); localStorage.removeItem(${JSON.stringify(MODE_KEY)}); return true`).catch(() => {});
    rmSync(root, { recursive: true, force: true });
    if (seeded) rmSync(seeded, { recursive: true, force: true });
  }
};
