import assert from 'node:assert/strict';
import test from 'node:test';
import { activityTarget, activityVerb, elapsedSince, formatElapsed, spinnerGlyph, SPINNER_FRAMES, SPINNER_STILL, type TickerActivity } from '../src/lib/live.ts';

// The ticker is the one line that says what an agent is doing. It has to name the doing in a word a
// person would use, and it must not claim to know what a tool it has never heard of does.

const at = (activity: Partial<TickerActivity>): TickerActivity => ({ kind: 'tool', since: '2026-09-21T10:00:00.000Z', ...activity });

test('each tool reads as the verb someone would use for it', () => {
  const verbs: Array<[string, string]> = [
    ['Edit', 'editing'],
    ['Write', 'editing'],
    ['Read', 'reading'],
    ['Bash', 'running'],
    ['Grep', 'searching'],
    ['Glob', 'searching'],
    ['Task', 'delegating'],
    ['Agent', 'delegating'],
    ['WebFetch', 'browsing'],
    ['WebSearch', 'browsing'],
  ];
  for (const [tool, verb] of verbs) assert.equal(activityVerb(at({ tool })), verb, tool);
});

test('what the agent is doing without a tool has its own verb', () => {
  assert.equal(activityVerb(at({ kind: 'writing' })), 'writing');
  assert.equal(activityVerb(at({ kind: 'thinking' })), 'thinking');
  assert.equal(activityVerb(at({ kind: 'waiting' })), 'waiting');
});

test('a tool nobody has mapped is not given an invented verb: it says its own name instead', () => {
  const activity = at({ tool: 'NotebookRunCell', target: 'analysis.ipynb' });
  assert.equal(activityVerb(activity), 'working');
  assert.equal(activityTarget(activity), 'NotebookRunCell analysis.ipynb');
});

test('an MCP tool is named by the part a person chose, not by its full wiring', () => {
  assert.equal(activityTarget(at({ tool: 'mcp__linear__create_issue' })), 'create_issue');
});

test('a mapped tool has said its name in the verb, so only its target is shown', () => {
  assert.equal(activityTarget(at({ tool: 'Edit', target: 'src/app.ts' })), 'src/app.ts');
  assert.equal(activityTarget(at({ kind: 'thinking', target: '' })), '');
});

test('the spinner walks its frames and holds still when motion is turned down', () => {
  assert.equal(spinnerGlyph(0), SPINNER_FRAMES[0]);
  assert.equal(spinnerGlyph(11), SPINNER_FRAMES[1]);
  assert.equal(spinnerGlyph(-1), SPINNER_FRAMES[9]);
  assert.equal(spinnerGlyph(3, false), SPINNER_STILL);
});

test('elapsed time keeps its width and stays short', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(42_000), '42s');
  assert.equal(formatElapsed(184_000), '3:04');
  assert.equal(formatElapsed(3_723_000), '1:02:03');
  assert.equal(formatElapsed(-5), '0s');
});

test('a timestamp the CLI never wrote counts as no time at all rather than as 1970', () => {
  assert.equal(elapsedSince('not a date', Date.parse('2026-09-21T10:00:05.000Z')), 0);
  assert.equal(elapsedSince('2026-09-21T10:00:00.000Z', Date.parse('2026-09-21T10:00:05.000Z')), 5000);
  assert.equal(elapsedSince('2026-09-21T10:00:09.000Z', Date.parse('2026-09-21T10:00:05.000Z')), 0);
});
