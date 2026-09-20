import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// Isolated dirs and a missing CLI binary: these tests cover routing, scoping, validation and
// error mapping without ever spawning Claude or touching the real ~/.claude.
let app: FastifyInstance;
let core: Core;
let projectId: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-'));
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
  const res = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'demo' }) });
  assert.equal(res.statusCode, 201);
  projectId = res.json().id;
});

after(() => app.close());

test('every API route is documented in the OpenAPI document', async () => {
  const spec = (await app.inject('/openapi.json')).json();
  assert.equal(spec.openapi, '3.1.0');
  const undocumented: string[] = [];
  let operations = 0;
  for (const [path, methods] of Object.entries(spec.paths as Record<string, Record<string, { summary?: string; tags?: string[] }>>)) {
    for (const [method, operation] of Object.entries(methods)) {
      operations++;
      if (!operation.summary || !operation.tags?.length) undocumented.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(undocumented, []);
  assert.ok(operations >= 55, `only ${operations} operations documented`);
  // $refs used by routes must exist as components
  const refs = [...JSON.stringify(spec.paths).matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1] as string);
  const missing = [...new Set(refs)].filter((name) => !(name in spec.components.schemas));
  assert.deepEqual(missing, []);
  assert.equal(spec.paths['/api/chats'].post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/NewChatRequest');

  let docs = await app.inject('/docs');
  if (docs.statusCode === 301 || docs.statusCode === 302) docs = await app.inject(docs.headers.location as string);
  assert.equal(docs.statusCode, 200);
  assert.match(docs.headers['content-type'] as string, /text\/html/);
});

test('reports a missing CLI instead of failing', async () => {
  const health = (await app.inject('/api/health')).json();
  assert.deepEqual(health, { ok: false, cli: false, loggedIn: false });
  const system = (await app.inject('/api/system')).json();
  assert.equal(system.cli.installed, false);
  assert.equal(system.auth.tokenSource, 'none');
});

test('settings are scoped per user / project / variant', async () => {
  let res = await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: { model: 'sonnet' } }) });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'PUT', url: `/api/config/settings?project=${projectId}&variant=local`, ...json({ settings: { env: { A: '1' } } }) });
  assert.match(res.json().path, /demo\/\.claude\/settings\.local\.json$/);

  assert.deepEqual((await app.inject('/api/config/settings')).json().settings, { model: 'sonnet' });
  assert.deepEqual((await app.inject(`/api/config/settings?project=${projectId}`)).json(), {
    path: (await app.inject(`/api/config/settings?project=${projectId}`)).json().path,
    exists: false,
    settings: {},
  });
  assert.equal((await app.inject('/api/config/settings?variant=local')).statusCode, 400);
  assert.equal((await app.inject('/api/config/settings?project=ghost')).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: [] }) })).statusCode, 400);
});

test('resources, memory and the file explorer validate their input', async () => {
  let res = await app.inject({ method: 'PUT', url: `/api/config/resources/rules/style?project=${projectId}`, ...json({ content: 'Use tabs.' }) });
  assert.equal(res.statusCode, 200);
  assert.equal((await app.inject(`/api/config/resources/rules?project=${projectId}`)).json().length, 1);
  assert.equal((await app.inject('/api/config/resources/rules')).json().length, 0); // user scope untouched
  assert.equal((await app.inject('/api/config/resources/widgets')).statusCode, 400);

  // A saved workflow is a script, and says so
  res = await app.inject({ method: 'PUT', url: `/api/config/resources/workflows/audit?project=${projectId}`, ...json({ content: "export const meta = { name: 'audit', description: 'Audit' }\n" }) });
  assert.equal(res.json().format, 'javascript');
  assert.equal((await app.inject(`/api/config/resources/workflows/audit?project=${projectId}`)).json().description, 'Audit');
  assert.equal((await app.inject(`/api/config/resources/rules/style?project=${projectId}`)).json().format, 'markdown');

  res = await app.inject({ method: 'PUT', url: `/api/memory/${projectId}/fact.md`, ...json({ content: '---\ndescription: d\n---\nx' }) });
  assert.equal(res.json().description, 'd');
  assert.equal((await app.inject(`/api/memory/${projectId}`)).json().length, 1);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/memory/${projectId}/nope.txt`, ...json({ content: 'x' }) })).statusCode, 400);
  assert.equal((await app.inject('/api/memory/ghost')).statusCode, 404);

  res = await app.inject({ method: 'PUT', url: '/api/config/files/content', ...json({ root: 'user', path: 'hooks/a.sh', content: 'exit 0', executable: true }) });
  assert.equal(res.json().executable, true);
  assert.deepEqual((await app.inject('/api/config/files/tree?root=user')).json().map((n: { name: string }) => n.name).sort(), ['hooks', 'settings.json']);
  for (const path of ['../x', '/etc/passwd', '.credentials.json', '.claude.json']) {
    assert.equal((await app.inject(`/api/config/files/content?root=user&path=${encodeURIComponent(path)}`)).statusCode, 400, path);
  }
  assert.equal((await app.inject('/api/config/files/content?root=user&path=missing.md')).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/config/files/content?root=user&path=hooks' })).statusCode, 200);
});

test('accounts degrade and validate without claude-swap', async () => {
  const overview = (await app.inject('/api/accounts')).json();
  assert.equal(overview.cswap.installed, false);
  assert.deepEqual(overview.accounts, []);
  assert.equal(overview.activeNumber, null);
  assert.equal(overview.autoSwitchRunning, false);

  // Identifiers and settings are rejected before anything is spawned
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/switch', ...json({ target: '--help' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/accounts/-x' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/1/alias', ...json({ alias: '--unset' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ token: '' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/autoswitch', ...json({ threshold: 1 }) })).statusCode, 400);

  const saved = (await app.inject({ method: 'PUT', url: '/api/accounts/autoswitch', ...json({ threshold: 80, intervalSec: 30 }) })).json();
  assert.equal(saved.threshold, 80);
  assert.equal((await app.inject('/api/accounts/autoswitch')).json().intervalSec, 30);
});

test('resuming an orchestration that does not exist is a 404, not a hang', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/nope/resume' })).statusCode, 404);
});

test('re-running and relaunching what does not exist are 404s', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/nope/tasks/a/rerun' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/nope/relaunch', ...json({}) })).statusCode, 404);
});

test('verification is refused where it could not run, and checking what does not exist is a 404', async () => {
  const graph = { name: 'checked', cwd: tmpdir(), tasks: [{ id: 'a', name: 'a', prompt: 'do it' }] };
  const shared = await app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ ...graph, verification: { commands: ['true'], fixer: false, maxAttempts: 1 } }) });
  assert.equal(shared.statusCode, 400);
  assert.match(shared.json().error, /worktree per task/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/nope/verify', ...json({}) })).statusCode, 404);
});

test('orchestration templates are saved, listed, edited, launched and deleted over the API', async () => {
  const graph = { name: 'review', objective: 'old', cwd: join(tmpdir()), tasks: [{ id: 'a', name: 'a', prompt: 'do it' }] };
  assert.deepEqual((await app.inject('/api/orchestrations/templates')).json(), []);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/templates', ...json({ name: 'x' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/templates', ...json({ name: 'bad', spec: { ...graph, tasks: [] } }) })).statusCode, 400);

  const created = await app.inject({ method: 'POST', url: '/api/orchestrations/templates', ...json({ name: 'Review', spec: graph }) });
  assert.equal(created.statusCode, 201);
  const template = created.json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/templates', ...json({ name: 'review', spec: graph }) })).statusCode, 400);
  assert.equal((await app.inject(`/api/orchestrations/templates/${template.id}`)).json().name, 'Review');
  assert.equal((await app.inject('/api/orchestrations/templates/nope')).statusCode, 404);

  const renamed = await app.inject({ method: 'PATCH', url: `/api/orchestrations/templates/${template.id}`, ...json({ name: 'Review v2' }) });
  assert.equal(renamed.json().name, 'Review v2');
  assert.equal((await app.inject('/api/orchestrations/templates')).json().length, 1);

  const launched = await app.inject({ method: 'POST', url: `/api/orchestrations/templates/${template.id}/launch`, ...json({ objective: 'new' }) });
  assert.equal(launched.statusCode, 201);
  assert.equal(launched.json().objective, 'new');
  assert.equal(launched.json().templateId, template.id);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/templates/nope/launch', ...json({}) })).statusCode, 404);
  core.orchestrator.stop(launched.json().id);

  assert.deepEqual((await app.inject({ method: 'DELETE', url: `/api/orchestrations/templates/${template.id}` })).json(), { ok: true });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/orchestrations/templates/${template.id}` })).statusCode, 404);
});

test('planner drafts are listed and fetched by run', async () => {
  assert.deepEqual((await app.inject('/api/orchestrations/plans')).json(), []);
  // No such planner run: a clear 4xx rather than a hang
  assert.equal((await app.inject('/api/orchestrations/plans/nope')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/plan/start', ...json({}) })).statusCode, 400);
});

test('chats, orchestrations and plugins reject bad requests', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: '  ' }) })).statusCode, 400);
  assert.equal((await app.inject('/api/chats/ghost')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/ghost/messages', ...json({ text: 'hi' }) })).statusCode, 404);
  assert.deepEqual((await app.inject('/api/workflows')).json(), []);
  assert.deepEqual((await app.inject('/api/workflows/saved')).json(), []);
  const unknownWorkflow = await app.inject({ method: 'POST', url: '/api/workflows/saved/run', ...json({ name: 'nope' }) });
  assert.equal(unknownWorkflow.statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/workflows/saved/run', ...json({}) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/ghost/interrupt' })).statusCode, 404);
  // Continuing a chat that does not exist, in place or in a copy, is a 404 and starts nothing
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/ghost/resume', ...json({ prompt: 'hi' }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/ghost/fork', ...json({ prompt: 'hi' }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/chats/ghost' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/chats/ghost', ...json({ model: 'opus' }) })).statusCode, 404);
  const badMode = await app.inject({ method: 'PATCH', url: '/api/chats/ghost', ...json({ permissionMode: 'yolo' }) });
  assert.equal(badMode.statusCode, 400);
  assert.match(badMode.json().error, /permissionMode must be one of/);
  const badRules = await app.inject({ method: 'POST', url: '/api/chats/ghost/permissions/p1', ...json({ behavior: 'allow', updatedPermissions: 'all' }) });
  assert.equal(badRules.statusCode, 400);
  const cycle = { name: 'x', tasks: [{ id: 'a', name: 'a', prompt: 'p', dependsOn: ['b'] }, { id: 'b', name: 'b', prompt: 'p', dependsOn: ['a'] }] };
  assert.match((await app.inject({ method: 'POST', url: '/api/orchestrations', ...json(cycle) })).json().error, /cycle/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plugins/install', ...json({ plugin: '--help' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/config/mcp/--scope', ...json({ config: { command: 'x' } }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/auth/credentials', ...json({}) })).statusCode, 400);
  assert.equal((await app.inject('/api/nope')).statusCode, 404);
});

test('a file uploads as the raw body and comes back with its type read from the bytes', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const upload = (name: string, body: Buffer) =>
    app.inject({ method: 'POST', url: `/api/uploads?name=${encodeURIComponent(name)}`, payload: body, headers: { 'content-type': 'application/octet-stream' } });

  // Named .txt, but the bytes are a PNG: the bytes win, or Claude would reject the image block
  const res = await upload('../../etc/shot.txt', png);
  assert.equal(res.statusCode, 201);
  const attachment = res.json();
  assert.equal(attachment.mediaType, 'image/png');
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.name, 'shot.txt'); // no directories survive
  assert.equal((await app.inject(`/api/uploads/${attachment.id}`)).json().sizeBytes, png.length);

  const content = await app.inject(`/api/uploads/${attachment.id}/content`);
  assert.equal(content.headers['content-type'], 'image/png');
  assert.match(String(content.headers['content-disposition']), /^inline/);
  assert.deepEqual(content.rawPayload, png);

  // Markup is downloaded, never rendered on the API's origin
  const html = (await upload('page.html', Buffer.from('<script>alert(1)</script>'))).json();
  const served = await app.inject(`/api/uploads/${html.id}/content`);
  assert.equal(served.headers['content-type'], 'application/octet-stream');
  assert.match(String(served.headers['content-disposition']), /^attachment/);

  assert.equal((await upload('empty.bin', Buffer.alloc(0))).statusCode, 400);
  assert.equal((await app.inject('/api/uploads/not-an-id')).statusCode, 404);
  // An image over the 5 MB a content block allows is refused up front, not by the model
  const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
  assert.match((await upload('big.png', big)).json().error, /at most 5 MB/);
});

test('chats are listed with filters that say when they are wrong, and the run, session and active routes are gone', async () => {
  assert.deepEqual((await app.inject('/api/chats')).json(), []);
  assert.equal((await app.inject('/api/chats?state=asleep')).statusCode, 400);
  assert.match((await app.inject('/api/chats?origin=robot')).json().error, /origin must be one of/);
  assert.equal((await app.inject('/api/chats?origin=agentry,external,orchestration,internal&loose=1&limit=5')).statusCode, 200);
  for (const url of ['/api/runs', '/api/runs/ghost', '/api/sessions', '/api/sessions/ghost', '/api/active', '/api/projects/x/sessions']) {
    assert.equal((await app.inject(url)).statusCode, 404, url);
  }
});

test('usage is reported over a range of days and refuses a malformed one', async () => {
  const report = (await app.inject('/api/usage?from=2026-03-01&to=2026-03-31')).json();
  assert.deepEqual([report.from, report.to], ['2026-03-01', '2026-03-31']);
  assert.equal(report.total.costUsd, null, 'nothing was spent, so there is no cost to show');
  assert.deepEqual([report.days, report.projects, report.orchestrations], [[], [], []]);
  assert.match((await app.inject('/api/usage?from=yesterday')).json().error, /YYYY-MM-DD/);
});

test('usage is served as a series and a breakdown over a range, and a bad bucket, day or range is a 400', async () => {
  const series = (await app.inject('/api/usage/series?bucket=week&from=2026-03-09&to=2026-03-22')).json();
  assert.equal(series.bucket, 'week');
  assert.deepEqual(series.points.map((p: { at: string }) => p.at), ['2026-03-09', '2026-03-16'], 'a point per week, empty ones included');
  assert.equal(series.points[0].costUsd, null);
  assert.equal((await app.inject('/api/usage/series?from=2026-03-09&to=2026-03-10')).json().bucket, 'day', 'days by default');

  const breakdown = (await app.inject('/api/usage/breakdown?from=2026-03-01&to=2026-03-31')).json();
  assert.deepEqual([breakdown.byProject, breakdown.byModel], [[], []]);

  assert.match((await app.inject('/api/usage/series?bucket=month')).json().error, /day or week/);
  assert.equal((await app.inject('/api/usage/series?from=2020-01-01&to=2026-01-01')).statusCode, 400);
  assert.match((await app.inject('/api/usage/breakdown?to=soon')).json().error, /YYYY-MM-DD/);
  assert.match((await app.inject('/api/usage/breakdown?from=2026-03-31&to=2026-03-01')).json().error, /must not be after/);
});

test('a chat is exported as Markdown or JSON, as a download, and an unknown one or format is refused', async () => {
  const cwd = join(core.config.workspaceDir, 'exported');
  const dir = join(core.config.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const message = (uuid: string, role: 'user' | 'assistant', content: unknown) => JSON.stringify({ type: role, uuid, timestamp: '2026-03-10T10:00:00Z', cwd, sessionId: 'export-1', isSidechain: false, message: { role, content } });
  writeFileSync(join(dir, 'export-1.jsonl'), `${message('u1', 'user', 'What is 2+2?')}\n${message('a1', 'assistant', [{ type: 'text', text: 'Four.' }])}\n`);

  const md = await app.inject('/api/chats/export-1/export');
  assert.equal(md.statusCode, 200);
  assert.match(md.headers['content-type'] as string, /^text\/markdown/);
  assert.match(md.headers['content-disposition'] as string, /^attachment; filename="[\w-]+\.md"$/);
  assert.match(md.body, /## User/);
  assert.match(md.body, /What is 2\+2\?/);
  assert.match(md.body, /Four\./);

  const exported = await app.inject('/api/chats/export-1/export?format=json');
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers['content-disposition'] as string, /\.json"$/);
  const body = exported.json();
  assert.equal(body.chat.id, 'export-1');
  assert.deepEqual(body.entries.map((e: { uuid: string; role: string }) => [e.uuid, e.role]), [['u1', 'user'], ['a1', 'assistant']]);

  assert.equal((await app.inject('/api/chats/nope/export')).statusCode, 404);
  assert.match((await app.inject('/api/chats/export-1/export?format=pdf')).json().error, /markdown or json/);
});

test('a message may carry attachments, and an unknown one fails the request', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', attachments: ['00000000-0000-0000-0000-000000000000'] }) });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /upload not found/);
});

// ---------- the global event feed ----------

/** Inject cannot follow a stream that never ends, so these talk to a real listening socket. */
async function openFeed(headers: Record<string, string> = {}) {
  const { port } = app.server.address() as AddressInfo;
  let text = '';
  let contentType = '';
  const waiters: Array<() => void> = [];
  const req = request({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
    contentType = String(res.headers['content-type']);
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      text += chunk;
      for (const wake of waiters.splice(0)) wake();
    });
  });
  req.end();
  const until = async (pattern: RegExp) => {
    const deadline = Date.now() + 3000;
    while (!pattern.test(text)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; got:\n${text}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return { until, text: () => text, contentType: () => contentType, close: () => req.destroy() };
}

const ping = (title: string) => core.events.emit({ type: 'sessions.changed', title });

test('the event feed streams what happens, replays what a reconnecting client missed, and cleans up', async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const idle = core.events.subscribers;

  const first = await openFeed();
  await first.until(/event: stream\.hello\ndata: .*"bootId":"/);
  assert.match(first.contentType(), /text\/event-stream/);
  assert.equal(core.events.subscribers, idle + 1);

  const seen = ping('live');
  await first.until(new RegExp(`id: ${seen.id}\nevent: sessions\\.changed\ndata: .*"title":"live"`));
  first.close();
  // The subscription must go with the connection, or every closed tab leaks a listener
  for (let i = 0; i < 50 && core.events.subscribers > idle; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(core.events.subscribers, idle);

  const missed = [ping('missed 1'), ping('missed 2')];
  const again = await openFeed({ 'last-event-id': String(seen.id) });
  await again.until(/missed 2/);
  assert.ok(!again.text().includes('"title":"live"'), 'what the client already had is not sent again');
  const order = missed.map((e) => again.text().indexOf(`id: ${e.id}\n`));
  assert.ok(order[0] !== undefined && order[0] > again.text().indexOf('stream.hello') && order[0] < (order[1] ?? -1), 'hello first, then the missed events in order');
  again.close();

  // An id from a server that no longer exists cannot be continued from
  const stale = await openFeed({ 'last-event-id': '999999' });
  await stale.until(/event: stream\.resync\ndata: .*"reason":"server-restarted"/);
  stale.close();
});

test('projects are imported by hand, renamed and removed without touching anything else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-api-import-'));

  const listed = (await app.inject('/api/projects')).json();
  assert.deepEqual(listed.map((p: { id: string }) => p.id), [projectId]);
  assert.deepEqual((await app.inject('/api/projects/candidates')).json(), []);

  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name: 'Imported' }) });
  assert.equal(imported.statusCode, 201);
  const { id } = imported.json();
  assert.equal(imported.json().name, 'Imported');
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: join(dir, 'missing') }) })).statusCode, 400);

  const renamed = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, ...json({ name: 'Shop' }) });
  assert.equal(renamed.json().name, 'Shop');
  assert.equal((await app.inject('/api/chats?loose=1')).statusCode, 200);
  assert.deepEqual((await app.inject(`/api/chats?project=${id}`)).json(), []);

  assert.deepEqual((await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })).json(), { ok: true });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${id}/state` })).statusCode, 404);
});
