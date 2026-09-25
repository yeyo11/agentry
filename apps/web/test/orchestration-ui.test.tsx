// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressBar } from '../src/components/ProgressBar';
import { Stepper } from '../src/components/Stepper';

// The orchestration screens draw progress as a cell per task and their steps as a pipeline of bars
// (docs/design-system.md §3). Both keep saying in words what the colours say.

const cells = (html: string) => [...html.matchAll(/progress-segbar-cell is-(\w+)/g)].map((m) => m[1]);

test('a segmented bar has one cell per task, in the order a bar draws them', () => {
  const html = renderToStaticMarkup(<ProgressBar variant="segments" counts={{ done: 2, running: 1, failed: 1, pending: 2 }} unit="tasks" />);
  assert.deepEqual(cells(html), ['done', 'done', 'running', 'failed', 'pending', 'pending']);
  // Still one progressbar, named for a screen reader; the cells themselves are decoration
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 1);
  assert.match(html, /aria-valuenow="2"/);
  assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 6);
});

test('a graph too big for a cell per task falls back to a bar by share', () => {
  const html = renderToStaticMarkup(<ProgressBar variant="segments" counts={{ done: 30, pending: 10 }} />);
  assert.equal(cells(html).length, 0);
  assert.match(html, /class="progress"/);
});

test('the pipeline fills each bar by how far its step got and says its state in words', () => {
  const html = renderToStaticMarkup(
    <Stepper
      variant="pipeline"
      label="Steps"
      selected="b"
      onSelect={() => {}}
      steps={[
        { id: 'a', label: 'Stage 1', state: 'done', meta: '1/1' },
        { id: 'b', label: 'Stage 2', state: 'failed', meta: '2/4' },
        { id: 'c', label: 'Synthesis', state: 'pending' },
      ]}
    />,
  );
  assert.match(html, /class="stepper is-pipeline"/);
  assert.deepEqual([...html.matchAll(/<i style="width:(\d+)%"/g)].map((m) => m[1]), ['100', '100', '0']);
  // The state words are visible text, so nothing hides them from a reader either
  assert.doesNotMatch(html, /sr-only/);
  assert.match(html, /1\/1 · step\.done/);
  assert.match(html, /aria-current="step"[^>]*>(?:(?!<\/button>).)*Stage 2/);
});
