import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type {
  DecisionCredentialsResult,
  DecisionPage,
  DecisionPaletteResult,
  DecisionPointInfo,
  DecisionPreview,
  DecisionRecord,
  DecisionSettings,
  DecisionStats,
  DecisionTestResult,
} from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// The decision engine over HTTP. No provider is asked anything here: a point is off, or the Jev key
// is missing, and history rows are written as the engine would write them.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-decisions-'));
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
});

const row = (id: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  point: 'flow.bounce',
  kind: 'act',
  projectId: 'p1',
  subjectKind: 'flow_run',
  subjectId: 'run-1',
  provider: 'jev',
  model: 'jev-1.13.0',
  mode: 'shadow',
  status: 'answered',
  unavailable: null,
  state: { rejection: 'tests fail' },
  questions: [],
  answers: null,
  confidence: 0.9,
  threshold: 0.85,
  acted: false,
  visible: false,
  savedRun: false,
  latencyMs: 120,
  inputTokens: null,
  costUsd: 0.001,
  outcome: null,
  agreed: null,
  resolvedAt: null,
  feedback: null,
  feedbackAt: null,
  at: new Date().toISOString(),
  ...over,
});

const settingsBody = (settings: DecisionSettings, points: DecisionSettings['points']) => ({
  provider: settings.provider,
  cli: settings.cli,
  historyDays: settings.historyDays,
  points,
});

test('the settings are read, replaced whole and validated, and consent survives a replace', async () => {
  const before = (await app.inject('/api/decisions/settings')).json<DecisionSettings>();
  assert.equal(before.provider, 'cli');
  assert.equal(before.jev.keySet, false);

  const bad = await app.inject({ method: 'PUT', url: '/api/decisions/settings', ...json({ ...settingsBody(before, {}), historyDays: 0 }) });
  assert.equal(bad.statusCode, 400);

  const put = await app.inject({
    method: 'PUT',
    url: '/api/decisions/settings',
    ...json(settingsBody(before, { 'flow.bounce': { mode: 'shadow', threshold: 0.9, consent: null } })),
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json<DecisionSettings>().points['flow.bounce']?.mode, 'shadow');

  const consent = await app.inject({ method: 'PUT', url: '/api/decisions/points/flow.bounce/consent', ...json({ granted: true, stateVersion: 1, providers: ['jev'] }) });
  assert.equal(consent.statusCode, 200);
  assert.deepEqual(consent.json<DecisionSettings>().points['flow.bounce']?.consent?.providers, ['jev']);

  // A settings write cannot grant or drop consent
  const again = await app.inject({
    method: 'PUT',
    url: '/api/decisions/settings',
    ...json(settingsBody(before, { 'flow.bounce': { mode: 'active', threshold: 0.9, consent: null } })),
  });
  assert.equal(again.json<DecisionSettings>().points['flow.bounce']?.consent?.stateVersion, 1);

  const withdrawn = await app.inject({ method: 'PUT', url: '/api/decisions/points/flow.bounce/consent', ...json({ granted: false, stateVersion: 1, providers: [] }) });
  assert.equal(withdrawn.json<DecisionSettings>().points['flow.bounce']?.consent, null);
});

test('consent for a state that changed, or for an unknown point, is refused', async () => {
  const stale = await app.inject({ method: 'PUT', url: '/api/decisions/points/flow.bounce/consent', ...json({ granted: true, stateVersion: 99, providers: ['cli'] }) });
  assert.equal(stale.statusCode, 409);
  const unknown = await app.inject({ method: 'PUT', url: '/api/decisions/points/nope/consent', ...json({ granted: true, stateVersion: 1, providers: ['cli'] }) });
  assert.equal(unknown.statusCode, 404);
  const malformed = await app.inject({ method: 'PUT', url: '/api/decisions/points/flow.bounce/consent', ...json({ granted: 'yes' }) });
  assert.equal(malformed.statusCode, 400);
});

test('the Jev key is saved with the privacy notice, never returned, and removed', async () => {
  const saved = await app.inject({ method: 'PUT', url: '/api/decisions/credentials', ...json({ key: 'tsk_secret_value_1234' }) });
  assert.equal(saved.statusCode, 200);
  const body = saved.json<DecisionCredentialsResult>();
  assert.equal(body.keySet, true);
  assert.equal(body.keyHint, '1234');
  assert.ok(body.notice.length > 0);
  assert.ok(!saved.body.includes('tsk_secret_value'));
  const settings = await app.inject('/api/decisions/settings');
  assert.ok(!settings.body.includes('tsk_secret_value'));
  assert.equal(settings.json<DecisionSettings>().jev.keySet, true);
  assert.ok(readFileSync(join(root, 'data', 'decision-credentials.json'), 'utf8').includes('tsk_secret_value_1234'));

  const removed = await app.inject({ method: 'DELETE', url: '/api/decisions/credentials' });
  assert.equal(removed.json<DecisionCredentialsResult>().keySet, false);
});

test('testing Jev without a key says why, and a provider that is not one is refused', async () => {
  const result = (await app.inject({ method: 'POST', url: '/api/decisions/test', ...json({ provider: 'jev' }) })).json<DecisionTestResult>();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-key');
  assert.equal((await app.inject({ method: 'POST', url: '/api/decisions/test', ...json({ provider: 'gpt' }) })).statusCode, 400);
});

test('the catalogue lists every point with its effective settings, and a preview shows what a point may send', async () => {
  const points = (await app.inject('/api/decisions/points')).json<DecisionPointInfo[]>();
  assert.ok(points.length >= 20);
  assert.ok(points.every((p) => p.effective.provider === 'cli'));
  assert.ok(points.some((p) => p.id === 'palette.intent' && p.needsLowLatency));

  const preview = (await app.inject('/api/decisions/points/flow.bounce/preview')).json<DecisionPreview>();
  assert.equal(preview.source, 'built');
  assert.deepEqual(Object.keys(preview.state).sort(), ['bounces', 'criteria', 'rejection']);
  assert.equal((await app.inject('/api/decisions/points/nope/preview')).statusCode, 404);

  // Once a request went out, the preview is what it sent
  core.db.insertDecision(row('sent-1', { point: 'flow.refine-needed', state: { title: 'Add a search box' } }));
  const last = (await app.inject('/api/decisions/points/flow.refine-needed/preview')).json<DecisionPreview>();
  assert.equal(last.source, 'last');
  assert.deepEqual(last.state, { title: 'Add a search box' });
});

test('the history is filtered and paged, rated, and deleted one row or a filtered set at a time', async () => {
  core.db.clearDecisions({});
  const start = Date.parse('2026-09-01T00:00:00.000Z');
  for (let i = 0; i < 5; i++) {
    core.db.insertDecision(row(`h-${i}`, { at: new Date(start + i * 1000).toISOString(), provider: i < 3 ? 'jev' : 'cli', model: i < 3 ? 'jev-1.13.0' : 'haiku' }));
  }
  const all = (await app.inject('/api/decisions')).json<DecisionPage>();
  assert.deepEqual(all.items.map((r) => r.id), ['h-4', 'h-3', 'h-2', 'h-1', 'h-0']);

  const first = (await app.inject('/api/decisions?limit=2')).json<DecisionPage>();
  assert.deepEqual(first.items.map((r) => r.id), ['h-4', 'h-3']);
  assert.ok(first.nextCursor);
  const second = (await app.inject(`/api/decisions?limit=2&cursor=${first.nextCursor}`)).json<DecisionPage>();
  assert.deepEqual(second.items.map((r) => r.id), ['h-2', 'h-1']);

  const jev = (await app.inject('/api/decisions?provider=jev')).json<DecisionPage>();
  assert.equal(jev.items.length, 3);
  assert.equal((await app.inject('/api/decisions?provider=nope')).statusCode, 400);
  assert.equal((await app.inject('/api/decisions?limit=0')).statusCode, 400);

  assert.equal((await app.inject('/api/decisions/h-1')).json<DecisionRecord>().point, 'flow.bounce');
  assert.equal((await app.inject('/api/decisions/missing')).statusCode, 404);

  const rated = await app.inject({ method: 'POST', url: '/api/decisions/h-1/feedback', ...json({ feedback: 'useful' }) });
  assert.equal(rated.json<DecisionRecord>().feedback, 'useful');
  assert.equal((await app.inject({ method: 'POST', url: '/api/decisions/h-1/feedback', ...json({ feedback: 'meh' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/decisions/missing/feedback', ...json({ feedback: 'useful' }) })).statusCode, 404);

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/decisions/h-0' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/decisions/h-0' })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/decisions?provider=cli' })).json(), { deleted: 2 });
  assert.equal((await app.inject('/api/decisions')).json<DecisionPage>().items.length, 2);
});

test('the metrics count a window, and the window can be moved', async () => {
  core.db.clearDecisions({});
  core.db.insertDecision(row('s-1', { acted: true, savedRun: true, costUsd: 0.002 }));
  core.db.insertDecision(row('s-2', { at: '2020-01-01T00:00:00.000Z' }));
  const stats = (await app.inject('/api/decisions/stats')).json<DecisionStats>();
  assert.equal(stats.points.find((p) => p.point === 'flow.bounce')?.count, 1);
  assert.equal(stats.claudeRunsSaved, 1);
  const wider = (await app.inject('/api/decisions/stats?since=2019-01-01T00:00:00.000Z')).json<DecisionStats>();
  assert.equal(wider.points.find((p) => p.point === 'flow.bounce')?.count, 2);
  assert.equal((await app.inject('/api/decisions/stats?days=0')).statusCode, 400);
});

test('the palette answers no command while its point is off, and refuses a malformed request', async () => {
  const answer = (await app.inject({ method: 'POST', url: '/api/decisions/palette', ...json({ query: 'new chat', commands: [{ id: 'chat.new', title: 'New chat' }, { id: 'go.home', title: 'Home' }] }) })).json<DecisionPaletteResult>();
  assert.deepEqual(answer, { commandId: null, confidence: null, decisionId: null });
  assert.equal((await app.inject({ method: 'POST', url: '/api/decisions/palette', ...json({ query: '', commands: [] }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/decisions/palette', ...json({ query: 'x', commands: [{ id: 1 }] }) })).statusCode, 400);
});

test("a chat's token cannot change what the engine sends, but can read and rate", async () => {
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
    const settings = (await app.inject({ url: '/api/decisions/settings', headers: { authorization: `Bearer ${token}` } })).json<DecisionSettings>();
    const forbidden: Array<[string, string, unknown]> = [
      ['PUT', '/api/decisions/settings', settingsBody(settings, {})],
      ['PUT', '/api/decisions/credentials', { key: 'tsk_from_a_chat' }],
      ['DELETE', '/api/decisions/credentials', undefined],
      ['PUT', '/api/decisions/points/flow.bounce/consent', { granted: true, stateVersion: 1, providers: ['jev'] }],
    ];
    for (const [method, url, body] of forbidden) {
      const answer = await app.inject(fromChat(method, url, body));
      assert.equal(answer.statusCode, 403, `${method} ${url}`);
      assert.match(answer.json().error, /chat's token cannot change what the decision engine sends/);
    }
    assert.equal(core.decisionCredentials.getKey(), null);
    assert.equal((await app.inject(fromChat('GET', '/api/decisions/settings'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/decisions/points'))).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test('every decision route is documented with a summary and the Decisions tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  const routes = Object.entries(spec.paths).filter(([path]) => path === '/api/decisions' || path.startsWith('/api/decisions/'));
  assert.ok(routes.reduce((n, [, methods]) => n + Object.keys(methods).length, 0) >= 15);
  for (const [path, methods] of routes) {
    for (const [method, op] of Object.entries(methods)) {
      assert.ok(op.summary && op.tags?.[0] === 'Decisions', `${method.toUpperCase()} ${path} is not documented`);
    }
  }
});
