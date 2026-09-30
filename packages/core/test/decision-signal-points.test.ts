import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatSummary, DecisionAnswer, DecisionPointId, DecisionProviderId, NotificationKind } from '@agentry/shared';
import { Changes } from '../src/changes.ts';
import { Db } from '../src/db.ts';
import { DecisionEngine, type DecisionProvider, type DecisionRequest, type ProviderResult } from '../src/decisions/engine.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS } from '../src/decisions/settings.ts';
import type { EditStepsState } from '../src/edit-steps.ts';
import { EventBus } from '../src/events.ts';
import { HealthService } from '../src/health-service.ts';
import type { ToolCall, Trace } from '../src/health.ts';
import { PushService, type PushTransport } from '../src/push.ts';
import { tempConfig } from './helpers.ts';

// The four tests every decision point owes (docs/plans/decision-engine.md, "Orchestrations and task
// graph"): off changes nothing and calls no provider; shadow records a row but today's behaviour
// decides; active acts only above the threshold (a suggestion needs none: its answer is enough);
// unavailable falls back at once.

class FakeProvider implements DecisionProvider {
  calls: DecisionRequest[] = [];
  up = true;
  answer: (request: DecisionRequest) => Promise<ProviderResult>;
  constructor(
    readonly id: DecisionProviderId,
    answer: (request: DecisionRequest) => ProviderResult,
  ) {
    this.answer = (request) => Promise.resolve(answer(request));
  }
  available(): boolean {
    return this.up;
  }
  ask(request: DecisionRequest): Promise<ProviderResult> {
    this.calls.push(request);
    return this.answer(request);
  }
}

/** Answers every noul with `yes`, and every choice with the named option or the first */
const answering =
  (yes: boolean, confidence: number | null, pick?: string) =>
  (request: DecisionRequest): ProviderResult => {
    const answers: Record<string, DecisionAnswer> = {};
    for (const q of request.questions) {
      if (q.kind === 'noul') answers[q.id] = { kind: 'noul', value: yes, probability: null, confidence };
      else if (q.kind === 'choice') answers[q.id] = { kind: 'choice', value: pick ?? q.options[0]?.id ?? '', probabilities: null, confidence };
      else answers[q.id] = { kind: 'score', value: q.levels[0]?.id ?? '', probabilities: null, confidence };
    }
    return { status: 'answered', answers, latencyMs: 5, inputTokens: 10, costUsd: 0, model: 'fake' };
  };

const down = (): ProviderResult => ({ status: 'unavailable', reason: 'no-quota', latencyMs: 1 });

async function engineFor(point: DecisionPointId, mode: 'off' | 'shadow' | 'active', provider: FakeProvider, threshold = 0.85) {
  const config = tempConfig();
  const db = new Db(config);
  const settings = new DecisionSettingsStore(config, new DecisionCredentialStore(config));
  const engine = new DecisionEngine({ settings, db, projectDecisions: () => null });
  engine.register(provider);
  await settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), provider: provider.id, points: { [point]: { mode, threshold, consent: null } } });
  await settings.setConsent(point, { granted: true, stateVersion: decisionPoint(point)?.stateVersion ?? 1, providers: [provider.id] });
  return { engine, db };
}

const rows = (db: Db, point: DecisionPointId) => db.listDecisions({ point }).items;

// ---------- health ----------

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
let n = 0;
const call = (name: string, input: Record<string, unknown>, over: Partial<ToolCall> = {}, i = n): ToolCall => ({
  id: `toolu_${String(++n)}`,
  name,
  input,
  at: new Date(T0 + i * 1000).toISOString(),
  endedAt: new Date(T0 + i * 1000 + 500).toISOString(),
  isError: false,
  result: 'ok',
  ...over,
});
const traceOf = (calls: ToolCall[]): Trace => ({ executionStartedAt: new Date(T0).toISOString(), lastEventAt: new Date(T0).toISOString(), calls, heartbeats: new Map() });

/** Nine reads of nine files: nothing repeats exactly, so only the semantic point can call it a loop */
const wandering = (): ToolCall[] => Array.from({ length: 9 }, (_, i) => call('Read', { file_path: `src/file-${String(i)}.ts` }, { result: `contents ${'a'.repeat(i + 1)}` }, i));

function healthOf(trace: Trace, engine: DecisionEngine): HealthService {
  const runtime = { get: () => ({ id: 'chat-1', workingDir: '/nonexistent' }), trace: () => trace };
  const health = new HealthService(runtime as never, { commandRuns: () => [], proposalsOf: () => [] } as never);
  health.decisions = engine;
  return health;
}
const base = { state: 'working', lastEnded: null, context: null, failedBranches: 0 } as const;
const looped = (health: HealthService) => health.read('chat-1', base).signals.some((s) => s.reasonCode === 'health.loop.semantic');

test('health.semantic-loop: off changes nothing and calls no provider', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('health.semantic-loop', 'off', provider);
  const health = healthOf(traceOf(wandering()), engine);
  assert.equal(looped(health), false);
  await health.idle();
  assert.equal(provider.calls.length, 0);
  assert.equal(rows(db, 'health.semantic-loop').length, 0);
});

test('health.semantic-loop: shadow records a row and the signals stay as today', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('health.semantic-loop', 'shadow', provider);
  const health = healthOf(traceOf(wandering()), engine);
  assert.equal(looped(health), false);
  await health.idle();
  assert.equal(provider.calls.length, 1);
  assert.equal(rows(db, 'health.semantic-loop')[0]?.mode, 'shadow');
  assert.equal(looped(health), false);
  // The state is the last calls' names, inputs and result heads, and nothing else
  assert.deepEqual(Object.keys(provider.calls[0]?.state ?? {}), ['calls']);
});

test('health.semantic-loop: active adds a warning, and only where the exact rule is silent', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('health.semantic-loop', 'active', provider);
  const health = healthOf(traceOf(wandering()), engine);
  assert.equal(looped(health), false, 'the first read never waits for the engine');
  await health.idle();
  const signal = health.read('chat-1', base).signals.find((s) => s.reasonCode === 'health.loop.semantic');
  assert.equal(signal?.level, 'warn');
  assert.equal(rows(db, 'health.semantic-loop')[0]?.acted, true);
  // Asked once, not on every poll
  health.read('chat-1', base);
  await health.idle();
  assert.equal(provider.calls.length, 1);
  // An exact loop is the rule's, and the point is not asked about it
  const exact = Array.from({ length: 9 }, () => call('Bash', { command: 'ls' }, { result: 'same' }));
  const other = new FakeProvider('jev', answering(true, 0.9));
  const second = await engineFor('health.semantic-loop', 'active', other);
  const h2 = healthOf(traceOf(exact), second.engine);
  h2.read('chat-1', base);
  await h2.idle();
  assert.equal(other.calls.length, 0);
});

test('health.semantic-loop: unavailable adds nothing and never waits', async () => {
  const provider = new FakeProvider('jev', down);
  const { engine, db } = await engineFor('health.semantic-loop', 'active', provider);
  const health = healthOf(traceOf(wandering()), engine);
  assert.equal(looped(health), false);
  await health.idle();
  assert.equal(looped(health), false);
  assert.equal(rows(db, 'health.semantic-loop')[0]?.status, 'unavailable');
});

const SPEC = 'test/orders.test.ts';
const before = "it('totals', () => {\n  expect(total([1, 2])).toBe(3);\n  expect(total([])).toBe(0);\n});";
// One check fewer: no rule of `weaknessOf` catches it, because assertions are still there
const after = "it('totals', () => {\n  expect(total([1, 2])).toBe(3);\n});";
const testEdit = (): ToolCall[] => [call('Edit', { file_path: SPEC, old_string: before, new_string: after })];
const weakened = (health: HealthService) => health.read('chat-1', base).signals.filter((s) => s.kind === 'weakened-test');

test('health.test-weakening: off changes nothing and calls no provider', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine } = await engineFor('health.test-weakening', 'off', provider);
  const health = healthOf(traceOf(testEdit()), engine);
  assert.deepEqual(weakened(health), []);
  await health.idle();
  assert.equal(provider.calls.length, 0);
});

test('health.test-weakening: shadow records a row and the rules alone decide', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('health.test-weakening', 'shadow', provider);
  const health = healthOf(traceOf(testEdit()), engine);
  weakened(health);
  await health.idle();
  assert.equal(provider.calls.length, 1);
  assert.equal(rows(db, 'health.test-weakening').length, 1);
  assert.deepEqual(weakened(health), []);
});

test('health.test-weakening: active only adds a suggestion, and never removes what the rules found', async () => {
  const yes = new FakeProvider('jev', answering(true, 0.9));
  const { engine } = await engineFor('health.test-weakening', 'active', yes);
  const health = healthOf(traceOf(testEdit()), engine);
  weakened(health);
  await health.idle();
  const [signal] = weakened(health);
  assert.equal(signal?.reasonCode, 'health.weakenedTest.judged');
  assert.equal(signal?.detail, SPEC);

  // An answer of "no" adds nothing; and an edit the rules already flag keeps its own signal, unasked
  const no = new FakeProvider('jev', answering(false, 0.99));
  const quiet = await engineFor('health.test-weakening', 'active', no);
  const h2 = healthOf(traceOf(testEdit()), quiet.engine);
  weakened(h2);
  await h2.idle();
  assert.deepEqual(weakened(h2), []);
  const flagged = call('Edit', { file_path: 'test/other.test.ts', old_string: before, new_string: "it('totals', () => {});" });
  const h3 = healthOf(traceOf([flagged]), quiet.engine);
  assert.equal(weakened(h3)[0]?.reasonCode, 'health.weakenedTest.assertionsRemoved');
  await h3.idle();
  assert.equal(no.calls.length, 1, 'only the edit the rules let pass was asked about');
  assert.equal(weakened(h3).length, 1);
});

test('health.test-weakening: unavailable adds nothing', async () => {
  const provider = new FakeProvider('jev', down);
  const { engine } = await engineFor('health.test-weakening', 'active', provider);
  const health = healthOf(traceOf(testEdit()), engine);
  weakened(health);
  await health.idle();
  assert.deepEqual(weakened(health), []);
});

// ---------- notification.urgency ----------

const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABsubscription-one';

/** A turn that finished: normal priority, so the point has something to raise */
const waiting = {
  type: 'run.updated',
  title: 'chat-1 is idle',
  runId: 'chat-1',
  runName: 'chat-1',
  sessionId: 'chat-1',
  orchestrationId: null,
  internal: false,
  previousStatus: 'busy',
  status: 'idle',
  turns: 1,
} as unknown as Parameters<EventBus['emit']>[0];

function pushOf(engine: DecisionEngine | null, level: 'all' | 'urgent') {
  const config = tempConfig();
  const db = new Db(config);
  const events = new EventBus();
  const sent: string[] = [];
  const transport: PushTransport = (_subscription, payload) => {
    sent.push((JSON.parse(payload) as { priority: string }).priority);
    return Promise.resolve(undefined);
  };
  const push = new PushService({ config, db, events, transport });
  if (engine) push.decisions = engine;
  db.savePushSubscription({
    id: 'sub',
    endpoint: ENDPOINT,
    p256dh: 'BExampleP256dhKeyForTests',
    auth: 'exampleAuthSecret',
    kinds: ['run', 'activity', 'attention', 'orchestration', 'conflict'] as NotificationKind[],
    level,
    label: 'phone',
    createdAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
  });
  return { push, events, sent };
}

async function pushed(engine: DecisionEngine | null, level: 'all' | 'urgent'): Promise<string[]> {
  const { push, events, sent } = pushOf(engine, level);
  events.emit(waiting);
  await push.idle();
  return sent;
}

test('notification.urgency: off sends what it sends today and calls no provider', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.99, 'high'));
  const { engine } = await engineFor('notification.urgency', 'off', provider);
  assert.deepEqual(await pushed(engine, 'all'), await pushed(null, 'all'));
  assert.equal(provider.calls.length, 0);
});

test('notification.urgency: shadow records a row and the priority stays as today', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.99, 'high'));
  const { engine, db } = await engineFor('notification.urgency', 'shadow', provider);
  const today = await pushed(null, 'urgent');
  assert.deepEqual(await pushed(engine, 'urgent'), today);
  assert.equal(provider.calls.length, 1);
  assert.ok(rows(db, 'notification.urgency').every((r) => r.mode === 'shadow' && !r.acted));
});

test('notification.urgency: active raises to high only above the threshold, and never lowers', async () => {
  const sure = new FakeProvider('jev', answering(true, 0.95, 'high'));
  const first = await engineFor('notification.urgency', 'active', sure);
  assert.deepEqual(await pushed(null, 'urgent'), [], 'today an urgent-only install is not interrupted by this news');
  assert.deepEqual(await pushed(first.engine, 'urgent'), ['high']);

  const unsure = new FakeProvider('jev', answering(true, 0.5, 'high'));
  const second = await engineFor('notification.urgency', 'active', unsure);
  assert.deepEqual(await pushed(second.engine, 'urgent'), [], 'below the threshold nothing changes');

  const normal = new FakeProvider('jev', answering(true, 0.99, 'normal'));
  const third = await engineFor('notification.urgency', 'active', normal);
  assert.deepEqual(await pushed(third.engine, 'all'), await pushed(null, 'all'));
});

test('notification.urgency: unavailable sends today\'s push at once', async () => {
  const provider = new FakeProvider('jev', down);
  const { engine, db } = await engineFor('notification.urgency', 'active', provider);
  assert.deepEqual(await pushed(engine, 'all'), await pushed(null, 'all'));
  assert.equal(rows(db, 'notification.urgency')[0]?.status, 'unavailable');
});

test('notification.urgency: on the CLI an active point only records, and the push does not wait for it', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = new FakeProvider('cli', answering(true, null, 'high'));
  slow.answer = async (request) => {
    await gate;
    return answering(true, null, 'high')(request);
  };
  const { engine } = await engineFor('notification.urgency', 'active', slow);
  const { push, events, sent } = pushOf(engine, 'all');
  const today = await pushed(null, 'all');
  events.emit(waiting);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sent, today, 'delivered while the decision is still pending');
  release();
  await push.idle();
});

// ---------- flow.scope-drift ----------

function branchRepo(): { repo: string; place: { worktree: null; branch: string } } {
  const repo = mkdtempSync(join(tmpdir(), 'agentry-drift-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  git('checkout', '-q', '-b', 'task/ag-1');
  writeFileSync(join(repo, 'button.ts'), 'export const button = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'add the button');
  writeFileSync(join(repo, 'billing.ts'), 'export const billing = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'rewrite billing');
  git('checkout', '-q', 'main');
  return { repo, place: { worktree: null, branch: 'task/ag-1' } };
}

const item = { id: 'item-1', projectId: 'project-1', title: 'Add a button', criteria: ['a button exists'] };
const changesOf = (engine: DecisionEngine) => new Changes({ decisions: engine } as never);

test('flow.scope-drift: off changes nothing and calls no provider', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('flow.scope-drift', 'off', provider);
  const { repo, place } = branchRepo();
  assert.deepEqual(await changesOf(engine).scopeDrift(repo, place, item), []);
  assert.equal(provider.calls.length, 0);
  assert.equal(rows(db, 'flow.scope-drift').length, 0);
});

test('flow.scope-drift: shadow records a row and flags nothing', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('flow.scope-drift', 'shadow', provider);
  const { repo, place } = branchRepo();
  assert.deepEqual(await changesOf(engine).scopeDrift(repo, place, item), []);
  assert.equal(rows(db, 'flow.scope-drift')[0]?.mode, 'shadow');
  // Paths and messages only, never a diff
  const state = provider.calls[0]?.state as { commits: Array<{ message: string; paths: string[] }> };
  assert.deepEqual(state.commits.map((c) => [c.message, c.paths]), [['rewrite billing', ['billing.ts']], ['add the button', ['button.ts']]]);
});

test('flow.scope-drift: active flags the commits it answered yes for, once per tip', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('flow.scope-drift', 'active', provider);
  const { repo, place } = branchRepo();
  const changes = changesOf(engine);
  assert.equal((await changes.scopeDrift(repo, place, item)).length, 2);
  assert.equal(rows(db, 'flow.scope-drift')[0]?.acted, true);
  assert.deepEqual(await changes.scopeDrift(repo, place, item), [], 'the same tip is not asked twice');
  assert.equal(provider.calls.length, 1);
});

test('flow.scope-drift: unavailable flags nothing', async () => {
  const provider = new FakeProvider('jev', down);
  const { engine, db } = await engineFor('flow.scope-drift', 'active', provider);
  const { repo, place } = branchRepo();
  assert.deepEqual(await changesOf(engine).scopeDrift(repo, place, item), []);
  assert.equal(rows(db, 'flow.scope-drift')[0]?.status, 'unavailable');
});

// ---------- changes.unexplained-hunk ----------

const chat = { id: 'chat-1', title: 'Fix greeting', firstPrompt: 'Fix the greeting', project: { id: 'project-1', name: 'P' }, cwd: '/tmp', worktree: null, execution: null, orchestration: null } as unknown as ChatSummary;

function stepsOf(engine: DecisionEngine): Changes {
  const state: EditStepsState = {
    entries: 3,
    intent: null,
    calls: new Map([['e1', { id: 'e1', tool: 'Edit', path: 'src/a.ts', at: null, intent: 'Renaming the greeting.', entryIndex: 2 }]]),
    results: new Map([['e1', { ok: true, diff: '@@ -1 +1 @@\n-hello\n+hi', additions: 1, deletions: 1, created: false }]]),
  };
  return new Changes({ decisions: engine, chats: { summaryOf: () => Promise.resolve(chat) }, sessions: { editSteps: () => Promise.resolve(state) }, runtime: {} } as never);
}

test('changes.unexplained-hunk: off changes nothing and calls no provider', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine } = await engineFor('changes.unexplained-hunk', 'off', provider);
  const changes = stepsOf(engine);
  assert.equal((await changes.chatSteps('chat-1')).length, 1);
  await changes.idle();
  assert.equal(provider.calls.length, 0);
});

test('changes.unexplained-hunk: shadow records a row and the steps are as today', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('changes.unexplained-hunk', 'shadow', provider);
  const changes = stepsOf(engine);
  const steps = await changes.chatSteps('chat-1');
  await changes.idle();
  assert.equal(steps[0]?.intent, 'Renaming the greeting.');
  const [row] = rows(db, 'changes.unexplained-hunk');
  assert.equal(row?.mode, 'shadow');
  assert.equal(row?.acted, false);
  assert.deepEqual(row?.state, { hunk: '@@ -1 +1 @@\n-hello\n+hi', step: 'Renaming the greeting.', title: 'Fix the greeting' });
});

test('changes.unexplained-hunk: active marks the row, once per step', async () => {
  const provider = new FakeProvider('jev', answering(true, 0.9));
  const { engine, db } = await engineFor('changes.unexplained-hunk', 'active', provider);
  const changes = stepsOf(engine);
  await changes.chatSteps('chat-1');
  await changes.chatSteps('chat-1');
  await changes.idle();
  assert.equal(provider.calls.length, 1);
  const [row] = rows(db, 'changes.unexplained-hunk');
  assert.equal(row?.acted, true);
  assert.equal(row?.subjectId, 'chat-1');
});

test('changes.unexplained-hunk: unavailable leaves the steps as they are, at once', async () => {
  const provider = new FakeProvider('jev', down);
  const { engine, db } = await engineFor('changes.unexplained-hunk', 'active', provider);
  const changes = stepsOf(engine);
  assert.equal((await changes.chatSteps('chat-1')).length, 1);
  await changes.idle();
  assert.equal(rows(db, 'changes.unexplained-hunk')[0]?.status, 'unavailable');
  assert.equal(rows(db, 'changes.unexplained-hunk')[0]?.acted, false);
});
