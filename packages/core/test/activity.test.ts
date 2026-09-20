import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Db } from '../src/db.ts';
import { ChatManager } from '../src/chats.ts';
import { listWorkflowDefinitions, readSessionWorkflows, scriptMeta } from '../src/workflows.ts';
import { tempConfig } from './helpers.ts';

// A real workflow run, recorded from CLI 2.1.278: two agents in parallel in one phase. The agent
// transcripts are cut down to what the reader needs.
const SESSION_FIXTURE = fileURLToPath(new URL('./fixtures/workflow-session', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

const task = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, ...fields });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});

/** What a turn that delegates in every way the CLI knows looks like on the stream. */
function delegatingTurn(): unknown[] {
  const workflow = readFileSync(join(SESSION_FIXTURE, 'stream.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
  return [
    // A long command in the foreground: the CLI reports it as a task, but nothing ran in the background
    task('task_started', { task_id: 'fg-bash', task_type: 'local_bash', is_backgrounded: false, description: 'pnpm install' }),
    task('task_notification', { task_id: 'fg-bash', status: 'completed' }),
    // One sent to the background half way through
    task('task_started', { task_id: 'moved-bash', task_type: 'local_bash', is_backgrounded: false, description: 'pnpm dev' }),
    task('task_updated', { task_id: 'moved-bash', patch: { is_backgrounded: true } }),
    task('task_started', { task_id: 'bg-bash', task_type: 'local_bash', is_backgrounded: true, description: 'tail -f log' }),
    // A subagent awaited by its parent
    toolUse('toolu_fg', 'Agent', { description: 'Look around', prompt: 'look', subagent_type: 'Explore' }),
    task('task_started', { task_id: 'agent-fg', tool_use_id: 'toolu_fg', task_type: 'local_agent', is_backgrounded: false, subagent_type: 'Explore' }),
    toolResult('toolu_fg', 'found it'),
    task('task_notification', { task_id: 'agent-fg', tool_use_id: 'toolu_fg', status: 'completed' }),
    // One launched to the background: its tool result only says it started
    toolUse('toolu_bg', 'Agent', { description: 'Keep watching', prompt: 'watch', run_in_background: true }),
    task('task_started', { task_id: 'agent-bg', tool_use_id: 'toolu_bg', task_type: 'local_agent', is_backgrounded: true, subagent_type: 'general-purpose' }),
    toolResult('toolu_bg', 'Async agent launched successfully'),
    ...workflow,
  ];
}

async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a run lists each kind of delegated work where it belongs', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const events = join(config.dataDir, 'turn.jsonl');
  writeFileSync(events, delegatingTurn().map((e) => JSON.stringify(e)).join('\n'));

  const run = runs.start({ prompt: `REPLAY ${events}` });
  const done = await until(() => runs.get(run.id)?.status === 'idle' && runs.get(run.id), 'the turn');

  // Only what actually runs in the background: not the foreground command, not the agents, not the workflow
  assert.deepEqual(done.backgroundTasks.map((t) => t.id).sort(), ['bg-bash', 'moved-bash']);

  const byId = new Map(done.subagents.map((s) => [s.agentId, s]));
  assert.equal(done.subagents.length, 2);
  assert.equal(byId.get('agent-fg')?.status, 'completed');
  assert.equal(byId.get('agent-fg')?.subagentType, 'Explore');
  assert.equal(byId.get('agent-fg')?.background, false);
  // Its launch result did not end it: it is still working
  assert.equal(byId.get('agent-bg')?.status, 'running');
  assert.equal(byId.get('agent-bg')?.background, true);

  assert.equal(done.workflows?.length, 1);
  const [workflow] = done.workflows ?? [];
  assert.equal(workflow?.name, 'two-words');
  assert.equal(workflow?.status, 'completed');
  assert.deepEqual(workflow?.phases, ['Say']);
  assert.deepEqual(
    workflow?.agents.map((a) => [a.label, a.state, a.resultPreview]),
    [
      ['one', 'done', 'red'],
      ['two', 'done', 'blue'],
    ],
  );
  assert.equal(workflow?.totalTokens, 20493);
  assert.match(workflow?.script ?? '', /name: 'two-words'/);
  runs.stopAll();
  db.close();
});

/** The fixture laid out as the CLI keeps it: `<session>.jsonl` with its directory beside it. */
function sessionOnDisk(): { transcript: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentry-wf-'));
  const transcript = join(root, 'session-1.jsonl');
  writeFileSync(transcript, '');
  const dir = join(root, 'session-1');
  cpSync(SESSION_FIXTURE, dir, { recursive: true });
  return { transcript, dir };
}

test('a finished workflow is read from its record', async () => {
  const { transcript } = sessionOnDisk();
  const [run, ...rest] = await readSessionWorkflows(transcript, 'session-1', false);
  assert.equal(rest.length, 0);
  assert.equal(run?.id, 'wf_5c79d6c0-b39');
  assert.equal(run?.status, 'completed');
  assert.equal(run?.name, 'two-words');
  assert.deepEqual(run?.phases, ['Say']);
  assert.deepEqual(run?.result, { results: ['red', 'blue'] });
  assert.equal(run?.agents.length, 2);
  assert.ok(run?.endedAt && run.startedAt < run.endedAt);
});

test('a workflow without a record is read from its journal: running while its session lives', async () => {
  const { transcript, dir } = sessionOnDisk();
  rmSync(join(dir, 'workflows', 'wf_5c79d6c0-b39.json'));
  // Only one agent has reported back so far
  const journal = join(dir, 'subagents', 'workflows', 'wf_5c79d6c0-b39', 'journal.jsonl');
  writeFileSync(journal, readFileSync(journal, 'utf8').split('\n').filter((l) => !l.includes('"blue"')).join('\n'));

  const [live] = await readSessionWorkflows(transcript, 'session-1', true);
  assert.equal(live?.status, 'running');
  assert.equal(live?.endedAt, null);
  // The script is written when the run starts, so the name is known before the record is
  assert.equal(live?.name, 'two-words');
  assert.deepEqual(
    live?.agents.map((a) => [a.label, a.state]),
    [
      ['one', 'done'],
      ['two', 'progress'],
    ],
  );
  const [ended] = await readSessionWorkflows(transcript, 'session-1', false);
  assert.equal(ended?.status, 'stopped');
});

test('saved workflows come from the project and the user, the project winning a clash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-saved-'));
  const project = join(root, 'project');
  const user = join(root, 'claude');
  mkdirSync(join(project, '.claude', 'workflows'), { recursive: true });
  mkdirSync(join(user, 'workflows'), { recursive: true });
  writeFileSync(join(project, '.claude', 'workflows', 'review.js'), "export const meta = {\n  name: 'review',\n  description: 'Review the diff',\n}\n");
  writeFileSync(join(user, 'workflows', 'review.js'), "export const meta = { name: 'review', description: 'Mine' }\n");
  writeFileSync(join(user, 'workflows', 'triage.mjs'), 'await agent("triage")\n');
  writeFileSync(join(user, 'workflows', 'notes.md'), '# not a workflow');

  const all = await listWorkflowDefinitions(user, project);
  assert.deepEqual(
    all.map((w) => [w.name, w.scope, w.description]),
    [
      ['review', 'project', 'Review the diff'],
      ['triage', 'user', null],
    ],
  );
  assert.deepEqual(
    (await listWorkflowDefinitions(user)).map((w) => w.scope),
    ['user', 'user'],
  );
  assert.deepEqual(scriptMeta(`export const meta = { name: "a \\"b\\"", description: \`multi\` }`), { name: 'a \\"b\\"', description: 'multi' });
});
