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

/** Every spawn's argv as the fake logged it; an argument can hold newlines, so entries split on the next `<pid> ` */
function spawnsOf(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split(/\n(?=\d+ )/).filter((l) => l.trim() && !/^\d+ (agents|--version|auth)/.test(l)) : [];
}

async function spawned(file: string, match: (argv: string) => boolean, what: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const found = spawnsOf(file).filter(match).at(-1);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The flow's hand-back and the assistant's confinement meet in ChatService.resume: an assistant
// chat is one of Agentry's runs, so a person continuing it is handed it back, and the run's own
// continuation after a restart must still come back confined through that same path.
test('a person who continues an assistant chat through the core gets an ordinary chat, with no rule or recorded prompt of the run', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  const spawns = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  const core = new Core(config);
  try {
    const dir = repo();
    const project = await core.importProject({ path: dir, name: 'pagos-api', template: 'software', modules: ['board', 'team'] });
    const started = await core.assistant.start(project.id, { kind: 'project', description: `FAKE-RESULT-ASSISTANT ${JSON.stringify(ANSWER)}` });
    const run = await until(core, started.id);
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    const chatId = run.chatId ?? '';
    const first = await spawned(spawns, (l) => l.includes(chatId) && l.includes('--json-schema'), 'the run to spawn');
    assertConfined(first);
    // The run's prompt (the journal and CLAUDE.md, rendered for a confined session) is never
    // recorded, so it cannot outlive the run into the person's chat
    assert.match(first, /--system-prompt-snapshot off/);
    for (let i = 0; i < 200 && core.runtime.get(chatId)?.pid; i++) await new Promise((r) => setTimeout(r, 25));

    // A copy is the person's too: the run's read-only rules were never theirs to carry over
    const copy = await core.chats.fork(chatId, { prompt: 'try it another way' });
    const forked = await spawned(spawns, (l) => l.includes(`--fork-session --session-id ${copy.id}`), 'the copy to spawn');
    for (const kept of ['--restricted', '--permission-mode dontAsk', '--allowedTools=Read,Grep,Glob', '--disallowedTools=Bash', '--json-schema']) {
      assert.ok(!forked.includes(kept), `the person's copy still carries ${kept}: ${forked}`);
    }

    await core.chats.resume(chatId, { prompt: 'thanks, now fix the README' });
    const theirs = await spawned(spawns, (l) => l.includes(`--resume ${chatId}`), 'the person to continue the chat');
    for (const kept of ['--restricted', '--tools=', '--setting-sources', '--permission-mode dontAsk', '--append-system-prompt', '--json-schema', '--allowedTools=Read,Grep,Glob', '--system-prompt-snapshot']) {
      assert.ok(!theirs.includes(kept), `the person's continuation still carries ${kept}: ${theirs}`);
    }
    assert.match(theirs, /--add-dir/, 'their uploads are readable again');
    assert.match(theirs, /--allow-dangerously-skip-permissions/);
    assert.equal(core.runtime.heldToSchema(chatId), false);
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
  }
});

test('an assistant run a restart cut off continues through the core confined again, not handed back', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  const spawns = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  const dir = repo();
  let core = new Core(config);
  let chatId = '';
  let runId = '';
  try {
    const project = await core.importProject({ path: dir, name: 'pagos-api', template: 'software', modules: ['board', 'team'] });
    const started = await core.assistant.start(project.id, { kind: 'project', description: 'FAKE-HANG' });
    runId = started.id;
    for (let i = 0; i < 200 && !core.runtime.get(core.assistant.run(runId).chatId ?? '')?.pid; i++) await new Promise((r) => setTimeout(r, 25));
    chatId = core.assistant.run(runId).chatId ?? '';
    assert.ok(chatId);
  } finally {
    core.shutdown();
  }
  core = new Core(config);
  try {
    const resumed = await spawned(spawns, (l) => l.includes(`--resume ${chatId}`), 'the cut run to continue');
    assertConfined(resumed);
    assert.match(resumed, /--json-schema/);
    assert.match(resumed, /--system-prompt-snapshot off/);
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
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

test('"Create with AI" shows the file while the chat writes it, from the result the CLI streams, and saves nothing', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  const core = new Core(config);
  const events: AgentryEvent[] = [];
  core.events.observe((e) => events.push(e));
  try {
    const dir = repo();
    const project = await core.importProject({ path: dir, name: 'pagos-api', template: 'software', modules: [] });
    const before = snapshot(dir);
    const content = `---\nname: migration-reviewer\ndescription: Reviews "migrations"\n---\n${'Check every ALTER TABLE.\n'.repeat(20)}`;
    const answer = {
      summary: 'One agent.',
      read: [{ kind: 'file', path: 'README.md' }],
      resources: [{ kind: 'agents', name: 'migration-reviewer', description: 'Reviews migrations', content, reason: 'db.ts has migrations' }],
    };
    const release = join(config.dataDir, 'release');
    const started = await core.assistant.start(project.id, {
      kind: 'resources',
      resourceKind: 'agents',
      description: `Reviews migrations\nFAKE-RESULT-ASSISTANT ${JSON.stringify(answer)}\nFAKE-STREAM-HOLD ${release}`,
    });
    let running = core.assistant.run(started.id);
    for (let i = 0; i < 200 && !running.draft?.content; i++) {
      await new Promise((r) => setTimeout(r, 25));
      running = core.assistant.run(started.id);
    }
    assert.equal(running.status, 'running');
    const draft = running.draft;
    assert.ok(draft, 'the file shows before the run ends');
    assert.equal(draft.kind, 'agents');
    assert.equal(draft.name, 'migration-reviewer');
    assert.ok(draft.content.length > 0 && draft.content.length < content.length, 'as far as the chat has written it');
    assert.ok(content.startsWith(draft.content), 'escapes read as the text they stand for');
    assert.ok(events.some((e) => e.type === 'assistant.run' && e.runId === started.id && e.action === 'read'), 'announced, so a client reads it again');
    assert.deepEqual(snapshot(dir), before, 'nothing is saved while it is written');

    writeFileSync(release, '');
    const done = await until(core, started.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.draft, undefined, 'an ended run has its proposal instead');
    const [proposal] = done.proposals;
    assert.ok(proposal?.kind === 'resource');
    assert.equal(proposal.resource.content, content);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    core.shutdown();
  }
});
