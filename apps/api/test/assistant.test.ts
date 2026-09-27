import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AssistantProposal, AssistantRun, AssistantRunDetail, Project, Team } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// The assistant's routes over a real core with scratch dirs and a missing CLI. A project with
// nothing to read starts no chat, which is what lets these run without Claude: its run completes at
// once with the template's team, and every decision route works on those proposals.
let app: FastifyInstance;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function importEmpty(modules: string[]): Promise<Project> {
  const path = mkdtempSync(join(tmpdir(), 'agentry-api-assistant-'));
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path, name: 'Notas', template: 'software', modules }) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<Project>();
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-assistant-root-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(() => app.close());

test('an empty project is offered its template team, and each member is accepted or discarded on its own', async () => {
  const p = await importEmpty(['board', 'team']);
  const started = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/assistant/runs`, ...json({ kind: 'project' }) });
  assert.equal(started.statusCode, 201, started.body);
  const run = started.json<AssistantRunDetail>();
  assert.deepEqual([run.status, run.empty, run.chatId, run.template, run.model], ['completed', true, null, 'software', 'sonnet']);
  assert.deepEqual(run.proposals.map((x) => (x.kind === 'team-member' ? x.member.role : x.kind)), ['product-owner', 'architect', 'developer', 'qa']);

  const listed = await app.inject(`/api/projects/${p.id}/assistant/runs?kind=project`);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json<AssistantRun[]>().map((r) => [r.id, r.counts['team-member'].pending]), [[run.id, 4]]);
  assert.deepEqual((await app.inject(`/api/projects/${p.id}/assistant/runs?kind=resources`)).json(), []);

  const [po, architect] = run.proposals;
  assert.ok(po && architect);
  const accepted = await app.inject({ method: 'POST', url: `/api/assistant/proposals/${po.id}/accept`, ...json({ member: { model: 'sonnet' } }) });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json<AssistantProposal>().status, 'accepted');
  const team = (await app.inject(`/api/projects/${p.id}/team`)).json<Team>();
  assert.deepEqual(team.members.map((m) => [m.agent, m.model, m.file.state]), [['product-owner', 'sonnet', 'ok']]);
  assert.match(readFileSync(join(p.path, '.claude', 'agents', 'product-owner.md'), 'utf8'), /name: product-owner/);
  const again = await app.inject({ method: 'POST', url: `/api/assistant/proposals/${po.id}/accept` });
  assert.equal(again.statusCode, 409);

  const discarded = await app.inject({ method: 'POST', url: `/api/assistant/proposals/${architect.id}/discard` });
  assert.equal(discarded.json<AssistantProposal>().status, 'discarded');
  assert.equal(existsSync(join(p.path, '.claude', 'agents', 'architect.md')), false);
  const restored = await app.inject({ method: 'POST', url: `/api/assistant/proposals/${architect.id}/restore` });
  assert.equal(restored.json<AssistantProposal>().status, 'pending');

  const detail = (await app.inject(`/api/assistant/runs/${run.id}`)).json<AssistantRunDetail>();
  assert.deepEqual(detail.counts['team-member'], { total: 4, pending: 3, accepted: 1, discarded: 0, superseded: 0 });
});

test('the routes answer 400, 404 and 409 where they should', async () => {
  const p = await importEmpty(['board']);
  const post = (url: string, body?: unknown) => app.inject({ method: 'POST', url, ...(body === undefined ? {} : json(body)) });
  assert.equal((await post(`/api/projects/${p.id}/assistant/runs`, { kind: 'everything' })).statusCode, 400);
  assert.equal((await post(`/api/projects/${p.id}/assistant/runs`, { kind: 'resources', description: 'x' })).statusCode, 400);
  assert.equal((await post('/api/projects/nope/assistant/runs', { kind: 'project' })).statusCode, 404);
  assert.equal((await app.inject('/api/projects/nope/assistant/runs')).statusCode, 404);
  assert.equal((await app.inject(`/api/projects/${p.id}/assistant/runs?kind=nope`)).statusCode, 400);
  assert.equal((await app.inject('/api/assistant/runs/nope')).statusCode, 404);
  assert.equal((await post('/api/assistant/runs/nope/stop')).statusCode, 404);
  assert.equal((await post('/api/assistant/proposals/nope/accept')).statusCode, 404);
  assert.equal((await post('/api/assistant/proposals/nope/discard')).statusCode, 404);
  assert.equal((await post('/api/assistant/proposals/nope/restore')).statusCode, 404);

  // Team off: the empty project's run proposes no member; a finished run cannot be stopped
  const run = (await post(`/api/projects/${p.id}/assistant/runs`, { kind: 'project' })).json<AssistantRunDetail>();
  assert.deepEqual([run.status, run.proposals.length, run.template], ['completed', 0, null]);
  assert.equal((await post(`/api/assistant/runs/${run.id}/stop`)).statusCode, 409);
  const board = await importEmpty([]);
  assert.equal((await post(`/api/projects/${board.id}/assistant/runs`, { kind: 'work-items' })).statusCode, 409);
});
