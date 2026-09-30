// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionRecord } from '@agentry/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionMarkOf } from '../src/components/DecisionMark';
import i18n from '../src/i18n';

// The "decided" mark (D3 u4): its face, and that it is only a button until it is opened.

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: 'd1',
  point: 'board.triage',
  kind: 'suggest',
  projectId: null,
  subjectKind: 'work_item',
  subjectId: 'w1',
  provider: 'jev',
  model: 'jev-1.13.0',
  mode: 'active',
  status: 'answered',
  unavailable: null,
  state: {},
  questions: [
    {
      kind: 'choice',
      id: 'type',
      question: 'Which type?',
      options: [
        { id: 'bug', label: 'Bug' },
        { id: 'task', label: 'Task' },
      ],
    },
  ],
  answers: { type: { kind: 'choice', value: 'bug', probabilities: { bug: 0.93, task: 0.07 }, confidence: 0.93 } },
  confidence: 0.93,
  threshold: 0.85,
  acted: true,
  visible: true,
  savedRun: false,
  latencyMs: 1200,
  inputTokens: 10,
  costUsd: 0.004,
  outcome: null,
  agreed: null,
  resolvedAt: null,
  feedback: null,
  feedbackAt: null,
  at: '2026-09-30T10:00:00.000Z',
  ...over,
});

test('the mark reads "decided" with its confidence, and names the answer for a screen reader', async () => {
  await i18n.changeLanguage('en');
  const html = renderToStaticMarkup(<DecisionMarkOf decision={record()} />);
  assert.match(html, /decided · 0[.,]93/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Decided by Agentry, confidence 0[.,]93: Bug/);
  // Closed, the answer is not in the page
  assert.doesNotMatch(html, /Which type\?/);
});

test('with no confidence the mark says "suggested", in the language of the app', async () => {
  await i18n.changeLanguage('en');
  const unsure = record({ confidence: null, answers: { type: { kind: 'choice', value: 'task', probabilities: null, confidence: null } } });
  assert.match(renderToStaticMarkup(<DecisionMarkOf decision={unsure} />), /suggested/);
  await i18n.changeLanguage('es');
  assert.match(renderToStaticMarkup(<DecisionMarkOf decision={unsure} />), /sugerido/);
  assert.match(renderToStaticMarkup(<DecisionMarkOf decision={record()} />), /decidido · 0[.,]93/);
  await i18n.changeLanguage('en');
});
