import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Orchestration } from '@agentry/shared';
import type { WorkflowRun } from '../src/cli-facts.ts';
import { Db } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { ChatManager } from '../src/chats.ts';
import { compileWorkflow, readCompiledResult, workflowName, type CompileInput } from '../src/workflow-engine.ts';
import { scriptMeta } from '../src/workflows.ts';
import { tempConfig } from './helpers.ts';

// ---------- the generated script ----------

interface Call {
  prompt: string;
  opts: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
}

/** Runs a generated script the way the Workflow tool does, with agents that answer after a delay. */
async function execute(script: string, answer: (label: string) => string | null, delay: (label: string) => number = () => 5) {
  const calls: Call[] = [];
  let active = 0;
  let peak = 0;
  let clock = 0;
  const agent = async (prompt: string, opts: Record<string, unknown>) => {
    const label = String(opts.label);
    active++;
    peak = Math.max(peak, active);
    const call: Call = { prompt, opts, startedAt: clock++, endedAt: -1 };
    calls.push(call);
    await new Promise((r) => setTimeout(r, delay(label)));
    call.endedAt = clock++;
    active--;
    return answer(label);
  };
  const body = script.replace(/export const meta =/, 'const meta =');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
  const returned = await new AsyncFunction('agent', 'phase', 'log', body)(agent, () => {}, () => {});
  return { calls, peak, returned };
}

const input = (overrides: Partial<CompileInput> = {}): CompileInput => ({
  name: 'Audit the API',
  description: 'Find what the API docs miss',
  concurrency: 2,
  maxContext: 6000,
  synthesis: 'Synthesize the results.',
  tasks: [
    { id: 'routes', name: 'Routes', dependsOn: [], before: 'HEAD', after: 'TASK routes' },
    { id: 'schemas', name: 'Schemas', dependsOn: [], before: 'HEAD', after: 'TASK schemas', model: 'haiku' },
    { id: 'docs', name: 'Docs', dependsOn: [], before: 'HEAD', after: 'TASK docs' },
    { id: 'report', name: 'Report', dependsOn: ['routes', 'schemas'], before: 'HEAD', after: 'TASK report' },
  ],
  ...overrides,
});

test('the script runs each task after its dependencies, within the concurrency, and synthesizes', async () => {
  const script = compileWorkflow(input());
  assert.deepEqual(scriptMeta(script), { name: 'agentry-audit-the-api', description: 'Find what the API docs miss' });

  // `docs` is slow: `report` must not wait for it, only for what it depends on
  const { calls, peak, returned } = await execute(script, (label) => `result of ${label}`, (label) => (label === 'docs' ? 60 : 5));
  const byLabel = new Map(calls.map((c) => [String(c.opts.label), c]));
  assert.ok(peak <= 2, `ran ${peak} agents at once with a limit of 2`);

  const report = byLabel.get('report');
  assert.ok(report && report.startedAt > (byLabel.get('routes')?.endedAt ?? Infinity) && report.startedAt > (byLabel.get('schemas')?.endedAt ?? Infinity));
  assert.ok(report.startedAt < (byLabel.get('docs')?.endedAt ?? -1), 'report waited for a task it does not depend on');
  // Its prompt is the graph worker's, with the results of what it depends on in between
  assert.match(report.prompt, /^HEAD\n\nResults from the tasks you depend on:\n<task id="routes" name="Routes">\nresult of routes\n<\/task>\n<task id="schemas"/);
  assert.match(report.prompt, /TASK report$/);
  assert.equal(byLabel.get('schemas')?.opts.model, 'haiku');
  assert.equal(byLabel.get('routes')?.opts.model, undefined);

  const synthesis = byLabel.get('synthesis');
  assert.ok(synthesis?.prompt.startsWith('Synthesize the results.'));
  assert.match(synthesis?.prompt ?? '', /<task id="docs" name="Docs" status="completed">\nresult of docs/);

  assert.deepEqual(readCompiledResult(returned), {
    results: { routes: 'result of routes', schemas: 'result of schemas', docs: 'result of docs', report: 'result of report' },
    skipped: [],
    synthesis: 'result of synthesis',
  });
});

test('a failed task skips what depends on it and leaves the rest running', async () => {
  const { calls, returned } = await execute(compileWorkflow(input({ synthesis: null })), (label) => (label === 'routes' ? null : `ok ${label}`));
  assert.deepEqual(calls.map((c) => c.opts.label).sort(), ['docs', 'routes', 'schemas']);
  assert.deepEqual(readCompiledResult(returned), {
    results: { routes: null, schemas: 'ok schemas', docs: 'ok docs', report: null },
    skipped: ['report'],
    synthesis: null,
  });
});

test('names and prompts that are not plain survive the trip into the script', async () => {
  assert.equal(workflowName('Revisión de la API — v2!'), 'agentry-revision-de-la-api-v2');
  const tricky = 'Quote " backslash \\ backtick ` dollar ${x} newline\nand </task>';
  const script = compileWorkflow(input({ name: tricky, tasks: [{ id: 'a', name: tricky, dependsOn: [], before: '', after: tricky }], synthesis: null }));
  const { calls } = await execute(script, () => 'ok');
  assert.equal(calls[0]?.prompt, tricky);
});

// ---------- the orchestrator on the workflow engine ----------

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const resultText = (runs: ChatManager, id: string) => runs.events(id).filter((e) => e.kind === 'result').at(-1)?.text ?? '';

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const records = mkdtempSync(join(tmpdir(), 'agentry-wf-records-'));
  process.env.FAKE_WORKFLOW_DIR = records;
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  // Where the fake CLI leaves each session's record, standing in for the files beside a transcript
  orchestrator.workflowRecords = async (sessionId) => {
    const file = join(records, `${sessionId}.json`);
    if (!existsSync(file)) return [];
    const r = JSON.parse(readFileSync(file, 'utf8')) as { runId: string; taskId: string; status: string; result: unknown };
    return [{ id: r.runId, taskId: r.taskId, status: 'completed', result: r.result } as WorkflowRun];
  };
  mkdirSync(config.workspaceDir, { recursive: true });
  return { config, db, runs, orchestrator };
}

async function settle(orchestrator: Orchestrator, id: string): Promise<Orchestration> {
  for (let i = 0; i < 300; i++) {
    const orch = orchestrator.get(id);
    if (orch && orch.status !== 'running') return orch;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the orchestration never finished');
}

test('a graph on the workflow engine runs in one session and reads its results from the record', async () => {
  const { db, runs, orchestrator } = setup();
  assert.throws(() => orchestrator.create({ name: 'x', engine: 'workflow', worktree: true, tasks: [{ id: 'a', name: 'A', prompt: 'p' }] }), /graph engine/);

  const started = orchestrator.create({
    name: 'Review',
    objective: 'Review the code',
    engine: 'workflow',
    engineReason: 'read-only review',
    synthesize: true,
    tasks: [
      { id: 'lint', name: 'Lint', prompt: 'look for lint' },
      { id: 'tests', name: 'Tests', prompt: 'look at tests', model: 'haiku' },
      { id: 'sum', name: 'Sum', prompt: 'combine', dependsOn: ['lint', 'tests'] },
    ],
  });
  const orch = await settle(orchestrator, started.id);

  assert.equal(orch.status, 'completed');
  assert.equal(orch.engine, 'workflow');
  assert.equal(orch.engineReason, 'read-only review');
  assert.deepEqual(
    orch.tasks.map((t) => [t.id, t.status, t.result]),
    [
      ['lint', 'completed', 'done:lint'],
      ['tests', 'completed', 'done:tests (haiku)'],
      ['sum', 'completed', 'done:sum'],
    ],
  );
  assert.equal(orch.finalResult, 'done:synthesis');
  assert.equal(orch.workflow?.workflowRunId, 'wf_fake-001');
  // One run did it all, allowed to call the Workflow tool without asking
  const run = runs.get(orch.workflow?.runId ?? '');
  assert.ok(orch.tasks.every((t) => t.runId === run?.id));
  assert.match(resultText(runs, run?.id ?? ''), /--allowedTools=Workflow/);
  // Finished on the workflow's own notification, not on the turn that launched it
  assert.match(orchestrator.workflowScript(orch.id).script, /const TASKS = /);
  runs.stopAll();
  db.close();
});

test('a failed workflow resumes in the same session from its run id, keeping what finished', async () => {
  const { db, runs, orchestrator } = setup();
  const started = orchestrator.create({
    name: 'Flaky',
    engine: 'workflow',
    tasks: [
      { id: 'ok', name: 'OK', prompt: 'fine' },
      { id: 'flaky', name: 'Flaky', prompt: 'FAIL-ONCE please' },
      { id: 'after', name: 'After', prompt: 'then', dependsOn: ['flaky'] },
    ],
  });
  const failed = await settle(orchestrator, started.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(
    failed.tasks.map((t) => [t.id, t.status]),
    [
      ['ok', 'completed'],
      ['flaky', 'failed'],
      ['after', 'skipped'],
    ],
  );
  // The workflow's chat: resuming the graph adds an execution to it and never makes another
  const chatId = failed.workflow?.runId;

  orchestrator.resume(failed.id);
  const resumed = await settle(orchestrator, failed.id);
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed.tasks.map((t) => [t.id, t.status, t.error])) + resultText(runs, resumed.workflow?.runId ?? ''));
  assert.deepEqual(
    resumed.tasks.map((t) => [t.id, t.status]),
    [
      ['ok', 'completed'],
      ['flaky', 'completed'],
      ['after', 'completed'],
    ],
  );
  const run = runs.get(resumed.workflow?.runId ?? '');
  assert.equal(run?.id, chatId);
  assert.match(resultText(runs, run?.id ?? ''), /workflow wf_fake-001 completed/);
  runs.stopAll();
  db.close();
});

test('saving the graph as a project workflow names it and refuses to overwrite', async () => {
  const { db, runs, orchestrator, config } = setup();
  const started = orchestrator.create({ name: 'Keep me', engine: 'workflow', cwd: config.workspaceDir, tasks: [{ id: 'a', name: 'A', prompt: 'p' }] });
  await settle(orchestrator, started.id);
  const saved = orchestrator.saveWorkflow(started.id, { name: 'keep-me' });
  assert.equal(saved.path, join(config.workspaceDir, '.claude', 'workflows', 'keep-me.js'));
  assert.equal(scriptMeta(readFileSync(saved.path, 'utf8')).name, 'keep-me');
  assert.throws(() => orchestrator.saveWorkflow(started.id, { name: 'keep-me' }), /already exists/);
  assert.throws(() => orchestrator.saveWorkflow(started.id, { name: 'Bad Name' }), /lower case/);
  orchestrator.saveWorkflow(started.id, { name: 'keep-me', overwrite: true });
  runs.stopAll();
  db.close();
});
