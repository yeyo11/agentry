import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { DecisionAnswer, DecisionPointId, HealthSignal, Orchestration, OrchestrationSpec, TranscriptEntry, VerificationSpec } from '@agentry/shared';
import { ChatManager, type ChatRuntime } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { DecisionEngine, type DecisionProvider, type DecisionRequest, type ProviderResult } from '../src/decisions/engine.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS } from '../src/decisions/settings.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DEFAULT_SUPERVISOR, Supervisor, SupervisorSettings } from '../src/supervisor.ts';
import { tempConfig } from './helpers.ts';

// The runtime decision points (docs/plans/decision-engine.md, D2 w3): orchestration.retry,
// orchestration.model, orchestration.fixer, supervisor.intervene and the orchestrator side of
// run.continuation. Each has the four tests the plan asks for: off changes nothing and calls no
// provider; shadow records a row while today's behaviour decides; active acts only above the
// threshold; and an unavailable provider (no quota included) is today's behaviour at once.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

type Reply = (request: DecisionRequest) => ProviderResult;

/** Answers every question with `pick(questionId, index)`, at one confidence */
const replying =
  (pick: (id: string, index: number) => string | boolean, confidence: number | null = 0.99): Reply =>
  (request) => {
    const answers: Record<string, DecisionAnswer> = {};
    request.questions.forEach((q, i) => {
      const value = pick(q.id, i);
      answers[q.id] = q.kind === 'noul' ? { kind: 'noul', value: value === true, probability: null, confidence } : { kind: q.kind, value: String(value), probabilities: null, confidence };
    });
    return { status: 'answered', answers, latencyMs: 5, inputTokens: 10, costUsd: 0, model: 'jev-test' };
  };
const noQuota: Reply = () => ({ status: 'unavailable', reason: 'no-quota', latencyMs: 1 });

/** A real engine over a real store, with one point set and a provider that only records and answers */
async function deciding(point: DecisionPointId, mode: 'off' | 'shadow' | 'active', reply: Reply, db: Db = new Db(tempConfig())) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const settings = new DecisionSettingsStore(config, new DecisionCredentialStore(config));
  const engine = new DecisionEngine({ settings, db, projectDecisions: () => null });
  const calls: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    id: 'jev',
    available: () => true,
    ask: (request) => {
      calls.push(request);
      return Promise.resolve(reply(request));
    },
  };
  engine.register(provider);
  if (mode !== 'off') {
    await settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), provider: 'jev', points: { [point]: { mode, threshold: 0.85, consent: null } } });
    await settings.setConsent(point, { granted: true, stateVersion: decisionPoint(point)?.stateVersion ?? 1, providers: ['jev'] });
  }
  return { db, engine, calls, rows: () => db.listDecisions().items };
}

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agentry-decisions-repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return repo;
}

async function finished(orchestrator: Orchestrator, id: string): Promise<Orchestration> {
  for (let i = 0; i < 400; i++) {
    const orch = orchestrator.get(id);
    if (orch && orch.status !== 'running') {
      await orchestrator.decided();
      return orch;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the orchestration never finished');
}

/** An orchestrator over the fake CLI, wired to a decision engine the way Core wires it */
async function graph(point: DecisionPointId, mode: 'off' | 'shadow' | 'active', reply: Reply) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const d = await deciding(point, mode, reply, db);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  orchestrator.decisions = d.engine;
  const repo = repoWithCommit();
  const run = async (spec: Omit<Partial<OrchestrationSpec>, 'tasks'> & { tasks: Array<{ id: string; prompt: string }> }) => {
    const started = orchestrator.create({ name: 'decided', cwd: repo, worktree: true, synthesize: false, ...spec, tasks: spec.tasks.map((t) => ({ name: t.id, ...t })) });
    return finished(orchestrator, started.id);
  };
  return { ...d, orchestrator, repo, run };
}

// ---------- orchestration.retry ----------

const FLAKY = [{ id: 'flaky', prompt: 'FAKE-FAIL-ONCE the disk was full' }];
const permanent = replying(() => 'permanent');

test('orchestration.retry: off retries as before and asks nothing', async () => {
  const g = await graph('orchestration.retry', 'off', permanent);
  const orch = await g.run({ tasks: FLAKY });
  assert.equal(orch.tasks[0]?.status, 'completed');
  assert.equal(orch.tasks[0]?.attempts, 2);
  assert.equal(g.calls.length, 0);
  assert.equal(g.rows().length, 0);
});

test('orchestration.retry: shadow records the answer and the retry still happens', async () => {
  const g = await graph('orchestration.retry', 'shadow', permanent);
  const orch = await g.run({ tasks: FLAKY });
  assert.equal(orch.tasks[0]?.status, 'completed');
  assert.equal(orch.tasks[0]?.attempts, 2);
  const [row] = g.rows();
  assert.equal(g.rows().length, 1);
  assert.equal(row?.mode, 'shadow');
  assert.equal(row?.acted, false);
  assert.equal(row?.subjectKind, 'task');
  // The state is the error as words, the task name and the attempt as words: no number to count
  const state = g.calls[0]?.state as { error: string; task: string; attempt: string };
  assert.match(state.error, /the disk was full/);
  assert.equal(state.task, 'flaky');
  assert.equal(state.attempt, 'first attempt');
});

test('orchestration.retry: active stops a permanent error above the threshold, and only then', async () => {
  const sure = await graph('orchestration.retry', 'active', permanent);
  const stopped = await sure.run({ tasks: FLAKY });
  assert.equal(stopped.tasks[0]?.status, 'failed');
  assert.equal(stopped.tasks[0]?.attempts, 1, 'no second attempt');
  assert.match(stopped.tasks[0]?.error ?? '', /the disk was full/);
  assert.equal(sure.rows()[0]?.acted, true);

  const unsure = await graph('orchestration.retry', 'active', replying(() => 'permanent', 0.5));
  assert.equal((await unsure.run({ tasks: FLAKY })).tasks[0]?.attempts, 2, 'below the threshold, today');
  const transient = await graph('orchestration.retry', 'active', replying(() => 'transient'));
  assert.equal((await transient.run({ tasks: FLAKY })).tasks[0]?.status, 'completed');
});

test('orchestration.retry: an unavailable provider retries at once, and a continuation is never asked about', async () => {
  const g = await graph('orchestration.retry', 'active', noQuota);
  const orch = await g.run({ tasks: FLAKY });
  assert.equal(orch.tasks[0]?.status, 'completed');
  assert.equal(orch.tasks[0]?.attempts, 2);
  assert.equal(g.rows()[0]?.status, 'unavailable');
  assert.equal(g.rows()[0]?.unavailable, 'no-quota');

  // A turn that ends as a report is continued, which is not an attempt and not a question
  const c = await graph('orchestration.retry', 'active', permanent);
  const continued = await c.run({ tasks: [{ id: 'early', prompt: 'FAKE-TEXT-ONCE The schema is in place. Next, I will wire the route.' }] });
  assert.equal(continued.tasks[0]?.continuations, 1);
  assert.equal(c.calls.length, 0);
});

// ---------- run.continuation (the orchestrator side) ----------

const REPORT = [{ id: 'early', prompt: 'FAKE-TEXT-ONCE The schema is in place. Next, I will wire the route.' }];

test('run.continuation: off continues on the phrase list as before and asks nothing', async () => {
  const g = await graph('run.continuation', 'off', replying(() => 'done'));
  const orch = await g.run({ tasks: REPORT });
  assert.equal(orch.tasks[0]?.continuations, 1);
  assert.equal(g.calls.length, 0);
  assert.equal(g.rows().length, 0);
});

test('run.continuation: shadow records the answer and the phrase list still decides', async () => {
  const g = await graph('run.continuation', 'shadow', replying(() => 'done'));
  const orch = await g.run({ tasks: REPORT });
  assert.equal(orch.tasks[0]?.continuations, 1);
  // The continued turn ends with a report of its own, which is asked about too: none of it acted
  assert.ok(g.rows().length >= 1);
  assert.ok(g.rows().every((r) => !r.acted));
  // The last paragraph only, and the count as words
  const state = g.calls[0]?.state as { title: string; tail: string; continuations: string };
  assert.equal(state.tail, 'The schema is in place. Next, I will wire the route.');
  assert.equal(state.continuations, 'no continuation yet');
});

test('run.continuation: active drops the phrase items on done, adds one on owes-work, and only above the threshold', async () => {
  const done = await graph('run.continuation', 'active', replying(() => 'done'));
  const ended = await done.run({ tasks: REPORT });
  assert.equal(ended.tasks[0]?.continuations, undefined, 'a report the decision calls done is the end');
  assert.equal(ended.tasks[0]?.status, 'completed');
  assert.equal(ended.tasks[0]?.result, 'The schema is in place. Next, I will wire the route.');

  // No phrase matches this report, so the decision's own item is what the run is told
  const owes = await graph('run.continuation', 'active', replying(() => 'owes-work'));
  const goes = await owes.run({ tasks: [{ id: 'quiet', prompt: 'FAKE-TEXT-ONCE The schema is in place.' }] });
  // Every report of the graph is judged owing work, so it stops at the cap of three
  assert.equal(goes.tasks[0]?.continuations, 3);
  assert.match(goes.tasks[0]?.result ?? '', /Your last message says work is still owed without doing it/);

  const unsure = await graph('run.continuation', 'active', replying(() => 'done', 0.5));
  assert.equal((await unsure.run({ tasks: REPORT })).tasks[0]?.continuations, 1, 'below the threshold, today');
});

test('run.continuation: an unavailable provider continues at once, and a result with no last paragraph is not asked', async () => {
  const g = await graph('run.continuation', 'active', noQuota);
  const orch = await g.run({ tasks: REPORT });
  assert.equal(orch.tasks[0]?.continuations, 1);
  assert.equal(g.rows()[0]?.unavailable, 'no-quota');

  const empty = await graph('run.continuation', 'active', replying(() => 'done'));
  await empty.run({ tasks: [{ id: 'plain', prompt: 'FAKE-WRITE plain.txt yes' }] });
  assert.equal(empty.calls.filter((c) => c.point === 'run.continuation').length, 1, 'the fake worker answers with text, so it is asked once');
});

// ---------- orchestration.fixer ----------

const LINT = "echo 'FAKE-WRITE lint.txt ok'; echo '✗ lint.spec.mjs'; test -f lint.txt";
const UNIT = "echo 'FAKE-WRITE unit.txt ok'; echo '✗ unit.spec.mjs'; test -f unit.txt";
const CHECKS: VerificationSpec = { commands: ['true', [LINT, UNIT]], fixer: true, maxAttempts: 2 };
const worthIt = replying(() => true);
const notWorthIt = replying(() => false);

test('orchestration.fixer: off runs the fixer as before and asks nothing', async () => {
  const g = await graph('orchestration.fixer', 'off', notWorthIt);
  const orch = await g.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] });
  assert.equal(orch.verification?.status, 'fixed');
  assert.equal(g.calls.length, 0);
  assert.equal(g.rows().length, 0);
});

test('orchestration.fixer: shadow asks once for a group of two failing checks and the fixer still runs', async () => {
  const g = await graph('orchestration.fixer', 'shadow', notWorthIt);
  const orch = await g.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] });
  assert.equal(orch.verification?.status, 'fixed');
  assert.equal(orch.verification?.attempts, 1);
  // One question for the step, carrying both failed checks and the specs they name
  assert.equal(g.calls.length, 1);
  const state = g.calls[0]?.state as { checks: Array<{ command: string; output: string }>; failedSpecs: string[]; notes: string[]; attempt: string };
  assert.equal(state.checks.length, 2);
  assert.deepEqual(state.checks.map((c) => c.command), [LINT, UNIT]);
  assert.deepEqual([...state.failedSpecs].sort(), ['lint.spec.mjs', 'unit.spec.mjs']);
  assert.equal(state.attempt, 'first attempt');
  assert.equal(g.rows()[0]?.acted, false);
});

test('orchestration.fixer: active stops the fixing above the threshold and leaves the checks failed', async () => {
  const g = await graph('orchestration.fixer', 'active', notWorthIt);
  const orch = await g.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] });
  assert.equal(orch.verification?.status, 'failed');
  assert.equal(orch.verification?.attempts, 0, 'no fixer run was started');
  assert.match(orch.verification?.report ?? '', /decision engine judged another fixer attempt unlikely to help/);
  assert.deepEqual(orch.verification?.commands.map((c) => c.status), ['passed', 'failed', 'failed']);
  assert.equal(g.rows()[0]?.acted, true);

  const unsure = await graph('orchestration.fixer', 'active', replying(() => false, 0.5));
  assert.equal((await unsure.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] })).verification?.status, 'fixed');
  const hopeful = await graph('orchestration.fixer', 'active', worthIt);
  assert.equal((await hopeful.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] })).verification?.status, 'fixed');
});

test('orchestration.fixer: an unavailable provider runs the fixer at once', async () => {
  const g = await graph('orchestration.fixer', 'active', noQuota);
  const orch = await g.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] });
  assert.equal(orch.verification?.status, 'fixed');
  assert.equal(g.rows()[0]?.unavailable, 'no-quota');
});

// ---------- orchestration.model ----------

const PLAN = JSON.stringify({
  name: 'plan',
  engine: 'graph',
  engineReason: 'changes files',
  tasks: [
    { id: 'a', name: 'A', prompt: 'rename the field\nin every file' },
    { id: 'b', name: 'B', prompt: 'design the migration', dependsOn: ['a'] },
  ],
});

async function planned(mode: 'off' | 'shadow' | 'active', reply: Reply) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const d = await deciding('orchestration.model', mode, reply, db);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  orchestrator.decisions = d.engine;
  const run = orchestrator.startPlan({ objective: `Ship it\nFAKE-RESULT-WORK ${PLAN}`, cwd: repoWithCommit(), model: 'opus' });
  const draft = await orchestrator.draft(run.id);
  await orchestrator.decided();
  return { ...d, draft };
}

const cheap = replying((id) => (id === 'a' ? 'haiku' : 'opus'));

test('orchestration.model: off leaves every task on the plan model and asks nothing', async () => {
  const p = await planned('off', cheap);
  assert.deepEqual(p.draft.tasks.map((t) => t.model), [undefined, undefined]);
  assert.equal(p.calls.length, 0);
  assert.equal(p.rows().length, 0);
});

test('orchestration.model: shadow records the suggestion and the draft is untouched', async () => {
  const p = await planned('shadow', cheap);
  assert.deepEqual(p.draft.tasks.map((t) => t.model), [undefined, undefined]);
  assert.equal(p.rows().length, 1);
  assert.equal(p.rows()[0]?.acted, false);
  const state = p.calls[0]?.state as { tasks: Array<{ id: string; prompt: string; dependsOn: string[] }>; models: Array<{ id: string }> };
  assert.deepEqual(state.tasks.map((t) => t.id), ['a', 'b']);
  assert.deepEqual(state.tasks[1]?.dependsOn, ['a']);
  assert.deepEqual(state.models.map((m) => m.id), ['haiku', 'sonnet', 'opus']);
});

test('orchestration.model: active prefills the models that differ from the plan model, and the person still edits them', async () => {
  const p = await planned('active', cheap);
  // b is already on the plan's model, so nothing is prefilled for it
  assert.deepEqual(p.draft.tasks.map((t) => t.model), ['haiku', undefined]);
  assert.equal(p.draft.model, 'opus');
  assert.equal(p.rows()[0]?.acted, true);
  assert.equal(p.rows()[0]?.visible, true);
});

test('orchestration.model: an unavailable provider leaves the draft as today, at once', async () => {
  const p = await planned('active', noQuota);
  assert.deepEqual(p.draft.tasks.map((t) => t.model), [undefined, undefined]);
  assert.equal(p.rows()[0]?.unavailable, 'no-quota');
});

// ---------- supervisor.intervene ----------

const hung: HealthSignal = { kind: 'hung-command', level: 'bad', reason: '`pnpm e2e` has been running for 12 min.', detail: 'pnpm e2e' };
const chat = { id: 'c1', name: 'chat c1', cwd: '/work', workingDir: '/work', origin: 'agentry', orchestrationId: null } as ChatRuntime;
const transcript: TranscriptEntry[] = [
  {
    uuid: 'u1',
    role: 'assistant',
    timestamp: null,
    model: null,
    isSidechain: false,
    parentToolUseId: null,
    blocks: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } },
      { type: 'tool_result', toolUseId: 't1', content: 'exit 1: no such file', isError: true },
    ],
  },
];

async function supervising(mode: 'off' | 'shadow' | 'active', reply: Reply) {
  const config = tempConfig();
  const db = new Db(config);
  const d = await deciding('supervisor.intervene', mode, reply, db);
  const settings = new SupervisorSettings(config);
  await settings.set({ ...DEFAULT_SUPERVISOR, enabled: true });
  const asked: string[] = [];
  const supervisor = new Supervisor({
    settings,
    db,
    ask: (q) => {
      asked.push(q.prompt);
      return Promise.resolve({ text: 'Check the open socket.', costUsd: 0.002, isError: false });
    },
    steps: () => Promise.resolve(transcript),
    hint: () => Promise.resolve(),
    emit: () => undefined,
    charge: () => undefined,
    decisions: d.engine,
  });
  return { ...d, supervisor, asked };
}

const waitFor = async (read: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !read(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('supervisor.intervene: off asks the supervisor for a hint as before and asks nothing else', async () => {
  const s = await supervising('off', replying(() => false));
  assert.equal((await s.supervisor.wake(chat, null, [hung]))?.status, 'proposed');
  assert.equal(s.asked.length, 1);
  assert.equal(s.calls.length, 0);
  assert.equal(s.rows().length, 0);
});

test('supervisor.intervene: shadow records the answer and the hint is still asked for', async () => {
  const s = await supervising('shadow', replying(() => false));
  assert.equal((await s.supervisor.wake(chat, null, [hung]))?.status, 'proposed');
  await waitFor(() => s.rows().length === 1);
  assert.equal(s.asked.length, 1);
  assert.equal(s.rows()[0]?.acted, false);
  assert.equal(s.rows()[0]?.subjectKind, 'chat');
  // The signal, its detail and the tool calls' names and errors: no input, no file content
  assert.deepEqual(s.calls[0]?.state, { signal: 'hung-command', detail: 'pnpm e2e', calls: [{ tool: 'Bash', error: 'exit 1: no such file' }] });
});

test('supervisor.intervene: active spares the hint above the threshold on a no, and only then', async () => {
  const no = await supervising('active', replying(() => false));
  assert.equal(await no.supervisor.wake(chat, null, [hung]), null);
  assert.equal(no.asked.length, 0, 'no housekeeping chat was started');
  assert.equal(no.rows()[0]?.acted, true);
  assert.equal(no.rows()[0]?.savedRun, true);
  // The signal is not asked about again on the next tick
  assert.equal(await no.supervisor.wake(chat, null, [hung]), null);
  assert.equal(no.calls.length, 1);

  const unsure = await supervising('active', replying(() => false, 0.5));
  assert.equal((await unsure.supervisor.wake(chat, null, [hung]))?.status, 'proposed');
  const yes = await supervising('active', replying(() => true));
  assert.equal((await yes.supervisor.wake(chat, null, [hung]))?.status, 'proposed');
});

test('supervisor.intervene: an unavailable provider asks for the hint at once', async () => {
  const s = await supervising('active', noQuota);
  assert.equal((await s.supervisor.wake(chat, null, [hung]))?.status, 'proposed');
  assert.equal(s.rows()[0]?.unavailable, 'no-quota');
});
