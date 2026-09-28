import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { FlowRun, ProjectSettings } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// The flow through the real core and the fake CLI (test/fixtures/fake-claude.mjs): each run is a
// real process given the real flags, logged by the fake, which is how what a run may do, and what a
// chat keeps of it afterwards, are checked. Nothing here reads the real ~/.claude.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-flow-cli-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# Shop\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node --test', build: 'tsc' } }));
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return dir;
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (done(value)) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every spawn's argv as the fake logged it; an argument can hold newlines, so entries split on the next `<pid> ` */
function spawnsOf(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split(/\n(?=\d+ )/).filter((l) => l.trim() && !/^\d+ (agents|--version|auth)/.test(l)) : [];
}

/** A list flag's value as the runtime writes it (`--allowedTools=a,b`): its rules hold spaces, so it runs to the next flag */
const flagOf = (argv: string, name: string): string[] => (new RegExp(`--${name}=(.*?) --[a-z]`).exec(argv)?.[1] ?? '').split(',');

async function start(config: ReturnType<typeof tempConfig>, path?: string) {
  const core = new Core(config);
  const project = path ? (await core.projects()).find((p) => p.path === path) : null;
  return { core, project };
}

async function flowProject(core: Core, dir: string, change: (s: ProjectSettings) => ProjectSettings = (s) => s) {
  const project = await core.importProject({ path: dir, name: 'shop', template: 'software', modules: ['board', 'team', 'documents'] });
  await core.team.fromTemplate(project.id, { roles: ['product-owner', 'developer', 'qa'] });
  const settings = await core.projectSettings(project.id);
  await core.saveProjectSettings(project.id, change({ ...settings, flow: { ...settings.flow!, enabled: true, maxParallel: 1 } }));
  return project;
}

function configWithFake() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  const spawns = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  return { config, spawns };
}

const WORK = { summary: 'Implemented', memoryProposals: [], documents: [] };

test("a Developer's run never takes over the person's own work chat, and a chat the flow ran is the person's again when they continue it", async () => {
  const { config, spawns } = configWithFake();
  const core = new Core(config);
  try {
    const dir = repo();
    const project = await flowProject(core, dir, (s) => ({ ...s, flow: { ...s.flow!, columns: { in_progress: 'developer' } } }));
    // The person's "Work on it" chat, in todo, where no role answers
    const item = core.workItems.create(project.id, { title: 'Keep the cart', status: 'todo', type: 'task', description: `FAKE-RESULT-WORK ${JSON.stringify(WORK)}` });
    const { chat: personal } = await core.workOnItem(item.id);
    await until(() => core.runtime.get(personal.id)?.status, (s) => s === 'idle' || s === 'completed', 'the person chat to answer');
    core.runtime.stop(personal.id);
    await until(() => core.runtime.get(personal.id)?.pid, (pid) => pid === null, 'the person chat to stop');

    // A person moves it on: the Developer's run starts, in a chat of its own
    core.workItems.move(item.id, { status: 'in_progress' }, { actor: { kind: 'person' } });
    const run = await until(
      () => core.flow.runs(project.id).find((r) => r.stage === 'work'),
      (r): r is FlowRun => !!r && r.state === 'ended',
      'the developer run to end',
    );
    assert.equal(run?.outcome, 'passed');
    assert.notEqual(run?.chatId, personal.id, 'the flow resumed the person chat');
    const personalSpawns = spawnsOf(spawns).filter((l) => l.includes(personal.id));
    assert.ok(personalSpawns.every((l) => !l.includes('--agent')), 'the person chat was started as a member');

    // The person continues the Developer's chat: it is a chat again, not the member's run
    const flowChat = run!.chatId!;
    await until(() => core.runtime.get(flowChat)?.pid, (pid) => pid === null, 'the run process to exit');
    await core.chats.resume(flowChat, { prompt: 'thanks, one more thing' });
    await until(() => spawnsOf(spawns).filter((l) => l.includes(`--resume ${flowChat}`)).length, (n) => n >= 1, 'the resume to spawn');
    const resumed = spawnsOf(spawns).filter((l) => l.includes(`--resume ${flowChat}`)).at(-1) ?? '';
    for (const kept of ['--agent ', '--agents ', '--json-schema', '--append-system-prompt', '--allowedTools', '--disallowedTools', '--max-budget-usd', '--permission-mode dontAsk', '--system-prompt-snapshot']) {
      assert.ok(!resumed.includes(kept), `the person's resume still carries ${kept}: ${resumed}`);
    }
    await until(() => core.runtime.get(flowChat)?.status, (s) => s === 'idle', 'the resumed chat to stay open for the person');
    // The person's attachments are theirs again, and the chat no longer a run's
    assert.match(resumed, /--add-dir/);
    assert.equal(core.runtime.heldToSchema(flowChat), false);
  } finally {
    core.shutdown();
    delete process.env.FAKE_CLAUDE_SPAWNS;
  }
});

test('a run a restart cut off continues in its own chat; with no chat to continue it fails with a comment, never a fresh chat with no context', async () => {
  const { config, spawns } = configWithFake();
  const dir = repo();
  let core = new Core(config);
  let projectId = '';
  let itemId = '';
  let chatId = '';
  try {
    const project = await flowProject(core, dir, (s) => ({ ...s, flow: { ...s.flow!, columns: { in_progress: 'developer' } } }));
    projectId = project.id;
    const item = core.workItems.create(project.id, { title: 'Hang', status: 'in_progress', type: 'task', description: 'FAKE-HANG' });
    itemId = item.id;
    const run = await until(() => core.flow.runs(project.id)[0], (r) => !!r?.chatId && r.state === 'running', 'the run to start');
    chatId = run!.chatId!;
  } finally {
    core.shutdown();
  }
  // The chat's record is lost (trimmed, or removed), so nothing can continue it
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  raw.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  raw.close();
  const before = spawnsOf(spawns).length;
  core = new Core(config);
  try {
    const ended = await until(() => core.flow.runs(projectId)[0], (r) => r?.state === 'ended', 'the cut run to end');
    assert.equal(ended?.outcome, 'failed');
    await sleep(200);
    const fresh = spawnsOf(spawns).slice(before);
    assert.deepEqual(fresh.filter((l) => l.includes('--json-schema')), [], 'a fresh chat was started for the cut run');
    const comments = core.workItems.comments(itemId);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.author.kind, 'agent');
    assert.match(comments[0]?.body ?? '', /restart/i);
  } finally {
    core.shutdown();
    delete process.env.FAKE_CLAUDE_SPAWNS;
  }
});

test('each stage runs with its own rules, its budget and no recorded system prompt; refining makes no worktree; the agents file carries the list fields', async () => {
  const { config, spawns } = configWithFake();
  const core = new Core(config);
  try {
    const dir = repo();
    const project = await flowProject(core, dir, (s) => ({ ...s, flow: { ...s.flow!, maxCostUsd: 1.5, columns: { backlog: 'product-owner', in_progress: 'developer', in_review: 'qa' } } }));
    // A person's own agent file for QA: its tools as a block list, and a model its metadata does not say
    writeFileSync(join(dir, '.claude', 'agents', 'qa.md'), '---\nname: qa\ndescription: Verifies\nmodel: haiku\ntools:\n  - Read\n  - Grep\n  - Bash\n---\nVerify it.\n');
    const refine = { summary: 'Refined', memoryProposals: [], documents: [] };
    const verify = { summary: 'Holds', verdict: 'pass', criteria: [], memoryProposals: [], documents: [] };
    const item = core.workItems.create(project.id, {
      title: 'Keep the cart',
      status: 'backlog',
      type: 'task',
      description: `FAKE-RESULT-REFINE ${JSON.stringify(refine)}\nFAKE-RESULT-WORK ${JSON.stringify(WORK)}\nFAKE-RESULT-VERIFY ${JSON.stringify(verify)}`,
    });
    await until(() => core.workItems.find(item.id)?.status, (s) => s === 'todo', 'the refine run to move the item');
    assert.equal(core.workItems.find(item.id)?.worktree, null, 'refining made a worktree');
    core.workItems.move(item.id, { status: 'in_progress' }, { actor: { kind: 'person' } });
    await until(() => core.workItems.find(item.id)?.waiting, (w) => w === 'approval', 'QA to pass the item');
    assert.ok(core.workItems.find(item.id)?.worktree, 'working and verifying happen in the worktree');

    const runs = spawnsOf(spawns).filter((l) => l.includes('--json-schema'));
    const [po, dev, qa] = runs;
    assert.ok(po && dev && qa, `three runs started: ${runs.length}`);
    for (const argv of [po, dev, qa]) {
      assert.ok(flagOf(argv, 'disallowedTools').includes('Bash(git push)'));
      assert.match(argv, /--max-budget-usd 1\.5/);
      assert.match(argv, /--system-prompt-snapshot off/);
      assert.doesNotMatch(argv, /--add-dir/);
    }
    assert.match(po, /--permission-mode dontAsk/);
    assert.ok(!flagOf(po, 'allowedTools').some((r) => r.startsWith('Bash') || r.startsWith('Web')));
    assert.ok(flagOf(dev, 'allowedTools').includes('WebFetch'));
    const qaTools = flagOf(qa, 'allowedTools');
    assert.ok(qaTools.includes('Bash(npm run test)'));
    assert.ok(!qaTools.some((r) => r === 'Bash' || r.startsWith('Web') || r.includes('build')));

    const agentsFile = /--agents (\S+\.json)/.exec(qa)?.[1];
    assert.ok(agentsFile);
    const definition = JSON.parse(readFileSync(agentsFile, 'utf8')) as Record<string, { tools?: string[]; model?: string }>;
    assert.deepEqual(definition.qa?.tools, ['Read', 'Grep', 'Bash']);
    assert.equal(definition.qa?.model, 'sonnet');

    // A turn held to a schema is the run's: a rate limit's replay would spend again for nobody
    const qaChat = core.flow.runs(project.id).find((r) => r.stage === 'verify')?.chatId;
    assert.ok(qaChat);
    assert.equal(core.runtime.heldToSchema(qaChat), true);
  } finally {
    core.shutdown();
    delete process.env.FAKE_CLAUDE_SPAWNS;
  }
});
