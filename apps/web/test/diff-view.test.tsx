// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BlockRail, RAIL_BUCKETS, railTicks } from '../src/components/changes/BlockRail';
import { classOf, diffSyntax, DiffView, type DiffSyntax } from '../src/components/changes/DiffView';
import { Fingerprint } from '../src/components/changes/Fingerprint';
import { highlightRoles, languageOfPath, SYNTAX_CLASS } from '../src/components/highlight';
import i18n from '../src/i18n';
import { blockStarts, parseUnified } from '../src/lib/diff';

// The comparator drawn (design system §5, the `DiffView` and `DSComparador` references): the
// three modes, the pill, the gaps, muted syntax through classes and one mark per changed phrase.

void i18n.changeLanguage('en');
const GIT = parseUnified(readFileSync(new URL('./fixtures/git.ts.diff', import.meta.url), 'utf8'));
const PATH = 'packages/core/src/git.ts';
let syntax: DiffSyntax | null = null;

const rowsOf = (html: string) => [...html.matchAll(/class="diff-row is-(\w+)/g)].map((m) => m[1]);
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test.before(async () => {
  syntax = await diffSyntax(GIT, languageOfPath(PATH));
});

test('syntax roles map onto the muted --sx-* classes, never green or red', async () => {
  assert.deepEqual(SYNTAX_CLASS, {
    fg: null,
    keyword: 'sx-kw',
    string: 'sx-str',
    constant: 'sx-num',
    entity: 'sx-type',
    function: 'sx-fn',
    comment: 'sx-com',
    tag: null,
    deleted: null,
  });
  const lines = await highlightRoles("const a = 'x'; // c\nfoo(1);", 'ts');
  assert.ok(lines);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0]!.find(([text]) => text === 'const'), ['const', 'keyword']);
  assert.ok(lines[0]!.some(([text, role]) => text === "'x'" && role === 'string'));
  assert.ok(lines[0]!.some(([text, role]) => text.includes('// c') && role === 'comment'));
  assert.equal(lines[1]!.map(([text]) => text).join(''), 'foo(1);');
  assert.equal(classOf('const', 'keyword'), 'sx-kw');
  assert.equal(classOf(' === ', 'keyword'), null);
  assert.equal(classOf('<div>', 'tag'), null);
  assert.equal(classOf('x', null), null);
  // A language only shiki knows has no roles: it stays plain inside a diff
  assert.equal(await highlightRoles('fn main() {}', 'rust'), null);
  assert.equal(await highlightRoles('x', 'nope'), null);
});

test('the language of a file comes from its name', () => {
  assert.equal(languageOfPath('packages/core/src/git.ts'), 'ts');
  assert.equal(languageOfPath('apps/web/src/Changes.tsx'), 'tsx');
  assert.equal(languageOfPath('src/main.rs'), 'rust');
  assert.equal(languageOfPath('docker/Dockerfile'), 'dockerfile');
  assert.equal(languageOfPath('README.md'), 'md');
  assert.equal(languageOfPath('LICENSE'), null);
});

test('Reading draws the file as it is now, with pills, gaps and dimmed context', () => {
  const html = renderToStaticMarkup(<DiffView diff={GIT} mode="reading" path={PATH} syntax={syntax} onOpenGap={() => {}} />);
  assert.match(html, /^<div class="diff diff-read"/);
  const rows = rowsOf(html);
  assert.equal(rows.length, 30);
  assert.equal(rows.filter((k) => k === 'mod').length, 5);
  assert.equal(rows.filter((k) => k === 'add').length, 6);
  assert.equal(rows.filter((k) => k === 'del').length, 0);
  // A pill per block with removals, a button that says what it holds and whether it is open
  assert.equal(count(html, /class="diff-fold-pill" aria-expanded="false" aria-label="(1 line|2 lines) removed"/g), 4);
  assert.match(html, />−2<\/button>/);
  // Gaps of 21 and 19 lines, with the function the next hunk is in and "Show"
  assert.match(html, /21 unchanged lines<\/span><span class="diff-gap-in">· in <span class="diff-gap-where">aheadCount\(\)<\/span>/);
  assert.match(html, /19 unchanged lines/);
  assert.equal(count(html, />Show<\/button>/g), 2);
  // Every row says what it is to a screen reader
  assert.match(html, /<span class="sr-only">line 9 changed<\/span>/);
  assert.match(html, /<span class="sr-only">line 3 added<\/span>/);
  assert.match(html, /<span class="sr-only">line 1<\/span>/);
});

test('changed words are one mark spanning their syntax runs, painted through classes', () => {
  const html = renderToStaticMarkup(<DiffView diff={GIT} mode="reading" path={PATH} syntax={syntax} />);
  assert.match(html, /<span class="diff-word">, DiffContext<\/span>/);
  assert.match(html, /<span class="diff-word"><span class="sx-num">64<\/span><\/span>/);
  // `, context: DiffContext = 3` is one mark over five runs
  assert.match(html, /<span class="diff-word">, <span class="sx-type">context<\/span>: <span class="sx-type">DiffContext<\/span> = <span class="sx-num">3<\/span><\/span>/);
  assert.match(html, /<span class="sx-kw">import<\/span>/);
  assert.match(html, /<span class="sx-com">/);
  // Operators stay in the foreground
  assert.doesNotMatch(html, /<span class="sx-kw">[^<\p{L}]+<\/span>/u);
  // No colour of its own: no hex and no inline style in the code
  assert.doesNotMatch(html, /#[0-9a-f]{3,6}\b|style="[^"]*color/i);
  // Unpaired added lines carry no mark: the rail says enough
  const added = html.split('<div class="diff-row is-add"').slice(1);
  assert.ok(added.every((row) => !row.split('</div>')[0]!.includes('diff-word')));
});

test('an opened pill shows the removed lines in place, tinted', () => {
  const html = renderToStaticMarkup(<DiffView diff={GIT} mode="reading" path={PATH} syntax={syntax} opened={new Set([1])} />);
  assert.equal(count(html, /class="diff-row is-del"/g), 1);
  assert.match(html, /<div class="diff-row is-del" data-block-start="1"><span class="sr-only">line 6 removed<\/span>/);
  assert.match(html, /aria-expanded="true" aria-label="1 line removed">−1</);
  assert.match(html, /<span class="diff-word"><span class="sx-num">32<\/span><\/span>/);
});

test('removed lines nothing replaced sit on a seam', () => {
  const d = parseUnified('@@ -1,4 +1,2 @@\n a\n-b\n-c\n d\n');
  const html = renderToStaticMarkup(<DiffView diff={d} mode="reading" />);
  assert.match(html, /<div class="diff-seam" data-block-start="0"><button type="button" class="diff-fold-pill" aria-expanded="false" aria-label="2 lines removed">−2<\/button><\/div>/);
});

test('Unified interleaves with both numbers and a sign', () => {
  const html = renderToStaticMarkup(<DiffView diff={GIT} mode="unified" path={PATH} syntax={syntax} />);
  assert.match(html, /^<div class="diff diff-uni"/);
  const rows = rowsOf(html);
  assert.equal(rows.filter((k) => k === 'del').length, 5);
  assert.equal(rows.filter((k) => k === 'add').length, 11);
  assert.equal(count(html, /diff-fold-pill/g), 0);
  assert.match(html, /<span class="diff-num" aria-hidden="true">2<\/span><span class="diff-num" aria-hidden="true"><\/span><span class="diff-line-rail" aria-hidden="true"><\/span><span class="diff-sign" aria-hidden="true">−<\/span>/);
  // Both sides of a pair are marked
  assert.match(html, /<span class="diff-word"><span class="sx-num">32<\/span><\/span>/);
  assert.match(html, /<span class="diff-word"><span class="sx-num">64<\/span><\/span>/);
  // Without onOpenGap a gap says its size and offers nothing
  assert.equal(count(html, />Show<\/button>/g), 0);
});

test('Side by side faces the paired lines and hatches the padding', () => {
  const html = renderToStaticMarkup(<DiffView diff={GIT} mode="split" path={PATH} syntax={syntax} refs={{ before: '8923191', after: 'b67aa3' }} />);
  assert.match(html, /^<div class="diff diff-split"/);
  assert.match(html, /Before<span class="diff-split-ref">8923191<\/span>/);
  // Line 2 against line 2, then three added lines facing padding
  assert.match(html, /<span class="sr-only">line 2 removed, line 2 added<\/span>/);
  assert.equal(count(html, /class="diff-code diff-cell is-pad"/g), 6);
  assert.match(html, /<span class="sr-only">line 3 added<\/span><span class="diff-num is-pad"/);
});

test('a phone wraps, and a hunk filter draws one patch', () => {
  const html = renderToStaticMarkup(<DiffView diff={GIT} mode="unified" wrap hunks={new Set([2])} />);
  assert.match(html, /^<div class="diff diff-uni diff-wrap"/);
  assert.equal(count(html, /class="diff-gap"/g), 0);
  assert.deepEqual(rowsOf(html), ['ctx', 'ctx', 'ctx', 'add', 'ctx', 'ctx']);
});

test('what cannot be drawn is said', () => {
  const say = (text: string) => renderToStaticMarkup(<DiffView diff={parseUnified(text)} mode="reading" />);
  assert.match(say('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n'), /Binary file: there is no text to compare\./);
  assert.match(say('… diff too large to show\n'), /This diff is too large to show\./);
  assert.match(say('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n'), /Only renamed/);
  assert.match(say('@@ -1,2 +1,2 @@\n a\n-b\n+c\n… diff truncated\n'), /The diff is cut here/);
});

test('the block rail draws the file to scale, a mark per block', () => {
  const html = renderToStaticMarkup(<BlockRail marks={blockStarts(GIT)} total={GIT.newLength} current={1} view={{ top: 0, height: 0.46 }} />);
  assert.match(html, /^<div class="diff-rail" aria-hidden="true">/);
  assert.match(html, /<div class="diff-rail-view" style="top:0.00%;height:46.00%"><\/div>/);
  assert.match(html, /class="diff-rail-tick is-mod" style="top:1.43%;height:5.71%"/);
  assert.match(html, /class="diff-rail-tick is-mod is-current" style="top:11.43%;height:1.43%"/);
  assert.match(html, /class="diff-rail-tick is-add" style="top:95.71%;height:1.43%"/);
  assert.equal(count(html, /diff-rail-tick/g), 5);
});

test('blocks that land on the same stretch of the rail become one tick', () => {
  // A generated file: a one-line change every fourth line, 5 000 blocks for 20 000 lines
  const marks = Array.from({ length: 5_000 }, (_, i) => ({ index: i, kind: i % 2 ? ('add' as const) : ('mod' as const), newLine: i * 4 + 1, oldLine: i * 4 + 1, adds: 1, dels: i % 2 ? 0 : 1 }));
  const ticks = railTicks(marks, 20_000, 2_600);
  assert.ok(ticks.length <= RAIL_BUCKETS, `${ticks.length} ticks`);
  assert.equal(ticks.filter((t) => t.current).length, 1, 'the current block is still marked');
  assert.equal(ticks[0]!.kind, 'mod', 'additions merged with a modification read as one');
  const last = ticks[ticks.length - 1]!;
  assert.ok(Math.abs(last.top + last.height - 1) < 0.001, 'the last tick reaches the end of the file');
  // A short file keeps a tick per block
  assert.equal(railTicks(blockStarts(GIT), GIT.newLength).length, blockStarts(GIT).length);
});

test('the fingerprint is a link per file, as wide as its churn', () => {
  const files = [
    { path: 'a.ts', additions: 11, deletions: 3 },
    { path: 'b.ts', additions: 0, deletions: 10 },
    { path: 'logo.png', additions: 0, deletions: 0 },
  ];
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Fingerprint files={files} current="b.ts" seen={new Set(['a.ts'])} to={(p) => `/chats/c1/changes?file=${encodeURIComponent(p)}`} />
    </MemoryRouter>,
  );
  assert.match(html, /^<nav class="changes-print" aria-label="Change fingerprint/);
  assert.equal(count(html, /<a /g), 3);
  assert.match(html, /class="changes-print-seg is-seen" [^>]*style="flex:14 1 0;--a:79%"[^>]*aria-label="a.ts: 11 added, 3 removed, seen"/);
  assert.match(html, /class="changes-print-seg is-current" [^>]*style="flex:10 1 0;--a:0%"[^>]*aria-current="true"/);
  assert.match(html, /style="flex:1 1 0;--a:50%"/);
  assert.match(html, /href="\/chats\/c1\/changes\?file=a.ts"/);
});
