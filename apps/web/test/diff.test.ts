import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  blocksOf,
  blockStarts,
  diffHash,
  foldFull,
  openGap,
  parseUnified,
  readingRows,
  splitRows,
  statsOf,
  unifiedRows,
  whereOf,
  type DiffRow,
  type GapRow,
  type SplitRow,
} from '../src/lib/diff.ts';

// The comparator's reading of a unified diff (docs/plans/changes-review.md, task `diff-lib`),
// against the real diffs the prototypes of the Changes section draw.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const GIT = parseUnified(fixture('git.ts.diff'));

/** A row as the prototype writes it: `2 mod −1`, `9 del`, `gap 21 aheadCount()` */
function show(row: DiffRow): string {
  if (row.type === 'gap') return `gap ${row.gap.size} ${row.gap.where ?? ''}`.trim();
  if (row.type === 'seam') return `seam −${row.pill.count}${row.pill.open ? ' open' : ''}`;
  const no = row.kind === 'del' ? row.line.old : row.line.new;
  return `${no} ${row.kind}${row.pill ? ` −${row.pill.count}${row.pill.open ? ' open' : ''}` : ''}`;
}

test('parsing numbers every line on the side it exists on and drops the file header', () => {
  assert.equal(GIT.hunks.length, 3);
  assert.equal(GIT.status, 'modified');
  assert.equal(GIT.oldPath, 'packages/core/src/git.ts');
  assert.equal(GIT.newPath, 'packages/core/src/git.ts');
  const [first] = GIT.hunks;
  assert.deepEqual([first!.oldStart, first!.oldLines, first!.newStart, first!.newLines], [1, 9, 1, 12]);
  assert.equal(first!.lines.length, 14);
  assert.deepEqual(first!.lines[0], { kind: 'ctx', text: "import { execFileSync } from 'node:child_process';", old: 1, new: 1 });
  assert.deepEqual(first!.lines[1], { kind: 'del', text: "import type { ChangedFile, Commit } from '@agentry/shared';", old: 2, new: null });
  assert.equal(first!.lines[2]!.new, 2);
  assert.equal(first!.lines[2]!.old, null);
  // No line of the header leaks in as content
  assert.ok(GIT.hunks.every((h) => h.lines.every((l) => !l.text.startsWith('-- a/') && !l.text.startsWith('++ b/'))));
  assert.equal(GIT.hunks[1]!.section, 'export function aheadCount(dir: string, base: string, ref: string): number {');
  assert.equal(GIT.newLength, 70);
  assert.deepEqual([GIT.binary, GIT.truncated, GIT.tooLarge, GIT.full], [false, false, false, false]);
});

test('parsing recognises a new, a deleted, a renamed and a binary file', () => {
  const added = parseUnified('diff --git a/x.ts b/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n');
  assert.equal(added.status, 'added');
  assert.deepEqual(added.hunks[0]!.lines.map((l) => [l.kind, l.new]), [['add', 1], ['add', 2]]);
  assert.deepEqual(added.gaps, [null, null]);

  const deleted = parseUnified('diff --git a/x.ts b/x.ts\ndeleted file mode 100644\n--- a/x.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n');
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual(readingRows(deleted).map(show), ['seam −2']);

  const renamed = parseUnified('diff --git a/a.css b/b.css\nsimilarity index 100%\nrename from a.css\nrename to b.css\n');
  assert.deepEqual([renamed.status, renamed.oldPath, renamed.newPath, renamed.hunks.length], ['renamed', 'a.css', 'b.css', 0]);

  const binary = parseUnified('diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n');
  assert.equal(binary.binary, true);
  assert.equal(binary.hunks.length, 0);
});

test('"No newline at end of file" marks the line before it, and is no line itself', () => {
  const d = parseUnified('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  const lines = d.hunks[0]!.lines;
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.noNewline, true);
  assert.equal(lines[1]!.noNewline, true);
});

test('the two cut markers of the server are recognised', () => {
  const cut = parseUnified('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n… diff truncated\n');
  assert.equal(cut.truncated, true);
  assert.equal(cut.hunks[0]!.lines.length, 3);
  assert.ok(cut.hunks[0]!.lines.every((l) => !l.text.includes('truncated')));
  const big = parseUnified('… diff too large to show\n');
  assert.equal(big.tooLarge, true);
  assert.equal(big.hunks.length, 0);
});

test('a hunk is context and blocks, each a run of removals then of additions', () => {
  const items = blocksOf(GIT.hunks[1]!);
  const blocks = items.filter((i) => i.type === 'block');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => [b.dels.length, b.adds.length, b.newLine]), [[1, 2, 37], [2, 3, 40]]);
  // A removal after additions starts another block
  const d = parseUnified('@@ -1,2 +1,2 @@\n-a\n+b\n-c\n+d\n');
  assert.equal(blocksOf(d.hunks[0]!).length, 2);
});

test('removed lines pair with the most similar added line after the last pair', () => {
  // `fileDiff(…)` faces its new self, and `const args` skips the new `const unified` to face its own
  const block = blocksOf(GIT.hunks[1]!).filter((i) => i.type === 'block')[1]!;
  assert.deepEqual(block.pairs, [0, 2]);
  // A line that moved down a row still faces its old self
  const moved = parseUnified('@@ -1,1 +1,2 @@\n-const total = items.length;\n+// how many there are\n+const total = items.length + 1;\n');
  assert.deepEqual((blocksOf(moved.hunks[0]!)[0] as { pairs: number[] }).pairs, [1]);
  // Nothing alike enough: no pair
  const rewrite = parseUnified('@@ -1,1 +1,1 @@\n-alpha beta gamma\n+export default {}\n');
  assert.deepEqual((blocksOf(rewrite.hunks[0]!)[0] as { pairs: number[] }).pairs, [-1]);
});

test('Reading draws git.ts as the prototype does: new file, pills, gaps of 21 and 19 lines', () => {
  assert.deepEqual(readingRows(GIT).map(show), [
    '1 ctx',
    '2 mod −1',
    '3 add',
    '4 add',
    '5 add',
    '6 ctx',
    '7 ctx',
    '8 ctx',
    '9 mod −1',
    '10 ctx',
    '11 ctx',
    '12 ctx',
    'gap 21 aheadCount()',
    '34 ctx',
    '35 ctx',
    '36 ctx',
    '37 mod −1',
    '38 add',
    '39 ctx',
    '40 mod −2',
    '41 add',
    '42 mod',
    '43 ctx',
    '44 ctx',
    '45 ctx',
    'gap 19 diffFiles()',
    '65 ctx',
    '66 ctx',
    '67 ctx',
    '68 add',
    '69 ctx',
    '70 ctx',
  ]);
});

test('an opened block shows its removed lines in place, before its new ones', () => {
  const rows = readingRows(GIT, new Set([1]));
  const at = rows.findIndex((r) => show(r) === '8 ctx');
  assert.deepEqual(rows.slice(at + 1, at + 3).map(show), ['6 del', '9 mod −1 open']);
  const del = rows[at + 1]!;
  assert.ok(del.type === 'line' && del.blockStart && del.pair?.new === 9);
  // Removed lines nothing replaced sit on a seam, and open under it
  const d = parseUnified('@@ -1,4 +1,2 @@\n a\n-b\n-c\n d\n');
  assert.deepEqual(readingRows(d).map(show), ['1 ctx', 'seam −2', '2 ctx']);
  assert.deepEqual(readingRows(d, new Set([0])).map(show), ['1 ctx', 'seam −2 open', '2 del', '3 del', '2 ctx']);
});

test('Unified interleaves removed and added lines with both numbers', () => {
  const rows = unifiedRows(GIT);
  const lines = rows.filter((r) => r.type === 'line');
  assert.equal(lines.filter((r) => r.kind === 'del').length, 5);
  assert.equal(lines.filter((r) => r.kind === 'add').length, 11);
  assert.deepEqual(rows.slice(0, 7).map(show), ['1 ctx', '2 del', '2 add', '3 add', '4 add', '5 add', '6 ctx']);
  const ctx = rows[6]!;
  assert.ok(ctx.type === 'line' && ctx.line.old === 3 && ctx.line.new === 6);
  assert.equal(rows.filter((r): r is GapRow => r.type === 'gap').map((r) => r.gap.size).join(','), '21,19');
  // Every block starts at its first row
  assert.equal(lines.filter((r) => r.blockStart).length, 5);
});

test('Side by side faces paired lines and pads the shorter side', () => {
  const rows = splitRows(GIT).filter((r): r is SplitRow => r.type === 'split');
  const side = (r: SplitRow) => `${r.left ? `${r.left.line.old}${r.left.kind[0]}` : '·'}|${r.right ? `${r.right.line.new}${r.right.kind[0]}` : '·'}`;
  assert.deepEqual(rows.slice(0, 6).map(side), ['1c|1c', '2d|2a', '·|3a', '·|4a', '·|5a', '3c|6c']);
  // `fileDiff` with `fileDiff`, the new `const unified` alone, `const args` with `const args`
  const at = rows.findIndex((r) => r.right?.line.new === 40);
  assert.deepEqual(rows.slice(at, at + 3).map(side), ['36d|40a', '·|41a', '37d|42a']);
  assert.equal(rows[at]!.left!.pair?.new, 40);
  // Unpaired lines face each other in order
  const d = parseUnified('@@ -1,2 +1,3 @@\n-alpha beta\n-gamma delta\n+one\n+two\n+three\n');
  assert.deepEqual(splitRows(d).map((r) => side(r as SplitRow)), ['1d|1a', '2d|2a', '·|3a']);
});

test('a hunk filter keeps block numbering and leaves the gaps out', () => {
  const rows = unifiedRows(GIT, { hunks: new Set([1]) });
  assert.ok(rows.every((r) => r.type === 'line'));
  assert.deepEqual([...new Set(rows.flatMap((r) => (r.type === 'line' && r.block !== null ? [r.block] : [])))], [2, 3]);
});

test('the other samples read too', () => {
  for (const [name, blocks, add, del] of [
    ['types.ts.diff', 2, 6, 1],
    ['changes.ts.diff', 3, 11, 3],
    ['Changes.tsx.diff', 2, 6, 7],
  ] as const) {
    const d = parseUnified(fixture(name));
    assert.deepEqual(statsOf(d), { additions: add, deletions: del, hunks: 1, blocks }, name);
  }
});

test('stats, block starts and the hash', () => {
  assert.deepEqual(statsOf(GIT), { additions: 11, deletions: 5, hunks: 3, blocks: 5 });
  assert.deepEqual(
    blockStarts(GIT).map((b) => [b.kind, b.newLine, b.adds]),
    [
      ['mod', 2, 4],
      ['mod', 9, 1],
      ['mod', 37, 2],
      ['mod', 40, 3],
      ['add', 68, 1],
    ],
  );
  const text = fixture('git.ts.diff');
  assert.equal(diffHash(text), diffHash(text));
  assert.notEqual(diffHash(text), diffHash(`${text} `));
  assert.match(diffHash(''), /^[0-9a-z]+$/);
});

test('the fold names the function the next hunk is in', () => {
  assert.equal(whereOf('export function aheadCount(dir: string): number {'), 'aheadCount()');
  assert.equal(whereOf('export class Changes {'), 'Changes');
  assert.equal(whereOf('const run = async (x: number) => {'), 'run()');
  assert.equal(whereOf('def parse(self):'), 'parse()');
  assert.equal(whereOf('  render() {'), 'render()');
  assert.equal(whereOf('## Heading'), '## Heading');
  assert.equal(whereOf(''), null);
});

/** A full diff of a 40-line file with one line changed at 20 */
function fullDiff(): string {
  const body: string[] = [];
  for (let n = 1; n <= 40; n++) {
    if (n === 20) body.push('-line 20', '+line twenty');
    else body.push(` line ${n}`);
  }
  return `--- a/f\n+++ b/f\n@@ -1,40 +1,40 @@\n${body.join('\n')}\n`;
}

test('foldFull cuts a whole file back to 3 lines of context, keeping what it hides', () => {
  const full = parseUnified(fullDiff(), true);
  assert.equal(full.full, true);
  const folded = foldFull(full);
  assert.equal(folded.hunks.length, 1);
  const h = folded.hunks[0]!;
  assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [17, 7, 17, 7]);
  assert.deepEqual(
    folded.gaps.map((g) => g && [g.size, g.lines?.length, g.newStart]),
    [
      [16, 16, 1],
      [17, 17, 24],
    ],
  );
  assert.deepEqual(readingRows(folded).map(show), ['gap 16 line 16', '17 ctx', '18 ctx', '19 ctx', '20 mod −1', '21 ctx', '22 ctx', '23 ctx', 'gap 17']);
  // "Show" opens a gap from what the diff already holds
  const opened = openGap(folded, 0);
  assert.equal(opened.hunks[0]!.oldStart, 1);
  assert.equal(opened.hunks[0]!.lines.length, 24);
  assert.equal(opened.gaps[0], null);
  assert.equal(opened.gaps[1]?.size, 17);
  assert.equal(opened.gaps[1]?.index, 1);
  const both = openGap(opened, 1);
  assert.equal(both.hunks[0]!.lines.length, 41);
  assert.deepEqual(both.gaps, [null, null]);
  // A diff that is not full is left as it is
  assert.equal(foldFull(GIT), GIT);
});

test('foldFull leaves runs of 8 lines or fewer whole, and splits hunks between far changes', () => {
  const lines = ['-a', '+A', ...Array.from({ length: 8 }, (_, k) => ` ${k}`), '-b', '+B', ...Array.from({ length: 9 }, (_, k) => ` x${k}`), '-c', '+C'];
  const folded = foldFull(parseUnified(`@@ -1,20 +1,20 @@\n${lines.join('\n')}\n`, true));
  // 8 unchanged lines stay; 9 fold to 3 + 3 with 3 hidden
  assert.equal(folded.hunks.length, 2);
  assert.deepEqual(
    folded.gaps.map((g) => g?.size ?? null),
    [null, 3, null],
  );
  assert.equal(folded.hunks[1]!.section, 'x5');
});
