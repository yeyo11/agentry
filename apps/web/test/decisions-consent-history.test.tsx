// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionPointStats, DecisionRecord } from '@agentry/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { answerLines, approxTokens, consentProviders, needsConsent, outcomeOf, percent } from '../src/pages/config/decisions/model';
import { PointMetrics } from '../src/pages/config/decisions/PointMetrics';

// Settings → Decisions (D3 u2): when a point asks for consent, what its week shows and how a
// History row reads.

const stats = (over: Partial<DecisionPointStats> = {}): DecisionPointStats => ({
  point: 'flow.refine-needed',
  count: 41,
  acted: 26,
  unavailable: 2,
  meanConfidence: 0.91,
  resolved: 24,
  agreed: 21,
  useful: 5,
  notUseful: 1,
  costUsd: 0.004,
  runsSaved: 12,
  ...over,
});

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: 'd1',
  point: 'flow.bounce',
  kind: 'act',
  projectId: null,
  subjectKind: 'work_item',
  subjectId: null,
  provider: 'jev',
  model: 'jev-1.13.0',
  mode: 'shadow',
  status: 'answered',
  unavailable: null,
  state: {},
  questions: [
    {
      kind: 'choice',
      id: 'route',
      question: 'Back to the developer?',
      options: [
        { id: 'back', label: 'Send back' },
        { id: 'accept', label: 'Accept' },
      ],
    },
  ],
  answers: { route: { kind: 'choice', value: 'back', probabilities: { accept: 0.07, back: 0.93 }, confidence: 0.93 } },
  confidence: 0.93,
  threshold: 0.85,
  acted: false,
  visible: false,
  savedRun: false,
  latencyMs: 210,
  inputTokens: null,
  costUsd: null,
  outcome: null,
  agreed: null,
  resolvedAt: null,
  feedback: null,
  feedbackAt: null,
  at: '2026-09-30T09:00:00.000Z',
  ...over,
});

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('a point asks for consent until the state it sends now was agreed for its provider', () => {
  const info = { stateVersion: 2 };
  const consent = { at: '2026-09-30T09:00:00.000Z', stateVersion: 2, providers: ['cli' as const] };
  assert.equal(needsConsent(info, null, 'cli'), true);
  assert.equal(needsConsent(info, consent, 'cli'), false);
  // Consent given on the CLI does not cover Jev
  assert.equal(needsConsent(info, consent, 'jev'), true);
  // A state that changed shape asks again
  assert.equal(needsConsent({ stateVersion: 3 }, consent, 'cli'), true);
});

test('a new consent adds to what was agreed for the same state and drops what was for another', () => {
  const consent = { at: '2026-09-30T09:00:00.000Z', stateVersion: 2, providers: ['cli' as const] };
  assert.deepEqual(consentProviders({ stateVersion: 2 }, consent, 'jev'), ['cli', 'jev']);
  assert.deepEqual(consentProviders({ stateVersion: 2 }, consent, 'cli'), ['cli']);
  assert.deepEqual(consentProviders({ stateVersion: 3 }, consent, 'jev'), ['jev']);
  assert.deepEqual(consentProviders({ stateVersion: 3 }, null, 'cli'), ['cli']);
});

test('sizes and shares round the way the dialog and the metrics say them', () => {
  assert.equal(approxTokens(1843), 461);
  assert.equal(percent(26, 41), 63);
  assert.equal(percent(0, 0), null);
});

test('a History row says what happened to its answer', () => {
  assert.equal(outcomeOf({ status: 'unavailable', agreed: null }), 'asUsual');
  assert.equal(outcomeOf({ status: 'answered', agreed: true }), 'match');
  assert.equal(outcomeOf({ status: 'answered', agreed: false }), 'differs');
  assert.equal(outcomeOf({ status: 'answered', agreed: null }), 'pending');
});

test('an answer reads with the labels of its question, most likely first', () => {
  const [line] = answerLines(record());
  assert.equal(line?.value, 'Send back');
  assert.deepEqual(
    line?.bars.map((bar) => [bar.label, bar.probability]),
    [
      ['Send back', 0.93],
      ['Accept', 0.07],
    ],
  );
  assert.deepEqual(answerLines(record({ status: 'unavailable', answers: null })), []);
});

test('a yes/no answer gets its two bars from the one probability', () => {
  const [line] = answerLines(
    record({
      questions: [{ kind: 'noul', id: 'stuck', question: 'Is it stuck?' }],
      answers: { stuck: { kind: 'noul', value: true, probability: 0.75, confidence: 0.75 } },
    }),
  );
  assert.equal(line?.value, true);
  assert.deepEqual(line?.bars.map((bar) => [bar.id, bar.probability]), [['yes', 0.75], ['no', 0.25]]);
});

test('the metrics show the CLI has no confidence and give the agreement its n', () => {
  const cli = renderToStaticMarkup(<PointMetrics stats={stats({ meanConfidence: null })} />);
  assert.match(cli, /Confidence<\/span><span>—<\/span>/);
  assert.match(cli, /63 %/);
  assert.match(cli, /88 %/);
  assert.match(cli, /n 24/);
  assert.match(cli, /Runs saved/);
});

test('a point with no week yet shows dashes, not made-up zeros for the ratios', () => {
  const empty = renderToStaticMarkup(<PointMetrics stats={undefined} />);
  assert.match(empty, /Acted<\/span><span>—<\/span>/);
  assert.match(empty, /Agreement<\/span><span>—<\/span>/);
  assert.doesNotMatch(empty, /n 0/);
});

test('the way into the History only shows when there is somewhere to go', () => {
  assert.doesNotMatch(renderToStaticMarkup(<PointMetrics stats={stats()} />), /See in History/);
  assert.match(renderToStaticMarkup(<PointMetrics stats={stats()} onHistory={() => undefined} />), /See in History/);
});
