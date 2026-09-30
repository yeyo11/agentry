// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionPointStats, DecisionStats } from '@agentry/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../src/i18n';
import { DecisionsLineView } from '../src/components/DecisionsLine';

// The Usage page's decisions line (D3 u5): what Jev cost and how many Claude runs were saved.

const stat = (count: number): DecisionPointStats => ({
  point: 'board.triage',
  count,
  acted: 0,
  unavailable: 0,
  meanConfidence: null,
  resolved: 0,
  agreed: 0,
  useful: 0,
  notUseful: 0,
  costUsd: 0,
  runsSaved: 0,
});
const stats = (count: number, over: Partial<DecisionStats> = {}): DecisionStats => ({ since: '2026-09-01T00:00:00.000Z', points: [stat(count)], jevCostUsd: 0.38, claudeRunsSaved: 37, ...over });
const render = (value: DecisionStats) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <DecisionsLineView stats={value} />
    </MemoryRouter>,
  );

test('the line says what Jev cost and how many runs were saved, with a link to the history', async () => {
  await i18n.changeLanguage('en');
  const html = render(stats(12));
  assert.match(html, /Decisions/);
  assert.match(html, /Jev 0[.,]38/);
  assert.match(html, /37 Claude runs saved/);
  assert.match(html, /href="\/settings\?tab=decisions"/);
  await i18n.changeLanguage('es');
  assert.match(render(stats(12, { claudeRunsSaved: 1 })), /1 ejecución de Claude ahorrada/);
  await i18n.changeLanguage('en');
});

test('the line is hidden when no decision was recorded in the window', async () => {
  await i18n.changeLanguage('en');
  assert.equal(render(stats(0)), '');
  assert.equal(render({ ...stats(0), points: [] }), '');
});
