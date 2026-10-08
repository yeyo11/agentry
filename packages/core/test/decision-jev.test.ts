import assert from 'node:assert/strict';
import test from 'node:test';
import { APIConnectionError, APIError, APITimeoutError, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionQuestion } from '@agentry/shared';
import type { DecisionRequest } from '../src/decisions/engine.ts';
import { JevProvider, type JevClient } from '../src/decisions/providers/jev.ts';

const questions: DecisionQuestion[] = [
  { kind: 'choice', id: 'pick', question: 'Which?', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
  { kind: 'score', id: 'size', question: 'How big?', levels: [{ id: 'small', description: 'Tiny' }, { id: 'mid', description: 'Middle' }, { id: 'big', description: 'Huge' }] },
  { kind: 'noul', id: 'urgent', question: 'Is it urgent?' },
];
const request: DecisionRequest = { point: 'flow.refine-needed', state: { title: 'x' }, questions };
const live = { deadlineMs: 1_500, signal: new AbortController().signal };

const result = (answers: Record<string, unknown>): SystemOneResult<Questions> =>
  ({ model: 'jev-1.13.0', answers, usage: { input_tokens: 42, output_tokens: 3 } }) as unknown as SystemOneResult<Questions>;
const good = result({
  pick: { type: 'choice', choice: 'b', confidence: 0.93, probabilities: { a: 0.07, b: 0.93 } },
  size: { type: 'score', score: 1.4, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 } },
  urgent: { type: 'noul', noul: 0.1 },
});
const httpError = (status: number): APIError => APIError.fromResponse(status, {}, new Headers());

function provider(systemOne: JevClient['systemOne'], key: string | null = 'sk-test', backoffMs = 5): { jev: JevProvider; seen: SystemOneRequest<Questions>[] } {
  const seen: SystemOneRequest<Questions>[] = [];
  const jev = new JevProvider({
    getKey: () => key,
    backoffMs,
    createClient: () => ({
      systemOne: (r, o) => {
        seen.push(r);
        return systemOne(r, o);
      },
    }),
  });
  return { jev, seen };
}

test('jev maps the questions out and the answers back', async () => {
  const { jev, seen } = provider(async () => good);
  const out = await jev.ask(request, live);
  assert.equal(out.status, 'answered');
  if (out.status !== 'answered') return;
  assert.deepEqual(out.answers.pick, { kind: 'choice', value: 'b', probabilities: { a: 0.07, b: 0.93 }, confidence: 0.93 });
  // 1.4 rounds to the second level, and the probabilities are keyed by level id
  assert.deepEqual(out.answers.size, { kind: 'score', value: 'mid', probabilities: { small: 0.1, mid: 0.7, big: 0.2 }, confidence: 0.8 });
  assert.deepEqual(out.answers.urgent, { kind: 'noul', value: false, probability: 0.1, confidence: 0.9 });
  assert.equal(out.inputTokens, 42);
  assert.ok(Math.abs((out.costUsd ?? 0) - (42 * 0.042) / 1e6) < 1e-15);
  assert.equal(out.model, 'jev-1.13.0');
  const sent = seen[0];
  assert.equal(sent?.model, 'jev-1.13.0');
  assert.deepEqual(sent?.state, { title: 'x' });
  assert.deepEqual(Object.keys(sent?.questions ?? {}), ['pick', 'size', 'urgent']);
  assert.deepEqual(sent?.questions.pick, { type: 'choice', instructions: 'Which?', criteria: { a: 'Alpha', b: 'Beta' } });
});

test('jev without a key never calls out', async () => {
  let called = false;
  const { jev } = provider(async () => {
    called = true;
    return good;
  }, null);
  assert.equal(jev.available(), false);
  assert.equal(jev.whyUnavailable(), 'no-key');
  const out = await jev.ask(request, live);
  assert.deepEqual(out, { status: 'unavailable', reason: 'no-key', latencyMs: 0 });
  assert.equal(called, false);
});

test('jev retries once on a 429 and then answers', async () => {
  let calls = 0;
  const { jev } = provider(async () => {
    calls++;
    if (calls === 1) throw httpError(429);
    return good;
  });
  const out = await jev.ask(request, live);
  assert.equal(out.status, 'answered');
  assert.equal(calls, 2);
});

test('jev retries once on a 529 and gives up after the second', async () => {
  let calls = 0;
  const { jev } = provider(async () => {
    calls++;
    throw httpError(529);
  });
  const out = await jev.ask(request, live);
  assert.equal(out.status === 'unavailable' && out.reason, 'rate-limited');
  assert.equal(calls, 2);
});

test('jev does not retry when the deadline has no room for it', async () => {
  let calls = 0;
  // The wait before a retry is longer than the whole deadline, so there is no room for one; the
  // deadline itself is roomy, so a slow runner still makes the first call before it runs out
  const { jev } = provider(
    async () => {
      calls++;
      throw httpError(429);
    },
    'sk-test',
    1000,
  );
  const out = await jev.ask(request, { deadlineMs: 200, signal: live.signal });
  assert.equal(out.status === 'unavailable' && out.reason, 'rate-limited');
  assert.equal(calls, 1);
});

test('jev maps failures to a reason and never retries them', async () => {
  const cases: Array<[unknown, string]> = [
    [httpError(500), 'server-error'],
    [httpError(401), 'no-key'],
    [httpError(402), 'no-quota'],
    [httpError(422), 'invalid-answer'],
    [new APITimeoutError(1500), 'timeout'],
    [new APIConnectionError('down'), 'network'],
    [new Error('boom'), 'server-error'],
  ];
  for (const [error, reason] of cases) {
    let calls = 0;
    const { jev } = provider(async () => {
      calls++;
      throw error;
    });
    const out = await jev.ask(request, live);
    assert.equal(out.status === 'unavailable' && out.reason, reason);
    assert.equal(calls, 1);
  }
});

test('jev answers that do not fit the questions are invalid', async () => {
  const bad = [
    result({ ...good.answers, pick: { type: 'choice', choice: 'zzz', confidence: 0.9, probabilities: {} } }),
    result({ pick: good.answers.pick }),
    result({ ...good.answers, urgent: { type: 'score', score: 1, confidence: 1 } }),
  ];
  for (const r of bad) {
    const { jev } = provider(async () => r);
    const out = await jev.ask(request, live);
    assert.equal(out.status === 'unavailable' && out.reason, 'invalid-answer');
  }
});

test('jev stops at the deadline and on abort', async () => {
  const { jev } = provider(
    (_r, o) =>
      new Promise((_resolve, reject) => {
        o.signal.addEventListener('abort', () => reject(new APITimeoutError(o.timeout)));
      }),
  );
  const controller = new AbortController();
  const pending = jev.ask(request, { deadlineMs: 1_500, signal: controller.signal });
  controller.abort();
  const out = await pending;
  assert.equal(out.status === 'unavailable' && out.reason, 'timeout');
  const spent = await jev.ask(request, { deadlineMs: 1_500, signal: controller.signal });
  assert.equal(spent.status === 'unavailable' && spent.reason, 'timeout');
});

test('jev reads the key on every call', async () => {
  let key: string | null = null;
  const made: string[] = [];
  const jev = new JevProvider({ getKey: () => key, createClient: (k) => (made.push(k), { systemOne: async () => good }) });
  assert.equal(jev.available(), false);
  key = 'one';
  await jev.ask(request, live);
  await jev.ask(request, live);
  key = 'two';
  await jev.ask(request, live);
  assert.deepEqual(made, ['one', 'two']);
});

test('jev stores no tokens and no cost when the answer reports no usage', async () => {
  const { jev } = provider(async () => ({ ...good, usage: undefined } as unknown as typeof good));
  const out = await jev.ask(request, live);
  assert.equal(out.status, 'answered');
  if (out.status !== 'answered') return;
  assert.equal(out.inputTokens, null);
  assert.equal(out.costUsd, null);
});
