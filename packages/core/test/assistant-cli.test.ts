import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentryEvent, AssistantRunDetail } from '@agentry/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { DENIED_TOOLS } from '../src/assistant.ts';
import { Core } from '../src/index.ts';
import { UploadStore } from '../src/uploads.ts';
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

/** What makes an assistant chat read-only, as its spawned command line carries it. */
function assertConfined(argv: string): void {
  const args = argv.split(' ');
  assert.ok(args.includes('--restricted'), 'the file tools are kept to the working directory');
  assert.ok(args.includes('--tools=Read,Grep,Glob'), 'the only tools it has');
  assert.ok(args.includes('--setting-sources='), 'no user, project or local settings file');
  assert.ok(args.includes('--allowedTools=Read,Grep,Glob'), 'no Bash rule: git log --output writes a file');
  assert.ok(!args.includes('--add-dir'), 'no uploads directory');
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'), 'never to be switched to bypass');
  const denied = args.find((a) => a.startsWith('--disallowedTools='))?.split('=')[1]?.split(',') ?? [];
  for (const rule of ['Bash', 'Edit', 'Write', 'WebFetch', 'Read(./**/.env)', 'Read(./**/.env.*)', 'Read(./**/*.pem)', 'Read(./**/credentials*)', 'Read(./.git/**)']) {
    assert.ok(denied.includes(rule), `${rule} is denied`);
  }
  assert.match(argv, /--permission-mode dontAsk/);
  assert.match(argv, /--permission-prompts none/);
  assert.match(argv, /--strict-mcp-config/);
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

    // The flags the CLI was given: three read tools and nothing else, kept to the directory, no
    // settings file of the person's (their allow rules would add to these), no shell, no uploads
    // directory, secrets denied, in dontAsk, no MCP server, one structured answer
    const argv = readFileSync(spawns, 'utf8').split('\n').find((l) => l.includes('--json-schema')) ?? '';
    assertConfined(argv);
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

test('a confined chat is confined again when it is continued, and a continuation without it is a chat as any other', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  const spawns = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  runs.uploads = new UploadStore(config.dataDir);
  const confine = { tools: ['Read', 'Grep', 'Glob'], settingSources: [] };
  const rules = { permissionMode: 'dontAsk' as const, allowedTools: ['Read', 'Grep', 'Glob'], disallowedTools: DENIED_TOOLS, permissionPrompts: 'none' as const };
  const mcp = { servers: [], config: join(config.dataDir, 'no-servers.json') };
  try {
    const dir = repo();
    const chat = runs.start({ prompt: 'look', cwd: dir, keepAlive: false, confine, mcp, ...rules });
    const ended = async () => {
      await runs.waitForResult(chat.id);
      for (let i = 0; i < 200 && runs.get(chat.id)?.pid; i++) await new Promise((r) => setTimeout(r, 25));
    };
    await ended();
    runs.resume(chat.id, { prompt: 'go on', keepAlive: false, confine, ...rules });
    await ended();
    runs.resume(chat.id, { prompt: 'a person goes on', keepAlive: false, confine: null });
    await ended();
    const [first, resumed, person] = readFileSync(spawns, 'utf8').split('\n').filter(Boolean);
    assertConfined(first ?? '');
    assertConfined(resumed ?? '');
    assert.match(resumed ?? '', /--resume /);
    const theirs = (person ?? '').split(' ');
    assert.ok(theirs.includes('--add-dir'), 'a person continuing it has their uploads again');
    assert.ok(!theirs.includes('--restricted') && !theirs.some((a) => a.startsWith('--tools')));
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    db.close();
  }
});

test('a member proposed past the team limits is held to them, so accepting it as proposed goes through the real team', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  try {
    const dir = repo();
    const project = await core.importProject({ path: dir, name: 'pagos-api', template: 'software', modules: ['team'] });
    const long = {
      ...ANSWER,
      teamMembers: [{ ...ANSWER.teamMembers[0], role: `payments ${'x'.repeat(150)}`, agent: 'payments', responsibility: 'Owns payments. '.repeat(60) }],
      resources: [],
      workItems: [],
    };
    const started = await core.assistant.start(project.id, { kind: 'project', description: `FAKE-RESULT-ASSISTANT ${JSON.stringify(long)}` });
    const run = await until(core, started.id);
    const [member] = run.proposals;
    assert.ok(member?.kind === 'team-member');
    assert.ok(member.member.role.length <= 100 && member.member.responsibility.length <= 500);
    await core.assistant.accept(member.id);
    assert.deepEqual((await core.team.team(project.id)).members.map((m) => m.agent), ['payments']);

    // An edit past them is refused before anything is written, with the field it is about
    const again = await core.assistant.start(project.id, { kind: 'project', description: `FAKE-RESULT-ASSISTANT ${JSON.stringify({ ...long, teamMembers: [{ ...long.teamMembers[0], role: 'qa', agent: 'qa' }] })}` });
    const [qa] = (await until(core, again.id)).proposals;
    assert.ok(qa);
    await assert.rejects(core.assistant.accept(qa.id, { member: { responsibility: 'y'.repeat(501) } }), /member\.responsibility is longer than 500/);
    assert.equal(existsSync(join(dir, '.claude', 'agents', 'qa.md')), false);
    assert.equal(core.assistant.proposal(qa.id).status, 'pending');
  } finally {
    core.shutdown();
  }
});
