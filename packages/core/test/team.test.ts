import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentryEvent, FlowRun, Project, ProjectModule, ProjectSettings, ProjectTemplateId } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { agentFileContent, readFrontmatter, readFrontmatterList, templateTeam, TeamError } from '../src/team.ts';
import { tempConfig } from './helpers.ts';

// Nothing here reaches the CLI: the team is files and settings, over scratch directories.

async function withCore(fn: (core: Core) => Promise<void>): Promise<void> {
  const core = new Core(tempConfig());
  try {
    await fn(core);
  } finally {
    core.db.close();
  }
}

async function project(core: Core, template: ProjectTemplateId | null = 'software', modules?: ProjectModule[]): Promise<Project> {
  const path = mkdtempSync(join(tmpdir(), 'agentry-team-'));
  return core.importProject({ path, name: 'Shop', ...(template ? { template } : {}), ...(modules ? { modules } : {}) });
}

const agentFile = (p: Project, agent: string) => join(p.path, '.claude', 'agents', `${agent}.md`);

async function feed(core: Core, fn: () => Promise<unknown>): Promise<AgentryEvent[]> {
  const events: AgentryEvent[] = [];
  const stop = core.events.subscribe((e) => events.push(e));
  try {
    await fn();
  } finally {
    stop();
  }
  return events;
}

async function rejects(promise: Promise<unknown>, status: number, message: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TeamError, String(err));
    assert.equal(err.statusCode, status);
    assert.match(err.message, message);
    return true;
  });
}

test('the template writes an agent file per role, fills the flow and leaves it off', async () => {
  await withCore(async (core) => {
    const p = await project(core);
    const events = await feed(core, () => core.team.fromTemplate(p.id, {}));
    const team = await core.team.team(p.id);
    assert.equal(team.enabled, true);
    assert.deepEqual(
      team.members.map((m) => [m.agent, m.role, m.model, m.file.state]),
      [
        ['product-owner', 'product-owner', 'opus', 'ok'],
        ['architect', 'architect', 'opus', 'ok'],
        ['developer', 'developer', 'sonnet', 'ok'],
        ['qa', 'qa', 'sonnet', 'ok'],
      ],
    );
    assert.deepEqual(team.unassignedAgents, []);

    const content = readFileSync(agentFile(p, 'qa'), 'utf8');
    assert.deepEqual(readFrontmatter(content), { name: 'qa', description: 'Verifies each item against its acceptance criteria', model: 'sonnet' });
    assert.match(content, /You are the QA of this project's team/);
    assert.match(content, /`verdict`/);
    assert.match(content, /Never move a work item to `done`/);

    const settings = await core.projectSettings(p.id);
    assert.deepEqual(settings.flow, {
      enabled: false,
      columns: { backlog: 'product-owner', todo: 'product-owner', in_progress: 'developer', in_review: 'qa' },
      maxBounces: 3,
    });
    assert.deepEqual(team.members.find((m) => m.agent === 'product-owner')?.columns, ['backlog', 'todo']);
    assert.deepEqual(team.members.find((m) => m.agent === 'architect')?.columns, []);

    const changed = events.filter((e) => e.type === 'team.changed');
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0]?.type === 'team.changed' && [changed[0].action, changed[0].agents], ['template', ['product-owner', 'architect', 'developer', 'qa']]);
    assert.ok(events.some((e) => e.type === 'project.updated'));

    // A second time finds every role on the team: nothing is written and nothing is announced
    const again = await feed(core, () => core.team.fromTemplate(p.id, {}));
    assert.equal(again.length, 0);
    assert.equal((await core.team.team(p.id)).members.length, 4);
  });
});

test('roles are accepted one by one, and a role the template does not offer is refused', async () => {
  await withCore(async (core) => {
    const p = await project(core);
    await rejects(core.team.fromTemplate(p.id, { roles: ['developer', 'ceo'] }), 400, /no role ceo/);
    await core.team.fromTemplate(p.id, { roles: ['developer'] });
    assert.deepEqual((await core.team.team(p.id)).members.map((m) => m.agent), ['developer']);
    assert.deepEqual((await core.projectSettings(p.id)).flow?.columns, { in_progress: 'developer' });
    assert.equal(existsSync(agentFile(p, 'qa')), false);

    await core.team.fromTemplate(p.id, { roles: ['qa'] });
    assert.deepEqual((await core.team.team(p.id)).members.map((m) => m.agent), ['developer', 'qa']);
    // A column the person gave to someone else is theirs: the template fills only empty ones
    const settings = await core.projectSettings(p.id);
    assert.deepEqual(settings.flow?.columns, { in_progress: 'developer', in_review: 'qa' });
  });
});

test('adding from the template says which members it added, and nothing when every role is there', async () => {
  await withCore(async (core) => {
    const p = await project(core);
    const first = await core.team.addFromTemplate(p.id, { roles: ['developer', 'qa'] });
    assert.deepEqual(first.added, ['developer', 'qa']);
    const again = await core.team.addFromTemplate(p.id, { roles: ['developer', 'qa'] });
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.team.members.map((m) => m.agent), ['developer', 'qa']);
  });
});

test("an agent file saved or deleted through the resources is announced as the team's file change", async () => {
  await withCore(async (core) => {
    const p = await project(core);
    await core.team.fromTemplate(p.id, { roles: ['qa'] });
    const scope = await core.resolveScope(p.id);
    const settle = () => new Promise((r) => setTimeout(r, 50));
    const fileEvents = (events: AgentryEvent[]) => events.filter((e) => e.type === 'team.changed' && e.action === 'file');

    const saved = await feed(core, async () => {
      await core.resources.save(scope, 'agents', 'qa', '---\nname: qa\ndescription: Mine\n---\nMine.\n');
      await settle();
    });
    assert.deepEqual(
      fileEvents(saved).map((e) => (e.type === 'team.changed' ? [e.projectId, e.agents] : null)),
      [[p.id, ['qa']]],
    );
    // An agent nobody on the team is yet, while the module is on: its unassigned agents changed
    const other = await feed(core, async () => {
      await core.resources.save(scope, 'agents', 'helper', '---\nname: helper\ndescription: Helps\n---\n');
      await core.resources.remove(scope, 'agents', 'helper');
      await settle();
    });
    assert.equal(fileEvents(other).length, 2);
    // Another kind of resource, or the user's own agents, are not the team's
    const unrelated = await feed(core, async () => {
      await core.resources.save(scope, 'commands', 'qa', 'Run the tests.\n');
      await core.resources.save(await core.resolveScope(), 'agents', 'qa', '---\nname: qa\ndescription: Mine\n---\n');
      await settle();
    });
    assert.equal(fileEvents(unrelated).length, 0);
  });
});

test('an agent file that already exists is kept as it is, and reported when it disagrees', async () => {
  await withCore(async (core) => {
    const p = await project(core);
    mkdirSync(join(p.path, '.claude', 'agents'), { recursive: true });
    const mine = '---\nname: developer\ndescription: My own developer\nmodel: haiku\n---\n\nMy instructions.\n';
    writeFileSync(agentFile(p, 'developer'), mine);
    writeFileSync(agentFile(p, 'helper'), '---\nname: helper\ndescription: Helps\n---\n');

    const team = await core.team.fromTemplate(p.id, {});
    assert.equal(readFileSync(agentFile(p, 'developer'), 'utf8'), mine);
    const developer = team.members.find((m) => m.agent === 'developer');
    assert.equal(developer?.file.state, 'drifted');
    assert.deepEqual(developer?.file.drift, ['description', 'model']);
    assert.equal(developer?.file.description, 'My own developer');
    assert.equal(developer?.file.model, 'haiku');
    assert.deepEqual(team.unassignedAgents, ['helper']);

    // Nor does changing the metadata write over it: only a file still exactly Agentry's follows it
    await core.team.putMember(p.id, 'developer', { role: 'developer', model: 'opus', responsibility: 'Builds it' });
    assert.equal(readFileSync(agentFile(p, 'developer'), 'utf8'), mine);
  });
});

test("a file Agentry wrote follows the metadata until a person edits it; then it is theirs", async () => {
  await withCore(async (core) => {
    const p = await project(core);
    await core.team.fromTemplate(p.id, { roles: ['developer'] });
    const member = await core.team.putMember(p.id, 'developer', {
      role: 'developer',
      model: 'opus',
      responsibility: 'Implements: carefully, in its worktree',
      writes: ['src/**', 'test/**'],
    });
    assert.equal(member.file.state, 'ok');
    const content = readFileSync(agentFile(p, 'developer'), 'utf8');
    assert.equal(readFrontmatter(content).description, 'Implements: carefully, in its worktree');
    assert.equal(readFrontmatter(content).model, 'opus');
    assert.match(content, /- `src\/\*\*`/);

    const edited = `${content}\nAlways run the tests.\n`;
    writeFileSync(agentFile(p, 'developer'), edited);
    const after = await core.team.putMember(p.id, 'developer', { role: 'developer', model: 'sonnet', responsibility: 'Implements: carefully, in its worktree' });
    assert.equal(readFileSync(agentFile(p, 'developer'), 'utf8'), edited);
    assert.equal(after.file.state, 'drifted');
    assert.deepEqual(after.file.drift, ['model']);
  });
});

test('a deleted file shows as missing, and createFile writes it again', async () => {
  await withCore(async (core) => {
    const p = await project(core);
    const created = await core.team.putMember(p.id, 'reviewer', { role: 'reviewer', model: 'sonnet', responsibility: 'Reviews' });
    assert.equal(created.file.state, 'missing');
    assert.equal(created.file.path, '.claude/agents/reviewer.md');

    const events = await feed(core, () => core.team.putMember(p.id, 'reviewer', { role: 'reviewer', model: 'sonnet', responsibility: 'Reviews', createFile: true }));
    assert.equal(existsSync(agentFile(p, 'reviewer')), true);
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'team.changed' ? [[e.action, e.agents]] : [])),
      [['updated', ['reviewer']]],
    );

    rmSync(agentFile(p, 'reviewer'));
    const gone = (await core.team.team(p.id)).members[0];
    assert.equal(gone?.file.state, 'missing');
    assert.equal(gone?.file.updatedAt, null);
    const back = await core.team.putMember(p.id, 'reviewer', { role: 'reviewer', model: 'sonnet', responsibility: 'Reviews', createFile: true });
    assert.equal(back.file.state, 'ok');
  });
});

test('two members may not share a role, and bad metadata is refused', async () => {
  await withCore(async (core) => {
    const p = await project(core);
    await core.team.putMember(p.id, 'dev-a', { role: 'developer', model: 'sonnet', responsibility: 'Builds' });
    await rejects(core.team.putMember(p.id, 'dev-b', { role: 'developer', model: 'sonnet', responsibility: 'Builds' }), 409, /already dev-a's/);
    await rejects(core.team.putMember(p.id, '../evil', { role: 'x', model: 'sonnet', responsibility: 'y' }), 400, /agent file name/);
    await rejects(core.team.putMember(p.id, 'ok', { role: '', model: 'sonnet', responsibility: 'y' }), 400, /role/);
    await rejects(core.team.putMember(p.id, 'ok', { role: 'x', model: 'sonnet', responsibility: 'y', writes: 'src' }), 400, /writes/);
    // The settings check the paths: nothing may climb out of the project
    await assert.rejects(core.team.putMember(p.id, 'ok', { role: 'x', model: 'sonnet', responsibility: 'y', writes: ['../outside'] }), /inside the project/);
    assert.deepEqual((await core.team.team(p.id)).members.map((m) => m.agent), ['dev-a']);
  });
});

test('taking a member off the team keeps its agent file', async () => {
  await withCore(async (core) => {
    const p = await project(core);
    await core.team.fromTemplate(p.id, { roles: ['qa', 'developer'] });
    const events = await feed(core, () => core.team.removeMember(p.id, 'qa'));
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'team.changed' ? [[e.action, e.agents]] : [])),
      [['removed', ['qa']]],
    );
    const team = await core.team.team(p.id);
    assert.deepEqual(team.members.map((m) => m.agent), ['developer']);
    assert.deepEqual(team.unassignedAgents, ['qa']);
    assert.equal(existsSync(agentFile(p, 'qa')), true);
    await rejects(core.team.removeMember(p.id, 'qa'), 404, /not found/);
  });
});

test('with the Team module off the team is readable, unchangeable, and nothing on disk goes', async () => {
  await withCore(async (core) => {
    const p = await project(core);
    await core.team.fromTemplate(p.id, {});
    await core.updateProject(p.id, { modules: ['board'] });
    const team = await core.team.team(p.id);
    assert.equal(team.enabled, false);
    assert.equal(team.members.length, 4);
    assert.equal(existsSync(agentFile(p, 'developer')), true);
    await rejects(core.team.fromTemplate(p.id, {}), 409, /Team module is off/);
    await rejects(core.team.putMember(p.id, 'x', { role: 'x', model: 'sonnet', responsibility: 'y' }), 409, /Team module is off/);
    await rejects(core.team.removeMember(p.id, 'developer'), 409, /Team module is off/);

    await core.updateProject(p.id, { modules: ['board', 'team'] });
    assert.deepEqual((await core.team.team(p.id)).members.map((m) => m.file.state), ['ok', 'ok', 'ok', 'ok']);
  });
});

test('a project with no template, or one without a team, is offered the full team', async () => {
  await withCore(async (core) => {
    const p = await project(core, null, ['team']);
    const team = await core.team.fromTemplate(p.id, {});
    assert.deepEqual(team.members.map((m) => m.role), ['product-owner', 'architect', 'developer', 'qa']);
  });
  const settings = (template: ProjectTemplateId): ProjectSettings => ({ modules: [], template, keyPrefix: 'R', board: { types: ['task'], columnLimits: {} } });
  assert.deepEqual(templateTeam(settings('research')).map((r) => r.role), ['researcher', 'writer', 'reviewer']);
  assert.equal(templateTeam(settings('simple')).length, 4);
});

test("a member's flow runs come from the flow: running, queued and the last one that ended", async () => {
  await withCore(async (core) => {
    const p = await project(core);
    await core.team.fromTemplate(p.id, { roles: ['developer', 'qa'] });
    const run = (over: Partial<FlowRun>): FlowRun => ({
      id: 'r',
      projectId: p.id,
      itemId: 'i',
      item: null,
      role: 'developer',
      agent: 'developer',
      model: 'sonnet',
      stage: 'work',
      column: 'in_progress',
      state: 'ended',
      chatId: null,
      outcome: null,
      summary: null,
      error: null,
      restarts: 0,
      queuedAt: '2026-09-27T10:00:00Z',
      startedAt: null,
      endedAt: null,
      ...over,
    });
    core.team.runs = (id) =>
      id === p.id
        ? [
            run({ id: 'old', endedAt: '2026-09-27T10:00:00Z', outcome: 'passed' }),
            run({ id: 'new', endedAt: '2026-09-27T11:00:00Z', outcome: 'failed' }),
            run({ id: 'b', state: 'running', startedAt: '2026-09-27T12:30:00Z' }),
            run({ id: 'a', state: 'running', startedAt: '2026-09-27T12:00:00Z' }),
            run({ id: 'q', state: 'queued' }),
          ]
        : [];
    const team = await core.team.team(p.id);
    const developer = team.members.find((m) => m.agent === 'developer');
    assert.deepEqual(developer?.running.map((r) => r.id), ['a', 'b']);
    assert.equal(developer?.queued, 1);
    assert.equal(developer?.lastRun?.id, 'new');
    const qa = team.members.find((m) => m.agent === 'qa');
    assert.deepEqual([qa?.running, qa?.queued, qa?.lastRun], [[], 0, null]);
  });
});

test('the starting file quotes what YAML would misread, and reads back the same', () => {
  const content = agentFileContent({ agent: 'po', role: 'product-owner', model: 'opus', responsibility: 'Refines: the "backlog" # first' });
  assert.deepEqual(readFrontmatter(content), { name: 'po', description: 'Refines: the "backlog" # first', model: 'opus' });
  assert.match(content, /You are the Product Owner/);
  assert.match(content, /Agentry sets no limit of its own/);
  assert.deepEqual(readFrontmatter("---\ndescription: 'it''s mine'\n---\n"), { description: "it's mine" });
  assert.deepEqual(readFrontmatter('no frontmatter'), {});
});

test('a member that writes nothing is told so, not told it has no limit; one with no writes has none', () => {
  const nothing = agentFileContent({ agent: 'po', role: 'product-owner', model: 'opus', responsibility: 'Refines', writes: [] });
  assert.match(nothing, /You write none of the project's files: only documents in the documents folder/);
  assert.doesNotMatch(nothing, /no limit/);
  const free = agentFileContent({ agent: 'dev', role: 'developer', model: 'sonnet', responsibility: 'Implements' });
  assert.match(free, /Agentry sets no limit of its own/);
  const some = agentFileContent({ agent: 'qa', role: 'qa', model: 'sonnet', responsibility: 'Verifies', writes: ['docs/reports'] });
  assert.match(some, /You may write only these paths, relative to the project, and the documents folder:\n\n- `docs\/reports`/);
  assert.match(some, /`criteria`: when you verify the item/);
});

test("a member's shell commands are kept, checked and told to its agent file; null or none leaves the shell free", async () => {
  await withCore(async (core) => {
    const p = await project(core);
    await core.team.fromTemplate(p.id, { roles: ['developer'] });
    // The template's Developer gets no list: the owner's shell stays unlimited unless they choose
    assert.equal((await core.projectSettings(p.id)).team?.members[0]?.commands, undefined);
    const base = { role: 'developer', model: 'sonnet', responsibility: 'Implements' };
    const listed = await core.team.putMember(p.id, 'developer', { ...base, commands: ['pnpm test', 'pnpm *', 'pnpm test'] });
    assert.deepEqual(listed.commands, ['pnpm test', 'pnpm *']);
    assert.deepEqual((await core.projectSettings(p.id)).team?.members[0]?.commands, ['pnpm test', 'pnpm *']);
    // Agentry's own file follows, and says what the shell may run
    assert.match(readFileSync(agentFile(p, 'developer'), 'utf8'), /## What you may run[^]*- `pnpm test`\n- `pnpm \*`/);

    const none = await core.team.putMember(p.id, 'developer', { ...base, commands: [] });
    assert.deepEqual(none.commands, []);
    assert.match(readFileSync(agentFile(p, 'developer'), 'utf8'), /you have no shell/);
    const free = await core.team.putMember(p.id, 'developer', { ...base, commands: null });
    assert.equal(free.commands, undefined);
    assert.doesNotMatch(readFileSync(agentFile(p, 'developer'), 'utf8'), /What you may run/);

    for (const commands of ['pnpm test', ['*'], ['rm -rf (x)'], ['a\nb'], ['npm run a,b'], [1], Array.from({ length: 51 }, (_, i) => `cmd${i}`)]) {
      await rejects(core.team.putMember(p.id, 'developer', { ...base, commands }), 400, /command/);
    }
    await rejects(core.team.putMember(p.id, 'developer', { ...base, commands: ['npm run a,b'] }), 400, /cannot contain a comma/);
  });
});

test('a list field of an agent file reads in every form the CLI takes', () => {
  const file = (fields: string) => `---\nname: qa\n${fields}\n---\nBody\n`;
  assert.deepEqual(readFrontmatterList(file('tools: Read, Grep'), 'tools'), ['Read', 'Grep']);
  assert.deepEqual(readFrontmatterList(file('tools: [Read, "Grep"]'), 'tools'), ['Read', 'Grep']);
  assert.deepEqual(readFrontmatterList(file('tools:\n  - Read\n  - Grep\nmodel: opus'), 'tools'), ['Read', 'Grep']);
  assert.deepEqual(readFrontmatterList(file('disallowedTools:\n  - WebFetch'), 'disallowedTools'), ['WebFetch']);
  assert.equal(readFrontmatterList(file('model: opus'), 'tools'), null);
  assert.equal(readFrontmatterList('no frontmatter', 'tools'), null);
});
