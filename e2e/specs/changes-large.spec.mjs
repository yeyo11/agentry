// A long diff never freezes the review (docs/plans/changes-review.md, rule 10): a generated file of
// 20 000 lines with a change every fourth line draws its rows in every mode, from the first mount,
// scrolls to its last line, keeps the block rail to a few hundred ticks, and is never asked for
// whole (`context=full`), so its gaps stay shut.
//
// It seeds a repository with a worktree and a transcript that says the chat worked there, as
// changes-review.spec.mjs does. Everything seeded is removed at the end.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION = 'e2e-large-session';
const LINES = 20_000;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();
const table = (pass) => Array.from({ length: LINES }, (_, i) => (i % 4 === 0 ? `export const value${i} = ${pass * i}; // pass ${pass}` : `export const keep${i} = '${i}';`)).join('\n') + '\n';

function seed(root, configDir) {
  const main = join(root, 'big');
  const tree = join(root, 'big-large');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'generated.ts'), table(1));
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'initial commit');
  git(main, 'worktree', 'add', '-q', '-b', 'feature/large', tree);
  writeFileSync(join(tree, 'generated.ts'), table(2));
  git(tree, 'commit', '-qam', 'regenerate the table');
  const dir = join(configDir, 'projects', tree.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    [
      { type: 'worktree-state', worktreeSession: { worktreePath: tree, originalCwd: main, worktreeName: 'big-large', worktreeBranch: 'feature/large' } },
      { type: 'user', uuid: 'lg-1', timestamp: at, cwd: tree, message: { role: 'user', content: 'Regenerate the table' } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
  );
  return dir;
}

export default async ({ page, api, check }) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-e2e-large-'));
  let seeded = null;
  const rows = () => page.eval(`return document.querySelectorAll('.changes-review .diff-row:not(.diff-split-head)').length`);
  try {
    const { configDir } = (await api.get('/system')).body;
    seeded = seed(root, configDir);
    await page.viewport(1440, 1024);
    for (const mode of ['reading', 'unified', 'split']) {
      await page.goto(`/chats/${SESSION}/changes?file=generated.ts&mode=${mode}`, 1500);
      await page.waitFor(`return document.querySelector('.changes-review .diff')?.dataset.mode === ${JSON.stringify(mode)}`, { label: `${mode} opens` });
      await page.waitFor(`return document.querySelectorAll('.changes-review .diff-row:not(.diff-split-head)').length > 0`, { label: `${mode} draws its first rows` });
      const drawn = await rows();
      check(drawn > 10 && drawn < 400, `${mode} keeps only the rows near the viewport in the page (${drawn})`);
      await page.eval(`const s = document.querySelector('.changes-diff-scroll'); s.scrollTop = s.scrollHeight; return true`);
      await page.waitFor(`return [...document.querySelectorAll('.changes-review .diff-num')].some((n) => n.textContent.trim() === '${LINES}')`, { label: `${mode} scrolls to line ${LINES}` });
      // Each page load has its own resource timeline, so this is asked of every mode
      check(
        !(await page.eval(`return performance.getEntriesByType('resource').some((e) => e.name.includes('/changes/diff') && e.name.includes('context=full'))`)),
        `${mode}: a diff this long is never asked for whole`,
      );
    }
    const ticks = await page.eval(`return document.querySelectorAll('.changes-review .diff-rail-tick').length`);
    check(ticks > 0 && ticks <= 240, `the block rail merges 5 000 blocks into a few hundred ticks (${ticks})`);
    check(!(await page.eval(`return !!document.querySelector('.changes-review .diff-gap button')`)), 'the gaps of a file this long offer nothing to open');
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (seeded) rmSync(seeded, { recursive: true, force: true });
  }
};
