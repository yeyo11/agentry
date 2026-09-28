import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  AgentryEvent,
  AssistantProposal,
  AssistantResourceKind,
  AssistantRunDetail,
  ConfigScopeKind,
  ProjectModule,
  ProjectSettings,
  ProjectTeamMember,
} from '@agentry/shared';
import { assistantLanguage, parseAnswer, assistantSchema, assistantPrompt, type AssistantBrief, type AssistantGit } from '../src/assistant-answer.ts';
import { ASSISTANT_ERRORS, AssistantService, DENIED_TOOLS, memberFile, READ_ONLY_TOOLS, type AssistantKnown, type AssistantLaunch } from '../src/assistant.ts';
import { ASSISTANT_SCHEMA_VERSION, Db, migrate } from '../src/db.ts';
import { EventBus } from '../src/events.ts';
import { WorkItemService } from '../src/work-items.ts';
import { tempConfig } from './helpers.ts';

// The assistant starts paid runs and proposes writes, so these tests are as much about what must
// not happen (a write before an accept, a second run, a late result) as about what must. It runs
// over a real store and a real event bus; only the chats are scripted: `launch` records what it was
// asked and hands out a chat id, and a test answers with a result.

function settingsWith(modules: ProjectModule[] = ['board', 'team'], members: ProjectTeamMember[] = []): ProjectSettings {
  return {
    modules,
    template: 'software',
    keyPrefix: 'AGN',
    board: { types: ['epic', 'story', 'task', 'bug'], columnLimits: {} },
    team: { members },
  };
}

/** A small repository: a README, two sources and a document. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-assistant-'));
  writeFileSync(join(dir, 'README.md'), '# Pagos\n\nPayments API.\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'api.md'), '# API\n');
  return dir;
}

/** Every file under a directory with its size and mtime: what "nothing was written" is checked against. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const st = statSync(full);
        out.push(`${full.slice(dir.length)}:${String(st.size)}:${String(st.mtimeMs)}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function setup(opts: { dir?: string; settings?: ProjectSettings; db?: Db; commits?: number | null; chats?: number; chatPrefix?: string } = {}) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = opts.db ?? new Db(config);
  const bus = new EventBus();
  const events: AgentryEvent[] = [];
  bus.observe((e) => events.push(e));
  const dir = opts.dir ?? repo();
  const state = {
    settings: opts.settings ?? settingsWith(),
    resources: { agents: [] as string[], skills: [] as string[], commands: [] as string[] },
    instructions: null as string | null,
    git: { branch: 'main', commits: ['a1b2c3d 2026-09-20 Add the webhook'], changes: [' M src/a.ts'], moreChanges: 0 } as AssistantGit | null,
  };
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null), emit: (e) => bus.emit(e) });
  const launches: AssistantLaunch[] = [];
  const stopped: string[] = [];
  const busy = new Set<string>();
  const failNext: { message: string | null } = { message: null };
  const added: Array<{ member: ProjectTeamMember; content: string | null }> = [];
  const saved: Array<{ scope: ConfigScopeKind; kind: AssistantResourceKind; name: string; content: string }> = [];
  const failMember: { message: string | null } = { message: null };
  let chats = 0;
  const known = (): AssistantKnown => ({
    facts: {
      memoryFiles: 0,
      journalEntries: 2,
      workItems: items.list({ projectId: 'p1' }).length,
      milestones: ['v0.20'],
      teamMembers: state.settings.team?.members.length ?? 0,
      resources: [...state.resources.agents, ...state.resources.skills, ...state.resources.commands],
      chats: opts.chats ?? 3,
      commits: opts.commits === undefined ? 12 : opts.commits,
    },
    journal: '# Project journal',
    chats: ['Add the Stripe webhook'],
    resources: state.resources,
    instructions: state.instructions,
    git: state.git,
  });
  const assistant = new AssistantService({
    db,
    items,
    project: async (id) => {
      if (id !== 'p1') throw new Error('project not found');
      return { id: 'p1', name: 'pagos-api', path: dir, settings: state.settings };
    },
    known: async () => known(),
    launch: async (launch, onStart) => {
      if (failNext.message) {
        const message = failNext.message;
        failNext.message = null;
        throw new Error(message);
      }
      launches.push(launch);
      onStart(launch.resumeChatId ?? `${opts.chatPrefix ?? ''}chat-${String(++chats)}`);
    },
    chatBusy: (id) => busy.has(id),
    stop: (id) => void stopped.push(id),
    cost: () => null,
    addMember: async (_project, member, content) => {
      if (failMember.message) throw Object.assign(new Error(failMember.message), { statusCode: 409 });
      added.push({ member, content });
      state.settings = { ...state.settings, team: { members: [...(state.settings.team?.members ?? []), member] } };
    },
    resourceExists: async (_p, scope, kind, name) => saved.some((r) => r.scope === scope && r.kind === kind && r.name === name) || (scope === 'project' && state.resources[kind].includes(name)),
    saveResource: async (_p, scope, kind, name, content) => void saved.push({ scope, kind, name, content }),
    emit: (e) => bus.emit(e),
  });
  bus.observe((e) => assistant.observe(e));
  /** Answers the run's chat with a structured result. */
  const answer = (run: AssistantRunDetail, output: unknown, extra: { isError?: boolean; result?: string; costUsd?: number; cause?: 'stopped' } = {}) => {
    assert.ok(run.chatId, 'the run has a chat');
    assistant.chatResult(run.chatId, { isError: extra.isError ?? false, result: extra.result ?? '', structuredOutput: output, costUsd: extra.costUsd ?? 0.07, ...(extra.cause ? { cause: extra.cause } : {}) });
    return assistant.run(run.id);
  };
  return { db, bus, events, state, dir, items, assistant, launches, stopped, busy, failNext, added, saved, failMember, answer };
}

type Setup = ReturnType<typeof setup>;

const RESULT = {
  summary: 'A payments API in TypeScript.',
  findings: [
    { kind: 'stack', label: 'TypeScript' },
    { kind: 'stack', label: 'Fastify' },
    { kind: 'gap', label: 'no CI' },
  ],
  read: [
    { kind: 'file', path: 'README.md' },
    { kind: 'file', path: 'src/a.ts' },
    { kind: 'git', path: null },
  ],
  teamMembers: [
    { role: 'developer', agent: 'developer', model: 'sonnet', responsibility: 'Implements', writes: ['src/'], description: 'Implements', instructions: 'Use pnpm.', reason: 'There is code' },
    { role: 'Security Reviewer', agent: 'security', model: 'opus', responsibility: 'Reviews payment code', writes: [], description: 'When payment code changes', instructions: '', reason: 'It handles cards' },
  ],
  resources: [
    { kind: 'agents', name: 'migration-reviewer', description: 'Reviews migrations', content: '---\nname: migration-reviewer\ndescription: Reviews migrations\n---\nReview.', reason: 'db.ts has migrations' },
    { kind: 'skills', name: 'design-tokens', description: 'Tokens', content: '---\nname: design-tokens\ndescription: Tokens\n---\nUse tokens.\n', reason: 'Tokens rule' },
    { kind: 'commands', name: '/bad name', description: 'x', content: 'x', reason: 'dropped: the name is not a file name' },
  ],
  workItems: [
    { type: 'task', title: 'Add CI', description: 'Run the tests on push.', priority: 'high', labels: ['ci'], acceptanceCriteria: ['Tests run on push', 'Tests run on push'], epic: 'AGN-1', similarTo: null, reason: 'There is no CI.' },
    { type: 'bug', title: 'Retry webhooks', description: '', priority: 'weird', labels: [], acceptanceCriteria: [], epic: null, similarTo: null, reason: 'Stripe retries.' },
  ],
};

async function projectRun(s: Setup, extra: Record<string, unknown> = {}): Promise<AssistantRunDetail> {
  const run = await s.assistant.start('p1', { kind: 'project', ...extra });
  await s.assistant.settled();
  return run;
}

const proposalsOf = (run: AssistantRunDetail, kind: AssistantProposal['kind']) => run.proposals.filter((p) => p.kind === kind);
const runEvents = (s: Setup) => s.events.flatMap((e) => (e.type === 'assistant.run' ? [e.action] : []));

test('a project run is a read-only chat in the directory, with the schema, the journal and what Agentry knows', async () => {
  const s = setup();
  s.items.create('p1', { title: 'Epic of payments', type: 'epic' });
  const run = await projectRun(s);
  assert.equal(run.status, 'running');
  assert.equal(run.model, 'sonnet');
  assert.equal(run.chatId, 'chat-1');
  const launch = s.launches[0];
  assert.ok(launch);
  assert.equal(launch.cwd, s.dir);
  assert.equal(launch.permissionMode, 'dontAsk');
  assert.deepEqual(launch.tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(launch.allowedTools, READ_ONLY_TOOLS);
  assert.deepEqual(launch.disallowedTools, DENIED_TOOLS);
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash']) assert.ok(!launch.allowedTools.some((t) => t.startsWith(tool)), `${tool} is not allowed`);
  assert.equal(launch.appendSystemPrompt, '# Project journal');
  assert.equal(launch.resumeChatId, null);
  const schema = launch.jsonSchema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(schema.required, ['summary', 'read', 'findings', 'teamMembers', 'resources', 'workItems']);
  assert.match(launch.prompt, /read-only/);
  assert.match(launch.prompt, /AGN-1 \[epic, backlog\] Epic of payments/);
  assert.match(launch.prompt, /Add the Stripe webhook/);
  assert.match(launch.prompt, /Professional software template/);
  // What it will read is laid out; what Agentry hands it is already read
  const byPath = new Map(run.sources.map((x) => [x.path ?? x.kind, x]));
  assert.equal(byPath.get('README.md')?.state, 'pending');
  assert.equal(byPath.get('README.md')?.count, 3);
  assert.deepEqual([byPath.get('src/')?.state, byPath.get('src/')?.total, byPath.get('src/')?.unit], ['pending', 2, 'files']);
  assert.equal(byPath.get('docs/')?.unit, 'documents');
  assert.equal(byPath.get('CLAUDE.md')?.state, 'missing');
  assert.deepEqual([byPath.get('chats')?.state, byPath.get('chats')?.count], ['read', 3]);
  assert.deepEqual([byPath.get('git')?.state, byPath.get('git')?.count], ['read', 12]);
  assert.deepEqual(byPath.get('milestones')?.names, ['v0.20']);
  assert.deepEqual(runEvents(s), ['started', 'read']);
});

test('a project run proposes only the kinds whose modules are on', async () => {
  const s = setup({ settings: settingsWith([]) });
  await projectRun(s);
  const schema = s.launches[0]?.jsonSchema as { required: string[] };
  assert.deepEqual(schema.required, ['summary', 'read', 'findings', 'resources']);
  assert.doesNotMatch(s.launches[0]?.prompt ?? '', /teamMembers|workItems/);
});

test('what the chat reads fills in as it goes, and what it never read is dropped once it ends', async () => {
  const s = setup();
  const run = await projectRun(s);
  const reads = (tool: string, target: string) =>
    s.bus.emit({ type: 'chat.activity', title: '', runId: 'chat-1', runName: 'x', sessionId: 'chat-1', orchestrationId: null, internal: false, taskId: null, activity: { kind: 'tool', tool, target, since: new Date().toISOString() } });
  reads('Read', 'src/a.ts');
  reads('Read', join(s.dir, 'README.md'));
  reads('Read', '/etc/passwd');
  const now = s.assistant.run(run.id);
  const byPath = new Map(now.sources.map((x) => [x.path ?? x.kind, x]));
  assert.deepEqual([byPath.get('src/')?.state, byPath.get('src/')?.count, byPath.get('src/')?.total], ['partial', 1, 2]);
  assert.equal(byPath.get('README.md')?.state, 'read');
  assert.equal(byPath.get('git')?.state, 'read', 'Agentry handed it the history');
  assert.ok(!now.sources.some((x) => x.path?.includes('passwd')), 'nothing outside the project');
  // Announced once at once, the rest held back by the throttle
  assert.equal(runEvents(s).filter((a) => a === 'read').length, 2);

  const done = s.answer(now, { ...RESULT, read: [{ kind: 'file', path: 'src/b.ts' }] });
  const after = new Map(done.sources.map((x) => [x.path ?? x.kind, x]));
  assert.deepEqual([after.get('src/')?.state, after.get('src/')?.count], ['read', 2]);
  assert.equal(after.has('docs/'), false, 'never read, so not kept');
  assert.equal(after.get('CLAUDE.md')?.state, 'missing');
});

test('an answer becomes proposals of each kind, with what the project already has left out and the references resolved', async () => {
  const s = setup({ settings: settingsWith(['board', 'team'], [{ agent: 'developer', role: 'developer', model: 'sonnet', responsibility: 'Implements' }]) });
  s.state.resources.agents = ['migration-reviewer'];
  const epic = s.items.create('p1', { title: 'Payments', type: 'epic' });
  const existing = s.items.create('p1', { title: 'Retry webhooks!', type: 'bug' });
  const run = await projectRun(s);
  const done = s.answer(run, RESULT, { costUsd: 0.07 });
  assert.equal(done.status, 'completed');
  assert.equal(done.costUsd, 0.07);
  assert.ok(done.durationMs !== null && done.durationMs >= 0);
  assert.deepEqual(done.findings, RESULT.findings);
  assert.deepEqual(runEvents(s).slice(-1), ['ended']);

  const members = proposalsOf(done, 'team-member');
  assert.equal(members.length, 1, 'the developer is on the team already');
  const security = members[0];
  assert.ok(security?.kind === 'team-member');
  assert.equal(security.member.role, 'security-reviewer');
  assert.equal(security.member.fromTemplate, false);
  assert.equal(security.reason, 'It handles cards');
  assert.equal(security.status, 'pending');

  const resources = proposalsOf(done, 'resource');
  assert.deepEqual(
    resources.map((r) => (r.kind === 'resource' ? [r.resource.kind, r.resource.name, r.resource.path, r.resource.scope] : [])),
    [['skills', 'design-tokens', '.claude/skills/design-tokens/', 'project']],
  );

  const items = proposalsOf(done, 'work-item');
  assert.equal(items.length, 2);
  const [ci, retry] = items;
  assert.ok(ci?.kind === 'work-item' && retry?.kind === 'work-item');
  assert.equal(ci.workItem.epic?.id, epic.id);
  assert.deepEqual(ci.workItem.acceptanceCriteria, [{ text: 'Tests run on push' }]);
  assert.equal(retry.workItem.priority, 'medium');
  assert.equal(retry.workItem.similarTo?.key, existing.key, 'matched by its title');
  assert.deepEqual(done.counts['work-item'], { total: 2, pending: 2, accepted: 0, discarded: 0, superseded: 0 });
  assert.deepEqual(s.assistant.runs('p1')[0]?.counts.resource.total, 1);
});

test('nothing is written before the person accepts a proposal', async () => {
  const s = setup();
  const before = snapshot(s.dir);
  const run = await projectRun(s);
  s.answer(run, RESULT);
  assert.deepEqual(snapshot(s.dir), before);
  assert.equal(s.items.list({ projectId: 'p1' }).length, 0);
  assert.equal(s.added.length, 0);
  assert.equal(s.saved.length, 0);
  assert.ok(!s.events.some((e) => e.type === 'workitem.created' || e.type === 'team.changed'));
});

test('accepting a work item creates it in backlog with its reason as the first comment, once', async () => {
  const s = setup();
  s.items.create('p1', { title: 'Payments', type: 'epic' });
  const done = s.answer(await projectRun(s), RESULT);
  const ci = proposalsOf(done, 'work-item')[0];
  assert.ok(ci);
  const accepted = await s.assistant.accept(ci.id, { workItem: { title: 'Add CI on push' } });
  assert.ok(accepted.kind === 'work-item');
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.decidedBy, { kind: 'person', role: null });
  assert.ok(accepted.created);
  const item = s.items.find(accepted.created.id);
  assert.ok(item);
  assert.deepEqual([item.status, item.type, item.priority, item.title, item.labels], ['backlog', 'task', 'high', 'Add CI on push', ['ci']]);
  assert.equal(item.epicId, ci.kind === 'work-item' ? ci.workItem.epicId : 'x');
  assert.deepEqual(item.acceptanceCriteria.map((c) => c.text), ['Tests run on push']);
  const comments = s.items.comments(item.id);
  assert.deepEqual(comments.map((c) => [c.author.kind, c.body]), [['agent', 'There is no CI.']]);
  assert.equal(comments[0]?.source?.chatId, 'chat-1');
  const event = s.events.find((e) => e.type === 'assistant.proposal');
  assert.ok(event?.type === 'assistant.proposal');
  assert.deepEqual([event.action, event.itemId, event.proposalKind], ['accepted', item.id, 'work-item']);
  assert.ok(s.events.some((e) => e.type === 'workitem.created' && e.itemId === item.id));

  await assert.rejects(s.assistant.accept(ci.id, {}), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  assert.equal(s.items.list({ projectId: 'p1' }).length, 2, 'no second item');
  // Gone from the board, the proposal no longer points at it
  s.items.remove(item.id);
  const read = s.assistant.proposal(ci.id);
  assert.ok(read.kind === 'work-item');
  assert.equal(read.created, null);
});

test('accepting a team member goes through the team, with the agent file written from its instructions', async () => {
  const s = setup();
  const done = s.answer(await projectRun(s), RESULT);
  const [developer, security] = proposalsOf(done, 'team-member');
  assert.ok(developer && security);
  const accepted = await s.assistant.accept(developer.id, { member: { model: 'opus' } });
  assert.ok(accepted.kind === 'team-member');
  assert.equal(accepted.acceptedAgent, 'developer');
  assert.equal(s.added[0]?.member.model, 'opus');
  assert.deepEqual(s.added[0]?.member.writes, ['src/']);
  assert.match(s.added[0]?.content ?? '', /^---\nname: developer\ndescription: Implements\nmodel: opus\n---/);
  assert.match(s.added[0]?.content ?? '', /## In this project\n\nUse pnpm\.\n\n## What you may write/);
  // No instructions of its own: the team writes its starting file
  await s.assistant.accept(security.id);
  assert.equal(s.added[1]?.content, null);
  assert.deepEqual(s.added[1]?.member.writes, [], 'writes nothing but work items');
});

test('an accept the service refuses leaves the proposal pending, and a module switched off refuses before anything', async () => {
  const s = setup();
  const done = s.answer(await projectRun(s), RESULT);
  const member = proposalsOf(done, 'team-member')[0];
  assert.ok(member);
  s.failMember.message = 'the role developer is already x';
  await assert.rejects(s.assistant.accept(member.id), /already x/);
  assert.equal(s.assistant.proposal(member.id).status, 'pending');
  assert.equal(s.assistant.proposal(member.id).decidedBy, null);
  s.failMember.message = null;

  s.state.settings = { ...s.state.settings, modules: [] };
  const item = proposalsOf(done, 'work-item')[0];
  assert.ok(item);
  await assert.rejects(s.assistant.accept(item.id), (err: Error & { statusCode?: number }) => err.statusCode === 409 && /Board module is off/.test(err.message));
  await assert.rejects(s.assistant.accept(member.id), /Team module is off/);
  assert.equal(s.assistant.proposal(item.id).status, 'pending');
  assert.equal(s.items.list({ projectId: 'p1' }).length, 0);
});

test('accepting a resource is its save, with the name, content and scope the person left', async () => {
  const s = setup();
  const done = s.answer(await projectRun(s), RESULT);
  const [agent, skill] = proposalsOf(done, 'resource');
  assert.ok(agent && skill);
  const accepted = await s.assistant.accept(agent.id, { resource: { name: 'migrations', content: '---\ndescription: Mine\n---\nMine.\n', scope: 'user' } });
  assert.ok(accepted.kind === 'resource');
  assert.deepEqual(accepted.saved, { scope: 'user', name: 'migrations', path: 'agents/migrations.md' });
  assert.deepEqual(s.saved[0], { scope: 'user', kind: 'agents', name: 'migrations', content: '---\ndescription: Mine\n---\nMine.\n' });
  const event = s.events.findLast((e) => e.type === 'assistant.proposal');
  assert.ok(event?.type === 'assistant.proposal');
  assert.deepEqual(event.resource, { kind: 'agents', name: 'migrations', scope: 'user' });

  // A name that exists there is not overwritten
  s.state.resources.skills = ['design-tokens'];
  await assert.rejects(s.assistant.accept(skill.id), (err: Error & { statusCode?: number }) => err.statusCode === 409 && /already exists/.test(err.message));
  s.state.resources.skills = [];
  await assert.rejects(s.assistant.accept(skill.id, { resource: { name: '../x' } }), (err: Error & { statusCode?: number }) => err.statusCode === 400);
  await assert.rejects(s.assistant.accept(skill.id, { resource: { scope: 'elsewhere' } }), (err: Error & { statusCode?: number }) => err.statusCode === 400);
  assert.equal(s.assistant.proposal(skill.id).status, 'pending');
  const saved = await s.assistant.accept(skill.id);
  assert.ok(saved.kind === 'resource');
  assert.deepEqual(saved.saved, { scope: 'project', name: 'design-tokens', path: '.claude/skills/design-tokens/' });
});

test('a proposal is discarded and restored on its own, and only from the state that allows it', async () => {
  const s = setup();
  const done = s.answer(await projectRun(s), RESULT);
  const [one, two] = proposalsOf(done, 'work-item');
  assert.ok(one && two);
  const discarded = s.assistant.discard(one.id);
  assert.equal(discarded.status, 'discarded');
  assert.ok(discarded.decidedAt);
  assert.equal(s.assistant.proposal(two.id).status, 'pending', 'the others are untouched');
  assert.throws(() => s.assistant.discard(one.id), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  await assert.rejects(s.assistant.accept(one.id), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  assert.throws(() => s.assistant.restore(two.id), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  const restored = s.assistant.restore(one.id);
  assert.deepEqual([restored.status, restored.decidedBy, restored.decidedAt], ['pending', null, null]);
  assert.deepEqual(
    s.events.flatMap((e) => (e.type === 'assistant.proposal' ? [e.action] : [])),
    ['discarded', 'restored'],
  );
  assert.throws(() => s.assistant.discard('nope'), (err: Error & { statusCode?: number }) => err.statusCode === 404);
});

test('a run that fails, answers nothing readable or loses its chat ends failed, with a code a client translates', async () => {
  const s = setup();
  const failed = s.answer(await projectRun(s), null, { isError: true, result: 'overloaded' });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, { code: ASSISTANT_ERRORS.chat, text: 'overloaded' });
  assert.deepEqual(runEvents(s).slice(-1), ['failed']);
  assert.equal(failed.proposals.length, 0);

  const unreadable = s.answer(await projectRun(s), { nothing: true });
  assert.equal(unreadable.error?.code, ASSISTANT_ERRORS.unreadable);

  const lost = await projectRun(s);
  s.bus.emit({ type: 'run.ended', title: '', runId: lost.chatId ?? '', runName: 'x', sessionId: null, orchestrationId: null, internal: false, status: 'failed', error: 'killed', costUsd: 0, durationMs: 1 } as unknown as AgentryEvent);
  const read = s.assistant.run(lost.id);
  assert.equal(read.status, 'failed');
  assert.equal(read.error?.code, ASSISTANT_ERRORS.ended);
  assert.match(read.error?.text ?? '', /killed/);

  s.failNext.message = 'spawn ENOENT';
  const unstarted = await projectRun(s);
  assert.equal(s.assistant.run(unstarted.id).status, 'failed');
  assert.equal(s.assistant.run(unstarted.id).error?.code, ASSISTANT_ERRORS.start);
});

test('a stopped run stops its chat, proposes nothing, and a late result changes nothing', async () => {
  const s = setup();
  const run = await projectRun(s);
  const stopped = s.assistant.stop(run.id);
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(s.stopped, ['chat-1']);
  assert.ok(stopped.endedAt);
  const late = s.answer(run, RESULT);
  assert.equal(late.status, 'stopped');
  assert.equal(late.proposals.length, 0);
  assert.throws(() => s.assistant.stop(run.id), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  const ended = s.events.findLast((e) => e.type === 'assistant.run');
  assert.ok(ended?.type === 'assistant.run');
  assert.deepEqual([ended.action, ended.status], ['ended', 'stopped']);
});

test('one run at a time per project and kind', async () => {
  const s = setup();
  const first = await projectRun(s);
  await assert.rejects(s.assistant.start('p1', { kind: 'project' }), (err: Error & { statusCode?: number }) => err.statusCode === 409);
  assert.equal(s.launches.length, 1, 'the second one started nothing');
  const other = await s.assistant.start('p1', { kind: 'work-items' });
  assert.equal(other.status, 'running', 'another kind may run beside it');
  s.answer(first, RESULT);
  const again = await projectRun(s);
  assert.equal(again.status, 'running');
  assert.deepEqual(
    s.assistant.runs('p1', 'project').map((r) => r.id),
    [again.id, first.id],
    'latest first',
  );
  assert.equal(s.assistant.runs('p1').length, 3);
  assert.throws(() => s.assistant.runs('p1', 'nope'), (err: Error & { statusCode?: number }) => err.statusCode === 400);
});

test('suggesting again sets the pending proposals of the latest run aside; a new run alone leaves them', async () => {
  const s = setup();
  const first = s.answer(await projectRun(s), RESULT);
  const [taken, left] = proposalsOf(first, 'work-item');
  assert.ok(taken && left);
  await s.assistant.accept(taken.id);
  const plain = s.answer(await projectRun(s), RESULT);
  assert.equal(s.assistant.proposal(left.id).status, 'pending');
  assert.equal(plain.supersedes, null);

  const again = await projectRun(s, { supersede: true });
  assert.equal(again.supersedes, plain.id);
  const previous = s.assistant.run(plain.id);
  assert.equal(previous.supersededBy, again.id);
  assert.ok(previous.proposals.every((p) => p.status === 'superseded'));
  assert.equal(s.assistant.proposal(left.id).status, 'pending', 'only the latest finished run is set aside');
  assert.equal(s.assistant.proposal(taken.id).status, 'accepted');
  await assert.rejects(s.assistant.accept(previous.proposals[0]?.id ?? ''), (err: Error & { statusCode?: number }) => err.statusCode === 409);
});

test('a project with nothing to read starts no chat and is offered its template team', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-assistant-empty-'));
  mkdirSync(join(dir, '.claude'));
  const s = setup({ dir, commits: null, chats: 0 });
  const run = await projectRun(s);
  assert.equal(s.launches.length, 0);
  assert.deepEqual([run.status, run.empty, run.chatId, run.template, run.costUsd], ['completed', true, null, 'software', null]);
  const members = proposalsOf(run, 'team-member');
  assert.deepEqual(
    members.map((m) => (m.kind === 'team-member' ? [m.member.role, m.member.model, m.member.writes, m.member.fromTemplate] : [])),
    [
      ['product-owner', 'opus', [], true],
      ['architect', 'opus', ['docs/'], true],
      ['developer', 'sonnet', ['src/', 'tests/'], true],
      ['qa', 'sonnet', ['tests/'], true],
    ],
  );
  assert.deepEqual(runEvents(s), ['started', 'ended']);
  assert.ok(run.sources.some((x) => x.kind === 'git' && x.state === 'missing'));
  assert.deepEqual(snapshot(dir), []);

  // With a description there is something to go on: the chat runs
  const items = await s.assistant.start('p1', { kind: 'work-items', description: 'A notes app synced with a folder' });
  assert.equal(items.status, 'running');
  assert.equal(items.empty, true);
  assert.match(s.launches[0]?.prompt ?? '', /nothing to read yet[\s\S]*A notes app synced with a folder/);
});

test('create with AI builds one resource of the kind asked for', async () => {
  const s = setup();
  const run = await s.assistant.start('p1', { kind: 'resources', description: 'Reviews i18n parity', resourceKind: 'agents' });
  const schema = s.launches[0]?.jsonSchema as { required: string[]; properties: { resources: { maxItems: number; items: { properties: { kind: { enum: string[] } } } } } };
  assert.deepEqual(schema.required, ['summary', 'read', 'resources']);
  assert.equal(schema.properties.resources.maxItems, 1);
  assert.deepEqual(schema.properties.resources.items.properties.kind.enum, ['agents']);
  assert.match(s.launches[0]?.prompt ?? '', /exactly one agent[\s\S]*Reviews i18n parity/);
  s.state.resources.agents = ['i18n-parity'];
  const done = s.answer(run, {
    summary: 'ok',
    read: [],
    resources: [
      { kind: 'skills', name: 'wrong-kind', description: '', content: 'x', reason: '' },
      { kind: 'agents', name: 'i18n-parity', description: 'Parity', content: '---\nname: i18n-parity\n---\nCheck.', reason: 'asked' },
    ],
  });
  // Named like an existing one: still offered, since the person asked for it, and renamed in the editor
  assert.deepEqual(
    done.proposals.map((p) => (p.kind === 'resource' ? [p.resource.kind, p.resource.name, p.resource.content] : [])),
    [['agents', 'i18n-parity', '---\nname: i18n-parity\n---\nCheck.\n']],
  );
});

test('a start is refused when its request or the project does not allow it', async () => {
  const s = setup();
  const code = (n: number) => (err: Error & { statusCode?: number }) => err.statusCode === n;
  await assert.rejects(s.assistant.start('p1', { kind: 'everything' }), code(400));
  await assert.rejects(s.assistant.start('p1', { kind: 'project', model: 'rm -rf' }), code(400));
  await assert.rejects(s.assistant.start('p1', { kind: 'resources', description: 'x' }), code(400));
  await assert.rejects(s.assistant.start('p1', { kind: 'project', resourceKind: 'agents' }), code(400));
  await assert.rejects(s.assistant.start('p1', { kind: 'resources', resourceKind: 'agents' }), code(400));
  await assert.rejects(s.assistant.start('p1', { kind: 'project', supersede: 'yes' }), code(400));
  await assert.rejects(s.assistant.start('p1', { kind: 'project', description: 'x'.repeat(5000) }), code(400));
  await assert.rejects(s.assistant.start('p1', []), code(400));
  await assert.rejects(s.assistant.start('nope', { kind: 'project' }), /not found/);
  s.state.settings = settingsWith(['team']);
  await assert.rejects(s.assistant.start('p1', { kind: 'work-items' }), code(409));
  const opus = await s.assistant.start('p1', { kind: 'project', model: 'opus' });
  assert.equal(opus.model, 'opus');
  assert.equal(s.launches[0]?.model, 'opus');
});

test('a run a restart cut off continues once in its own chat; one that cannot ends failed', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const dir = repo();
  const first = setup({ db, dir });
  const cut = await projectRun(first);
  const unstarted = await first.assistant.start('p1', { kind: 'work-items' });
  await first.assistant.settled();
  // As if the process died before its chat started
  db.connection.prepare('UPDATE assistant_runs SET chat_id = NULL WHERE id = ?').run(unstarted.id);

  const second = setup({ db, dir, chatPrefix: 'after-' });
  await second.assistant.recover();
  assert.equal(second.launches.length, 2);
  const resumed = second.launches.find((l) => l.run.id === cut.id);
  assert.ok(resumed);
  assert.equal(resumed.resumeChatId, 'chat-1');
  assert.match(resumed.prompt, /Agentry restarted/);
  assert.deepEqual(resumed.allowedTools, READ_ONLY_TOOLS);
  assert.deepEqual([resumed.tools, resumed.disallowedTools], [READ_ONLY_TOOLS, DENIED_TOOLS], 'confined again');
  const fresh = second.launches.find((l) => l.run.id === unstarted.id);
  assert.equal(fresh?.resumeChatId, null);
  assert.equal(second.assistant.run(unstarted.id).chatId, 'after-chat-1');
  assert.match(fresh?.prompt ?? '', /read-only/);
  // It still ends with its result, in the chat it continued
  const done = second.answer(second.assistant.run(cut.id), RESULT);
  assert.equal(done.status, 'completed');

  // A second restart does not start it a third time
  const third = setup({ db, dir });
  await third.assistant.recover();
  assert.equal(third.launches.length, 0);
  const gaveUp = third.assistant.run(unstarted.id);
  assert.equal(gaveUp.status, 'failed');
  assert.equal(gaveUp.error?.code, ASSISTANT_ERRORS.restart);
});

test('a restart that finds the chat still going leaves it, and one that cannot continue it fails the run', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const dir = repo();
  const first = setup({ db, dir });
  const going = await projectRun(first);
  const broken = await first.assistant.start('p1', { kind: 'resources' });
  await first.assistant.settled();
  const second = setup({ db, dir });
  second.busy.add(going.chatId ?? '');
  second.failNext.message = 'the chat is held by a terminal';
  await second.assistant.recover();
  assert.equal(second.assistant.run(going.id).status, 'running');
  assert.equal(second.assistant.run(broken.id).status, 'failed');
  assert.equal(second.assistant.run(broken.id).error?.code, ASSISTANT_ERRORS.restart);
});

test('the schema of the migration arrives on an older database', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const version = (db.connection.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.ok(version >= ASSISTANT_SCHEMA_VERSION);
  const tables = db.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'assistant_%' ORDER BY name").all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((t) => t.name), ['assistant_proposals', 'assistant_runs']);
  db.close();
  assert.equal(typeof migrate, 'function');
});

test('the answer is read defensively: bad entries are dropped, long lists cut, and an answer that is not one is null', () => {
  const brief = { kind: 'project' as const, proposes: ['team-member', 'resource', 'work-item'] as const, resourceKind: null, description: null, templateTeam: [{ role: 'qa', model: 'sonnet', responsibility: 'Verifies' }] };
  const b = { ...brief, proposes: [...brief.proposes] };
  assert.equal(parseAnswer(null, b), null);
  assert.equal(parseAnswer('not json', b), null);
  assert.equal(parseAnswer({ read: [] }, b), null, 'no summary');
  const parsed = parseAnswer(
    JSON.stringify({
      summary: ' ok ',
      read: [{ kind: 'file', path: '../etc' }, { kind: 'dir', path: 'src' }, { kind: 'weird' }],
      teamMembers: [
        { role: 'QA', agent: 'qa', responsibility: 'Verifies' },
        { role: 'qa', agent: 'qa-2', responsibility: 'Twice' },
        { role: 'x', agent: '../x', responsibility: 'Bad agent name falls back to the role' },
        { role: '', responsibility: 'no role' },
      ],
      workItems: Array.from({ length: 30 }, (_, i) => ({ title: `Item ${String(i)}`, type: 'story' })),
    }),
    b,
  );
  assert.ok(parsed);
  assert.equal(parsed.summary, 'ok');
  assert.deepEqual(parsed.read, [{ kind: 'dir', path: 'src/' }]);
  assert.deepEqual(parsed.members.map((m) => [m.role, m.agent, m.fromTemplate, m.model]), [
    ['qa', 'qa', true, 'sonnet'],
    ['x', 'x', false, 'sonnet'],
  ]);
  assert.equal(parsed.workItems.length, 12);
  assert.deepEqual(parsed.resources, []);
  // A kind the run was not asked for is ignored
  const only = parseAnswer({ summary: 's', read: [], workItems: [{ title: 'x' }], findings: [{ kind: 'stack', label: 'TS' }] }, { ...b, kind: 'resources', proposes: ['resource'] });
  assert.deepEqual([only?.workItems, only?.findings], [[], []]);
});

test('the prompt and the schema say what a run is and is not', () => {
  const brief: AssistantBrief = {
    kind: 'work-items',
    projectName: 'claude-wrapper',
    description: null,
    focus: null,
    resourceKind: null,
    empty: false,
    proposes: ['work-item'],
    templateName: null,
    templateTeam: [],
    team: [],
    resources: { agents: [], skills: [], commands: [] },
    workItems: [{ key: 'AGN-45', type: 'story', status: 'backlog', title: 'Saved filters' }],
    moreWorkItems: 3,
    milestones: [],
    chats: [],
    git: null,
    language: 'en',
  };
  const prompt = assistantPrompt(brief);
  assert.match(prompt, /Do not try to create, edit or delete any file/);
  assert.match(prompt, /AGN-45 \[story, backlog\] Saved filters/);
  assert.match(prompt, /and 3 more/);
  assert.match(prompt, /`workItems`: the next work items/);
  const schema = assistantSchema(brief) as { required: string[] };
  assert.deepEqual(schema.required, ['summary', 'read', 'workItems']);
  assert.match(memberFile({ agent: 'dev', role: 'developer', model: 'sonnet', responsibility: 'Builds' }, 'Use pnpm.', 'When code changes'), /## In this project\n\nWhen to use it: When code changes\n\nUse pnpm\./);
  assert.equal(readFileSync.name, 'readFileSync');
});

test('a run is handed what it would have run git for and the project CLAUDE.md, and has no shell to ask', async () => {
  const s = setup();
  s.state.instructions = '# Pagos\n\nNever log a card.\n';
  s.state.git = { branch: 'feat/refunds', commits: ['a1b2c3d 2026-09-20 Add the webhook', 'e4f5a6b 2026-09-19 First'], changes: [' M src/a.ts', '?? notes.md'], moreChanges: 3 };
  await projectRun(s);
  const launch = s.launches[0];
  assert.ok(launch);
  assert.ok(!launch.tools.includes('Bash') && !launch.allowedTools.some((t) => t.startsWith('Bash')), 'no shell');
  assert.ok(DENIED_TOOLS.includes('Bash'));
  for (const secret of ['Read(./**/.env)', 'Read(./**/.env.*)', 'Read(./**/*.key)', 'Read(./**/id_rsa*)', 'Read(./**/credentials*)', 'Read(./.git/**)']) {
    assert.ok(launch.disallowedTools.includes(secret), `${secret} is denied`);
  }
  assert.match(launch.prompt, /### Git: on feat\/refunds/);
  assert.match(launch.prompt, /- a1b2c3d 2026-09-20 Add the webhook/);
  assert.match(launch.prompt, /- \?\? notes\.md\n- and 3 more/);
  assert.doesNotMatch(launch.prompt, /Bash|`git log`/);
  assert.match(launch.appendSystemPrompt, /^# Project journal\n\n# The project's CLAUDE\.md\n\n# Pagos\n\nNever log a card\./);

  const bare = setup();
  bare.state.git = null;
  bare.state.instructions = 'x'.repeat(50_000);
  await projectRun(bare);
  assert.doesNotMatch(bare.launches[0]?.prompt ?? '', /### Git/);
  assert.match(bare.launches[0]?.appendSystemPrompt ?? '', /\[cut at 40000 characters: read CLAUDE\.md for the rest\]$/);
});

test("a run's chat is titled in the person's language by the first line of its prompt", async () => {
  const titles: string[] = [];
  for (const [language, request] of [
    ['es', { kind: 'project' }],
    ['en', { kind: 'project' }],
    ['es', { kind: 'work-items' }],
    ['es', { kind: 'resources' }],
    ['es', { kind: 'resources', resourceKind: 'agents', description: 'Reviews migrations' }],
    ['en', { kind: 'resources', resourceKind: 'skills', description: 'Payments rules' }],
  ] as const) {
    const s = setup();
    await s.assistant.start('p1', request, language);
    await s.assistant.settled();
    titles.push(s.launches[0]?.prompt.split('\n')[0] ?? '');
  }
  assert.deepEqual(titles, [
    'Asistente de pagos-api',
    'Assistant for pagos-api',
    'Sugerir tareas · pagos-api',
    'Sugerir recursos · pagos-api',
    'Crear agente con IA · pagos-api',
    'Create skill with AI · pagos-api',
  ]);
  assert.deepEqual(['es-ES,es;q=0.9', 'de, es', 'en-US', 'fr', undefined, ['es']].map(assistantLanguage), ['es', 'es', 'en', 'en', 'en', 'en']);
});

test('suggesting again that ends with nothing to propose hands back the proposals it set aside', async () => {
  const s = setup();
  const first = s.answer(await projectRun(s), RESULT);
  const pending = first.proposals.filter((p) => p.status === 'pending').map((p) => p.id);
  assert.ok(pending.length > 1);

  // Its chat never starts
  s.failNext.message = 'Concurrent run limit reached (4)';
  const failed = await projectRun(s, { supersede: true });
  assert.equal(s.assistant.run(failed.id).status, 'failed');
  assert.equal(s.assistant.run(first.id).supersededBy, null);
  assert.deepEqual(pending.map((id) => s.assistant.proposal(id).status), pending.map(() => 'pending'));
  await s.assistant.accept(pending[0] ?? '');

  // Stopped by the person, or answering nothing readable: the same
  const stopped = await projectRun(s, { supersede: true });
  assert.ok(s.assistant.run(first.id).proposals.some((p) => p.status === 'superseded'));
  s.assistant.stop(stopped.id);
  assert.equal(s.assistant.run(first.id).supersededBy, null);
  assert.ok(!s.assistant.run(first.id).proposals.some((p) => p.status === 'superseded'));
  const unreadable = s.answer(await projectRun(s, { supersede: true }), 'not an answer');
  assert.equal(unreadable.status, 'failed');
  assert.ok(!s.assistant.run(first.id).proposals.some((p) => p.status === 'superseded'));
  const failedEvent = s.events.findLast((e) => e.type === 'assistant.run' && e.action === 'failed');
  assert.equal(failedEvent?.type === 'assistant.run' ? failedEvent.supersedes : null, first.id, 'its event names the run to read again');

  // One that completes replaces them, as asked
  const replaced = s.answer(await projectRun(s, { supersede: true }), RESULT);
  assert.equal(s.assistant.run(first.id).supersededBy, replaced.id);
  assert.equal(s.assistant.proposal(pending[1] ?? '').status, 'superseded');
});

test("a proposed member is held to the team's limits, and an edit past them is refused before anything is written", async () => {
  const brief = { kind: 'project' as const, proposes: ['team-member' as const], resourceKind: null, description: null, templateTeam: [] };
  const answer = parseAnswer(
    { summary: 's', read: [], findings: [], teamMembers: [{ role: 'r'.repeat(180), agent: 'x', model: 'm'.repeat(150), responsibility: 'y'.repeat(900), writes: ['src/'], description: 'd', instructions: '', reason: 'r' }] },
    brief,
  );
  const [member] = answer?.members ?? [];
  assert.ok(member);
  assert.deepEqual([member.role.length, member.model.length, member.responsibility.length], [100, 100, 500]);

  const s = setup();
  const run = s.answer(await projectRun(s), RESULT);
  const [proposed] = proposalsOf(run, 'team-member');
  assert.ok(proposed);
  for (const edit of [{ role: 'r'.repeat(101) }, { responsibility: 'y'.repeat(501) }, { instructions: 'i'.repeat(100_001) }, { writes: Array.from({ length: 51 }, (_, i) => `d${String(i)}/`) }]) {
    await assert.rejects(s.assistant.accept(proposed.id, { member: edit }), (err: Error & { statusCode?: number }) => err.statusCode === 400);
  }
  assert.equal(s.added.length, 0);
  assert.equal(s.assistant.proposal(proposed.id).status, 'pending');
});

test("Suggest tasks' focus is its own field, worded as where to look and not as what the project is for", async () => {
  const s = setup();
  const run = await s.assistant.start('p1', { kind: 'work-items', focus: "the checkout's error handling" });
  await s.assistant.settled();
  assert.equal(run.focus, "the checkout's error handling");
  assert.equal(run.description, null);
  const prompt = s.launches[0]?.prompt ?? '';
  assert.match(prompt, /## Where to look\n\nThe person asks for work items in this area[^\n]*\n\nthe checkout's error handling/);
  assert.match(prompt, /`workItems`: the next work items in the area above/);
  assert.doesNotMatch(prompt, /What the person says the project is for/);
  // Kept on the run, so it reads back with it and a restart words it the same
  assert.equal(s.assistant.runs('p1', 'work-items')[0]?.focus, "the checkout's error handling");
  assert.equal(s.assistant.run(run.id).focus, "the checkout's error handling");

  // A project run takes no focus; one without a focus reads as none
  await assert.rejects(s.assistant.start('p1', { kind: 'project', focus: 'x' }), /focus goes with a work-items run only/);
  await assert.rejects(s.assistant.start('p1', { kind: 'work-items', focus: 3 }), /focus must be a string/);
  await assert.rejects(s.assistant.start('p1', { kind: 'work-items', focus: 'x'.repeat(4001) }), /focus is longer/);
  const project = await projectRun(s);
  assert.equal('focus' in project, false);

  // On an empty project a focus is something to work from, as a description is
  const empty = setup({ dir: mkdtempSync(join(tmpdir(), 'agentry-assistant-empty-')), commits: null, chats: 0 });
  const focused = await empty.assistant.start('p1', { kind: 'work-items', focus: 'a payments API' });
  await empty.assistant.settled();
  assert.equal(focused.status, 'running');
  assert.equal(empty.launches.length, 1);
});

test('a run keeps its language, so one started again after a restart is titled as it was', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const dir = repo();
  const first = setup({ db, dir });
  const run = await first.assistant.start('p1', { kind: 'work-items', focus: 'webhooks' }, 'es');
  await first.assistant.settled();
  assert.equal(run.language, 'es');
  assert.equal(first.launches[0]?.prompt.split('\n')[0], 'Sugerir tareas · pagos-api');
  // As if the process died before its chat started: the run is asked again from its start
  db.connection.prepare('UPDATE assistant_runs SET chat_id = NULL WHERE id = ?').run(run.id);

  const second = setup({ db, dir });
  await second.assistant.recover();
  const again = second.launches[0];
  assert.ok(again);
  assert.equal(again.resumeChatId, null);
  assert.equal(again.prompt.split('\n')[0], 'Sugerir tareas · pagos-api');
  assert.match(again.prompt, /## Where to look[\s\S]*webhooks/, 'and with its focus');
  assert.equal(second.assistant.run(run.id).language, 'es');

  // A run stored before the language was kept reads as English
  db.connection.prepare('UPDATE assistant_runs SET language = NULL WHERE id = ?').run(run.id);
  assert.equal('language' in second.assistant.run(run.id), false);
});
