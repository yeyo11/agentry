import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentryEvent, AssistantRunDetail } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// The assistant through the real core and the fake CLI (test/fixtures/fake-claude.mjs): the chat is
// a real process given the real flags, and every accept goes through the real team, resources and
// board. The fake answers with the structured result a run's description scripts.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-assistant-cli-'));
  writeFileSync(join(dir, 'README.md'), '# Pagos\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {};\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return dir;
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(`${full.slice(dir.length)}:${String(statSync(full).mtimeMs)}`);
    }
  };
  walk(dir);
  return out.sort();
}

async function until(core: Core, runId: string): Promise<AssistantRunDetail> {
  for (let i = 0; i < 400; i++) {
    const run = core.assistant.run(runId);
    if (run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the run did not end');
}

const ANSWER = {
  summary: 'A payments API.',
  findings: [{ kind: 'stack', label: 'TypeScript' }],
  read: [{ kind: 'file', path: 'README.md' }, { kind: 'file', path: 'src/index.ts' }, { kind: 'git', path: null }],
  teamMembers: [
    { role: 'developer', agent: 'developer', model: 'sonnet', responsibility: 'Implements work items', writes: ['src/'], description: 'Implements work items', instructions: 'Run pnpm test before you finish.', reason: 'There is code to write' },
  ],
  resources: [{ kind: 'skills', name: 'payments', description: 'Payments rules', content: '---\nname: payments\ndescription: Payments rules\n---\nNever log a card.\n', reason: 'It handles cards' }],
  workItems: [{ type: 'task', title: 'Add CI', description: 'Run the tests on push.', priority: 'high', labels: ['ci'], acceptanceCriteria: ['Tests run on push'], epic: null, similarTo: null, reason: 'There is no CI.' }],
};

test('a run through the CLI reads only, answers with proposals, and each accept writes through its own service', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  const spawns = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  const core = new Core(config);
  const events: AgentryEvent[] = [];
  core.events.observe((e) => events.push(e));
  try {
    const dir = repo();
    const project = await core.importProject({ path: dir, name: 'pagos-api', template: 'software', modules: ['board', 'team'] });
    const before = snapshot(dir);

    const started = await core.assistant.start(project.id, { kind: 'project', description: `FAKE-RESULT-ASSISTANT ${JSON.stringify(ANSWER)}` });
    // The fake answers at once, so the run may have ended by the time starting it returns
    assert.ok(['running', 'completed'].includes(started.status));
    const run = await until(core, started.id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    assert.ok(run.chatId);
    assert.equal(run.costUsd, 0.01);
    assert.deepEqual(run.findings, ANSWER.findings);
    assert.deepEqual(run.proposals.map((p) => p.kind), ['team-member', 'resource', 'work-item']);
    const byPath = new Map(run.sources.map((x) => [x.path ?? x.kind, x.state]));
    assert.equal(byPath.get('README.md'), 'read');
    assert.equal(byPath.get('src/'), 'read');
    assert.equal(byPath.get('git'), 'read');

    // The flags the CLI was given: read tools only, in dontAsk, no MCP server, one structured answer
    const argv = readFileSync(spawns, 'utf8').split('\n').find((l) => l.includes('--json-schema')) ?? '';
    assert.match(argv, /--permission-mode dontAsk/);
    assert.match(argv, /--allowedTools=Read,Grep,Glob,LS,Bash\(git log \*\),Bash\(git status \*\),Bash\(ls \*\)/);
    assert.match(argv, /--disallowedTools=Edit,Write,MultiEdit,NotebookEdit,Task,Agent,WebFetch,WebSearch/);
    assert.match(argv, /--permission-prompts none/);
    assert.match(argv, /--strict-mcp-config/);
    assert.match(argv, /--model sonnet/);

    // Nothing was written by the run
    assert.deepEqual(snapshot(dir), before);
    assert.equal(core.workItems.list({ projectId: project.id }).length, 0);
    assert.deepEqual((await core.team.team(project.id)).members, []);

    const [member, resource, item] = run.proposals;
    assert.ok(member && resource && item);

    await core.assistant.accept(member.id);
    const team = await core.team.team(project.id);
    assert.deepEqual(team.members.map((m) => [m.agent, m.role, m.writes, m.file.state]), [['developer', 'developer', ['src/'], 'ok']]);
    const agentFile = readFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'utf8');
    assert.match(agentFile, /Run pnpm test before you finish\./);
    assert.ok(events.some((e) => e.type === 'team.changed' && e.agents.includes('developer')));

    await core.assistant.accept(resource.id);
    assert.equal(readFileSync(join(dir, '.claude', 'skills', 'payments', 'SKILL.md'), 'utf8'), '---\nname: payments\ndescription: Payments rules\n---\nNever log a card.\n');

    const accepted = await core.assistant.accept(item.id);
    assert.ok(accepted.kind === 'work-item' && accepted.created);
    const created = core.workItems.find(accepted.created.id);
    assert.deepEqual([created?.status, created?.title, created?.priority], ['backlog', 'Add CI', 'high']);
    assert.deepEqual(core.workItems.comments(accepted.created.id).map((c) => c.body), ['There is no CI.']);
    assert.deepEqual(core.assistant.run(run.id).counts['work-item'].accepted, 1);
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
  }
});

test('through the CLI, a run that fails ends failed and a stopped one stops its chat', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  try {
    const dir = repo();
    const project = await core.importProject({ path: dir, name: 'pagos-api', template: 'software', modules: ['board', 'team'] });
    const failing = await core.assistant.start(project.id, { kind: 'work-items', description: 'FAKE-FAIL the model is overloaded' });
    const failed = await until(core, failing.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'assistant.error.chat');
    assert.match(failed.error?.text ?? '', /overloaded/);

    const hanging = await core.assistant.start(project.id, { kind: 'project', description: 'FAKE-HANG' });
    for (let i = 0; i < 200 && !core.runtime.get(hanging.chatId ?? '')?.pid; i++) await new Promise((r) => setTimeout(r, 25));
    const stopped = core.assistant.stop(hanging.id);
    assert.equal(stopped.status, 'stopped');
    for (let i = 0; i < 200 && core.runtime.get(hanging.chatId ?? '')?.pid; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(core.runtime.get(hanging.chatId ?? '')?.pid ?? null, null, 'its process is gone');
    assert.equal(core.assistant.run(hanging.id).status, 'stopped');
    assert.equal(existsSync(join(dir, '.claude')), false, 'nothing was written');
  } finally {
    core.shutdown();
  }
});
