import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { Project, ProjectSettings, ProjectTrackerSettings, TrackerStatus, TrackersSettings, WorkItem } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The tracker routes over HTTP, on a real core with scratch dirs. The CLIs on this machine are
// whatever they are, so only what holds on any machine is asserted; the adapters, the import and
// the sync are covered in core against recorded output.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;

async function importProject(name: string, modules: string[] = ['board']): Promise<Project> {
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: mkdtempSync(join(root, 'p-')), name, modules }) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<Project>();
}

const githubTracker: ProjectTrackerSettings = { id: 'github-issues', scope: 'acme/widgets', query: 'is:open', statusMap: { done: 'completed' } };

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-trackers-'));
  core = new Core(
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

after(async () => {
  await app.close();
  core.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test('every tracker is listed, and Jira and YouTrack are unknown because nobody recorded them', async () => {
  const all = (await app.inject('/api/trackers')).json<TrackerStatus[]>();
  assert.deepEqual(all.map((s) => s.id), ['github-issues', 'gitlab-issues', 'jira', 'youtrack']);
  for (const id of ['jira', 'youtrack']) {
    const one = (await app.inject(`/api/trackers/${id}`)).json<TrackerStatus>();
    assert.equal(one.state, 'unknown');
    assert.equal(one.reason, 'not-recorded');
    assert.equal(one.binaryPath, null);
  }
  assert.equal((await app.inject('/api/trackers/github-issues')).json<TrackerStatus>().host, 'github');
  assert.equal((await app.inject('/api/trackers/nope')).statusCode, 404);
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/trackers/refresh' })).json<TrackerStatus[]>().map((s) => s.id), all.map((s) => s.id));
});

test('tracker settings read as the defaults, persist in trackers.json and refuse what they cannot hold', async () => {
  const defaults = (await app.inject('/api/trackers/settings')).json<TrackersSettings>();
  assert.ok(Object.values(defaults.trackers).every((t) => t.enabled && t.binaryPath === null));
  assert.equal(existsSync(join(root, 'data', 'trackers.json')), false);

  const saved = await app.inject({ method: 'PUT', url: '/api/trackers/settings', ...json({ trackers: { 'gitlab-issues': { enabled: false } } }) });
  assert.equal(saved.statusCode, 200);
  const body = saved.json<TrackersSettings>();
  assert.equal(body.trackers['gitlab-issues'].enabled, false);
  assert.equal(body.trackers['github-issues'].enabled, true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'trackers.json'), 'utf8')), body);
  // The detector reads what was just saved, not the defaults it was built with
  assert.equal((await app.inject('/api/trackers/gitlab-issues')).json<TrackerStatus>().state, 'unknown');

  const before = (await app.inject('/api/trackers/settings')).json();
  for (const bad of [{ trackers: { nope: { enabled: true } } }, { trackers: { jira: { binaryPath: 'acli' } } }, { trackers: { jira: { enabled: 'yes' } } }, []]) {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/trackers/settings', ...json(bad) })).statusCode, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await app.inject('/api/trackers/settings')).json(), before);
});

test("a project's tracker is chosen, kept beside the rest of its settings, validated and cleared", async () => {
  const project = await importProject('Tracked');
  assert.equal((await app.inject(`/api/projects/${project.id}/tracker`)).body, 'null');
  const settings = (await app.inject(`/api/projects/${project.id}/settings`)).json<ProjectSettings>();

  const put = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/tracker`, ...json(githubTracker) });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json(), githubTracker);
  assert.deepEqual((await app.inject(`/api/projects/${project.id}/tracker`)).json(), githubTracker);
  const after = (await app.inject(`/api/projects/${project.id}/settings`)).json<ProjectSettings>();
  assert.deepEqual(after, { ...settings, tracker: githubTracker });

  for (const bad of [{ ...githubTracker, id: 'nope' }, { ...githubTracker, scope: 'not a repo' }, { ...githubTracker, statusMap: { backlog: 'x' } }]) {
    assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/tracker`, ...json(bad) })).statusCode, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await app.inject(`/api/projects/${project.id}/tracker`)).json(), githubTracker);

  const cleared = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/tracker`, headers: { 'content-type': 'application/json' }, payload: 'null' });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal((await app.inject(`/api/projects/${project.id}/tracker`)).body, 'null');
  assert.equal((await app.inject('/api/projects/nope/tracker')).statusCode, 404);
});

test('the tracker issues and the import are refused with a reason when they cannot go on', async () => {
  const project = await importProject('Imports');
  const issues = `/api/projects/${project.id}/tracker/issues`;
  const importUrl = `/api/projects/${project.id}/tracker/import`;

  // No tracker chosen
  assert.equal((await app.inject(issues)).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: importUrl, ...json({ keys: ['1'] }) })).statusCode, 409);

  // Jira has no recording: nothing is called, and the answer says why
  const jira = { id: 'jira', scope: 'PROJ', query: '', statusMap: {} };
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/tracker`, ...json(jira) })).statusCode, 200);
  const listed = await app.inject(issues);
  assert.equal(listed.statusCode, 409);
  assert.equal(listed.json<{ code: string }>().code, 'not-recorded');
  const imported = await app.inject({ method: 'POST', url: importUrl, ...json({ keys: ['PROJ-1'] }) });
  assert.equal(imported.statusCode, 409);
  assert.equal(imported.json<{ code: string }>().code, 'not-recorded');

  // The request itself is checked before the tracker is
  assert.equal((await app.inject(`${issues}?page=0`)).statusCode, 400);
  assert.equal((await app.inject(`${issues}?page=x`)).statusCode, 400);
  for (const bad of [{}, { keys: 'PROJ-1' }, { keys: [1] }]) {
    assert.equal((await app.inject({ method: 'POST', url: importUrl, ...json(bad) })).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await app.inject('/api/projects/nope/tracker/issues')).statusCode, 404);
});

test('an import needs the Board module, and reading the issues does not', async () => {
  const project = await importProject('NoBoard', []);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/tracker`, ...json(githubTracker) })).statusCode, 200);
  const imported = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tracker/import`, ...json({ keys: ['1'] }) });
  assert.equal(imported.statusCode, 409);
  assert.match(imported.json<{ error: string }>().error, /Board module/);
  // Past the module check: a plain directory is not a repository on a tracker's host, which is a 409 too, never a 500
  assert.equal((await app.inject(`/api/projects/${project.id}/tracker/issues`)).statusCode, 409);
});

test('linking, unlinking and syncing an issue are checked against the item and its tracker', async () => {
  const project = await importProject('Linked');
  const item = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Fix it' }) })).json<WorkItem>();
  const url = `/api/work-items/${item.id}/issues`;

  // No tracker on the project: the issue cannot be read, so nothing is linked
  assert.equal((await app.inject({ method: 'POST', url, ...json({ key: '12' }) })).statusCode, 409);
  for (const bad of [{}, { key: '' }, { key: 5 }]) {
    assert.equal((await app.inject({ method: 'POST', url, ...json(bad) })).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/work-items/nope/issues', ...json({ key: '12' }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `${url}/12` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `${url}/12/sync` })).statusCode, 404);

  core.workItems.linkIssue(item.id, { tracker: 'github-issues', key: '12', externalId: null, title: 'Crash', state: 'open', url: null });
  assert.equal((await app.inject(`/api/work-items/${item.id}`)).json<WorkItem>().issues?.length, 1);

  // The item is in Backlog and the project maps nothing: there is nothing to write, and it says so
  const sync = await app.inject({ method: 'POST', url: `${url}/12/sync` });
  assert.equal(sync.statusCode, 409);
  assert.equal(sync.json<{ code?: string }>().code, undefined);
  assert.equal((await app.inject({ method: 'DELETE', url: `${url}/12?tracker=gitlab-issues` })).statusCode, 404);

  const removed = await app.inject({ method: 'DELETE', url: `${url}/12` });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json<WorkItem>().issues ?? [], []);
});

test("a chat's token can read trackers and their issues but not import, link, sync or change anything", async () => {
  const project = await importProject('Guarded');
  const item = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Guard' }) })).json<WorkItem>();
  core.workItems.linkIssue(item.id, { tracker: 'github-issues', key: '7', externalId: null, title: 'Seven', state: 'open', url: null });
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token } = created.json<{ token: string }>();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  try {
    const chat = core.security.chatTokens.mint('chat-42');
    const fromChat = (method: string, url: string, body?: unknown) => ({
      method: method as 'GET',
      url,
      remoteAddress: '127.0.0.1',
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      headers: { host: '127.0.0.1:34331', authorization: `Bearer ${chat}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const settingsBefore = readFileSync(join(root, 'data', 'trackers.json'), 'utf8');
    for (const [method, url, body] of [
      ['PUT', '/api/trackers/settings', { trackers: { 'github-issues': { binaryPath: '/tmp/evil' } } }],
      ['POST', '/api/trackers/refresh', undefined],
      ['PUT', `/api/projects/${project.id}/tracker`, githubTracker],
      ['POST', `/api/projects/${project.id}/tracker/import`, { keys: ['1'] }],
      ['POST', `/api/work-items/${item.id}/issues`, { key: '12' }],
      ['DELETE', `/api/work-items/${item.id}/issues/7`, undefined],
      ['POST', `/api/work-items/${item.id}/issues/7/sync`, undefined],
    ] as const) {
      assert.equal((await app.inject(fromChat(method, url, body))).statusCode, 403, `${method} ${url}`);
    }
    assert.equal(readFileSync(join(root, 'data', 'trackers.json'), 'utf8'), settingsBefore);
    assert.equal(core.workItems.issuesOf(item.id).length, 1, 'the link survived');
    assert.equal((await app.inject(fromChat('GET', `/api/projects/${project.id}/tracker`))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/trackers'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/trackers/settings'))).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test('every tracker route is documented with a summary and a tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  const wanted = (path: string) => path.startsWith('/api/trackers') || path.includes('/tracker') || path.includes('/issues');
  const routes = Object.entries(spec.paths).filter(([path]) => wanted(path));
  assert.equal(routes.reduce((n, [, methods]) => n + Object.keys(methods).length, 0), 12);
  for (const [path, methods] of routes) {
    for (const [method, op] of Object.entries(methods)) {
      assert.ok(op.summary, `${method} ${path} has no summary`);
      assert.equal(op.tags?.length, 1, `${method} ${path}`);
    }
  }
});
