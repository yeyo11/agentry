import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { FlowRun, LimitAction, ProjectSettings } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// The flow through the real core, the fake Claude (`FAKE-LIMIT-ONCE`) and the fake Codex app-server:
// where a run starts, and what happens to it at a usage limit.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
// Automated work starts only on a provider that proved it is signed in
process.env.FAKE_CLAUDE_LOGGED_IN = '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-flow-rotation-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# Shop\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
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

/** The fake Codex behind the two probes the detector makes (`--version`, `login status`), which the fake itself does not answer */
function codexBinary(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'agentry-codex-bin-')), 'codex');
  writeFileSync(file, `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.159.3";; login) exit 0;; *) exec ${FAKE_CODEX} "$@";; esac\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A core whose data directory already says which providers there are, in what order, and what happens at a limit. */
function configWith(o: { order?: string[]; defaultProvider?: string | null; action?: LimitAction; allowed?: LimitAction[]; mapped?: boolean; claude?: boolean } = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(
    join(config.dataDir, 'providers.json'),
    JSON.stringify({
      providers: { codex: { enabled: true, binaryPath: codexBinary() }, ...(o.claude === false ? { 'claude-code': { enabled: false, binaryPath: null } } : {}) },
      order: o.order ?? ['claude-code', 'codex'],
      defaultProvider: o.defaultProvider ?? null,
      rotation: {
        onLimit: { action: o.action ?? 'handoff', allowed: o.allowed ?? ['handoff', 'wait'], maxWaitHours: 6, maxMoves: 2 },
        // A run starts on the member's alias and is on the model the CLI resolved it to when it hits a limit
        modelMap: o.mapped === false ? [] : ['sonnet', 'fake'].map((model) => ({ from: { provider: 'claude-code', model }, to: { provider: 'codex', model: 'gpt-5.5' }, origin: 'person', at: new Date().toISOString() })),
      },
    }),
  );
  return config;
}

async function flowProject(core: Core, dir: string, change: (s: ProjectSettings) => ProjectSettings = (s) => s) {
  const project = await core.importProject({ path: dir, name: 'shop', template: 'software', modules: ['board', 'team', 'documents'] });
  await core.team.fromTemplate(project.id, { roles: ['product-owner', 'developer', 'qa'] });
  const settings = await core.projectSettings(project.id);
  await core.saveProjectSettings(project.id, change({ ...settings, flow: { ...settings.flow!, enabled: true, maxParallel: 1, columns: { in_progress: 'developer' } } }));
  return project;
}

const WORK = { summary: 'Implemented', memoryProposals: [], documents: [] };
const limited = (title: string) => ({ title, status: 'in_progress' as const, type: 'task' as const, description: `FAKE-LIMIT-ONCE\nFAKE-RESULT-WORK ${JSON.stringify(WORK)}` });
const workRun = (core: Core, projectId: string, title?: string): FlowRun | undefined =>
  core.flow.runs(projectId).find((r) => r.stage === 'work' && (!title || r.item?.title === title));

test('a flow run on Claude at its limit continues on Codex, with its policy and pushes denied', async () => {
  const core = new Core(configWith());
  try {
    const project = await flowProject(core, repo());
    const item = core.workItems.create(project.id, limited('Fix the cart'));
    const first = await until(() => workRun(core, project.id)?.chatId, (id) => !!id, 'the run to start');
    const run = workRun(core, project.id)!;
    assert.equal(run.provider, 'claude-code');

    // The limit moves the run to a new chat on Codex: the flow's row follows it
    const moved = await until(() => workRun(core, project.id), (r) => r?.provider === 'codex', 'the run to move').catch((e: Error) => {
      throw new Error(`${e.message}: ${JSON.stringify([core.flow.runs(project.id), core.db.providerMoves({})])}`);
    });
    assert.notEqual(moved?.chatId, first);
    assert.equal(moved?.state === 'running' || moved?.state === 'ended', true);
    const [move] = core.db.providerMoves({ subjectKind: 'flow_run', subjectId: run.id });
    assert.equal(move?.state, 'moved');
    assert.equal(move?.action, 'handoff');
    assert.equal(move?.fromChat, first);
    assert.equal(move?.toProvider, 'codex');
    assert.equal(move?.toModel, 'gpt-5.5');

    // The new chat carries the stage's policy, translated for Codex: pushes are denied there too
    const codexChat = core.runtime.get(move!.toChat!);
    assert.equal(codexChat?.provider, 'codex');
    assert.equal(codexChat?.tools?.policy?.gitPush, 'deny');
    assert.ok(codexChat?.tools?.policy?.edit);
    // The chat it left is linked to it, and the item lists both
    assert.equal(core.runtime.get(first!)?.continuedIn?.chatId, codexChat?.id);
    const links = core.workItems.links(item.id).filter((l) => l.kind === 'chat');
    assert.ok(links.some((l) => l.chatId === codexChat?.id && l.role === 'work'));
    // A move is not a bounce, and the run did not fail for the limit
    assert.notEqual(workRun(core, project.id)?.cause, 'rate-limit');
  } finally {
    core.shutdown();
  }
});

test('a flow run under a budget waits for the reset: no other provider reports a cost, and a person can stop waiting', async () => {
  const core = new Core(configWith());
  try {
    const project = await flowProject(core, repo(), (s) => ({ ...s, flow: { ...s.flow!, maxCostUsd: 5 } }));
    core.workItems.create(project.id, limited('Fix the cart'));
    // The second card waits for a place: `maxParallel` is 1 and the waiting run keeps its own
    const second = core.workItems.create(project.id, { title: 'Fix the cart again', status: 'in_progress', type: 'task', description: `FAKE-RESULT-WORK ${JSON.stringify(WORK)}` });
    const run = await until(() => workRun(core, project.id, 'Fix the cart'), (r) => !!r?.chatId, 'the run to start');
    const wait = await until(() => core.db.providerMoves({ subjectKind: 'flow_run', subjectId: run!.id })[0], (m) => !!m, 'the wait to be recorded');
    assert.equal(wait?.action, 'wait');
    assert.equal(wait?.state, 'waiting');
    assert.equal(wait?.toChat, null, 'nothing moved: Codex reports no cost');
    // Still running, in the same chat, on Claude; it holds its place while the other card waits
    const waiting = core.flow.runs(project.id).find((r) => r.id === run!.id);
    assert.equal(waiting?.state, 'running');
    assert.equal(waiting?.chatId, run!.chatId);
    assert.equal(waiting?.provider, 'claude-code');
    assert.equal(waiting?.waiting?.moveId, wait?.id);
    await sleep(300);
    const other = core.flow.itemRuns(second.id)[0];
    assert.equal(other?.state, 'queued', 'a waiting run holds its place under maxParallel');

    // A person stops waiting: the run fails saying so, and the next card gets its place
    assert.equal(core.rotation.cancel(wait!.id), true);
    const ended = await until(() => core.flow.runs(project.id).find((r) => r.id === run!.id), (r) => r?.state === 'ended', 'the run to end');
    assert.equal(ended?.outcome, 'failed');
    assert.equal(ended?.cause, 'stopped');
    await until(() => core.flow.itemRuns(second.id)[0]?.state, (s) => s === 'running' || s === 'ended', 'the second run to take the place');
  } finally {
    core.shutdown();
  }
});

test('a default provider set to Codex runs a stage on Codex with its own rules, never with the rule strings of Claude', async () => {
  const core = new Core(configWith({ order: ['codex', 'claude-code'], defaultProvider: 'codex' }));
  try {
    const project = await flowProject(core, repo());
    core.workItems.create(project.id, { title: 'Fix the cart', status: 'in_progress', type: 'task', description: `FAKE-RESULT-WORK ${JSON.stringify(WORK)}` });
    const run = await until(() => workRun(core, project.id), (r) => !!r?.chatId, 'the run to start').catch((e: Error) => {
      throw new Error(`${e.message}: ${JSON.stringify(core.flow.runs(project.id))}`);
    });
    assert.equal(run?.provider, 'codex', JSON.stringify([run, core.providers.known()?.map((s) => [s.id, s.state, s.reason])]));
    const chat = core.runtime.get(run!.chatId!);
    assert.equal(chat?.provider, 'codex');
    assert.equal(chat?.tools?.policy?.gitPush, 'deny');
    // Claude's tool names are not a Codex rule
    assert.ok(!(chat?.tools?.allowedTools ?? []).some((rule) => /^(Read|Edit|Write|Bash)\b/.test(rule)), JSON.stringify(chat?.tools));
  } finally {
    core.shutdown();
  }
});

test('with no counterpart for its model and Claude off, a run ends with the cause no-provider', async () => {
  // Only Codex is in the order and the member's model has no mapping there
  const core = new Core(configWith({ order: ['codex'], mapped: false, claude: false }));
  try {
    const project = await flowProject(core, repo());
    core.workItems.create(project.id, { title: 'Fix the cart', status: 'in_progress', type: 'task', description: `FAKE-RESULT-WORK ${JSON.stringify(WORK)}` });
    const run = await until(() => workRun(core, project.id), (r) => r?.state === 'ended', 'the run to end');
    assert.equal(run?.outcome, 'failed');
    assert.equal(run?.cause, 'no-provider', JSON.stringify(run));
    assert.match(run?.error ?? '', /no-mapping|not-ready|not-in-order/);
  } finally {
    core.shutdown();
  }
});
