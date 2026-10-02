import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { ChatSummary, CswapRetirementState, HandoffPreview, ModelMapSuggestion, ProviderCandidates, ProviderMove, ProvidersSettings } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// What happens at a usage limit, over HTTP: a chat on the fake Claude that dies against its limit
// (`FAKE-LIMIT-ONCE`), a Codex that is the fake app-server behind a wrapper, and the routes a person's
// click calls — candidates, the handoff preview, a move, a wait, the model mapping's suggestions.
const FIXTURES = fileURLToPath(new URL('../../../packages/core/test/fixtures/', import.meta.url));
const FAKE_CLAUDE = `${FIXTURES}fake-claude.mjs`;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: FastifyInstance;
let core: Core;
let root: string;
let repo: string;

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ready()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A chat whose first turn dies against the provider's usage limit. */
async function chatAtLimit(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'FAKE-LIMIT-ONCE', cwd: repo }) });
  assert.equal(res.statusCode, 201, res.body);
  const { id } = res.json<ChatSummary>();
  await until('the chat to reach its limit', () => core.runtime.atLimit(id));
  return id;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-rotation-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

  const codex = join(root, 'codex');
  writeFileSync(codex, `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.159.3";; login) exit 0;; *) exec "${process.execPath}" "${FIXTURES}fake-codex-app-server.mjs" "$@";; esac\n`);
  chmodSync(codex, 0o755);

  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/providers/settings',
    ...json({
      providers: { codex: { enabled: true, binaryPath: codex } },
      order: ['claude-code', 'codex'],
      rotation: { onLimit: { action: 'wait', allowed: ['handoff', 'restart', 'wait'], maxWaitHours: 1, maxMoves: 2 }, modelMap: [] },
    }),
  });
  assert.equal(saved.statusCode, 200, saved.body);
  await app.inject({ method: 'POST', url: '/api/providers/refresh' });
});

after(async () => {
  await app.close();
  core.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test('a chat that is working, or does not exist, has no candidates, no handoff and cannot move or wait', async () => {
  assert.equal((await app.inject('/api/providers/candidates')).statusCode, 400);
  assert.equal((await app.inject('/api/providers/candidates?chatId=nope')).statusCode, 404);
  assert.equal((await app.inject('/api/chats/nope/handoff?provider=codex')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/move', ...json({ provider: 'codex', action: 'restart' }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/wait' })).statusCode, 404);
});

test('the move and wait bodies are validated before anything happens', async () => {
  const id = await chatAtLimit();
  for (const body of [{}, { provider: 'codex' }, { action: 'handoff' }, { provider: 'codex', action: 'wait' }, { provider: 7, action: 'handoff' }, { provider: 'codex', action: 'handoff', model: 3 }]) {
    assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${id}/move`, ...json(body) })).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await app.inject(`/api/chats/${id}/handoff`)).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/model-map/suggestions/x', ...json({ accept: 'yes' }) })).statusCode, 400);
  assert.equal((await app.inject('/api/providers/moves?state=nope')).statusCode, 400);
  assert.equal((await app.inject('/api/providers/moves?limit=0')).statusCode, 400);
});

test('a chat at its limit lists its candidates, and with no mapped model Codex is excluded and says why', async () => {
  const id = await chatAtLimit();
  const result = (await app.inject(`/api/providers/candidates?chatId=${id}`)).json<ProviderCandidates>();
  assert.equal(result.movesCapped, false);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.excluded.find((e) => e.provider === 'codex')?.excluded, 'no-mapping');
  // A move to a provider that cannot take it is refused, not attempted
  const refused = await app.inject({ method: 'POST', url: `/api/chats/${id}/move`, ...json({ provider: 'codex', action: 'restart' }) });
  assert.equal(refused.statusCode, 409, refused.body);
});

test('waiting is the person\'s click: a wait row opens, a second is refused, and cancelling closes it', async () => {
  const id = await chatAtLimit();
  const wait = await app.inject({ method: 'POST', url: `/api/chats/${id}/wait` });
  assert.equal(wait.statusCode, 201, wait.body);
  const move = wait.json<ProviderMove>();
  assert.deepEqual([move.state, move.action, move.fromChat, move.decidedBy], ['waiting', 'wait', id, 'person']);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${id}/wait` })).statusCode, 409);

  const open = (await app.inject(`/api/providers/moves?chatId=${id}&state=waiting`)).json<ProviderMove[]>();
  assert.deepEqual(open.map((m) => m.id), [move.id]);

  const cancelled = await app.inject({ method: 'POST', url: `/api/providers/moves/${move.id}/cancel` });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json<ProviderMove>().state, 'cancelled');
  assert.equal((await app.inject({ method: 'POST', url: `/api/providers/moves/${move.id}/cancel` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/moves/nope/cancel' })).statusCode, 404);
  assert.deepEqual((await app.inject(`/api/providers/moves?chatId=${id}&state=waiting`)).json(), []);
});

test('with the model mapped, the handoff is previewed without sending and a move starts a linked chat', async () => {
  // The account's models arrive with a handshake; the catalog is given here so the mapping has a model to name
  const target = 'gpt-test';
  (core.runtime.providers.driverFor('codex') as unknown as { setCatalog(models: Array<{ value: string }>): void }).setCatalog([{ value: '' }, { value: target }]);
  const settings = (await app.inject('/api/providers/settings')).json<ProvidersSettings>();
  const id = await chatAtLimit();
  const own = core.runtime.get(id)?.model ?? '';
  const mapped = await app.inject({
    method: 'PUT',
    url: '/api/providers/settings',
    ...json({ ...settings, rotation: { ...settings.rotation, modelMap: [{ from: { provider: 'claude-code', model: own }, to: { provider: 'codex', model: target }, origin: 'person' }] } }),
  });
  assert.equal(mapped.statusCode, 200, mapped.body);

  const result = (await app.inject(`/api/providers/candidates?chatId=${id}`)).json<ProviderCandidates>();
  assert.deepEqual(result.candidates.map((c) => [c.provider, c.model]), [['codex', target]]);

  const preview = await app.inject(`/api/chats/${id}/handoff?provider=codex`);
  assert.equal(preview.statusCode, 200, preview.body);
  const handoff = preview.json<HandoffPreview>();
  assert.equal(handoff.provider, 'codex');
  assert.equal(handoff.model, target);
  assert.ok(handoff.text.includes('FAKE-LIMIT-ONCE'), 'the handoff carries what was asked');
  assert.equal(handoff.bytes, Buffer.byteLength(handoff.text));
  assert.equal(core.db.providerMoves({ chatId: id }).length, 0, 'previewing moves nothing');

  const moved = await app.inject({ method: 'POST', url: `/api/chats/${id}/move`, ...json({ provider: 'codex', action: 'handoff' }) });
  assert.equal(moved.statusCode, 201, moved.body);
  const chat = moved.json<ChatSummary>();
  assert.notEqual(chat.id, id);
  const [row] = (await app.inject(`/api/providers/moves?chatId=${id}`)).json<ProviderMove[]>();
  assert.deepEqual([row?.state, row?.action, row?.fromChat, row?.toChat, row?.toProvider, row?.decidedBy], ['moved', 'handoff', id, chat.id, 'codex', 'person']);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${id}/move`, ...json({ provider: 'codex', action: 'handoff' }) })).statusCode, 409, 'a chat moves once');
});

test('a move closes the open wait of the chat it moves', async () => {
  const id = await chatAtLimit();
  const wait = (await app.inject({ method: 'POST', url: `/api/chats/${id}/wait` })).json<ProviderMove>();
  const moved = await app.inject({ method: 'POST', url: `/api/chats/${id}/move`, ...json({ provider: 'codex', action: 'restart' }) });
  assert.equal(moved.statusCode, 201, moved.body);
  const closed = core.db.providerMove(wait.id);
  assert.deepEqual([closed?.state, closed?.reason, closed?.toProvider], ['cancelled', 'moved', 'codex']);
});

test('a model-mapping suggestion is listed until it is answered; accepting writes the entry, dismissing does not', async () => {
  const record = (id: string, subjectId: string, counterpart: string) =>
    core.db.insertDecision({
      id,
      point: 'provider.model-map',
      kind: 'suggest',
      projectId: null,
      subjectKind: 'model',
      subjectId,
      provider: 'cli',
      model: 'test',
      mode: 'active',
      status: 'answered',
      unavailable: null,
      state: {},
      questions: [],
      answers: { counterpart: { kind: 'choice', value: counterpart, probabilities: null, confidence: null } },
      confidence: null,
      threshold: null,
      acted: false,
      visible: false,
      savedRun: false,
      latencyMs: 1,
      inputTokens: null,
      costUsd: null,
      outcome: null,
      agreed: null,
      resolvedAt: null,
      feedback: null,
      feedbackAt: null,
      openedAt: null,
      paletteAction: null,
      at: new Date().toISOString(),
    });
  record('sugg-accept', 'claude-code:opus-x→codex', 'gpt-x');
  record('sugg-dismiss', 'claude-code:haiku-x→codex', 'gpt-mini');

  const listed = (await app.inject('/api/providers/model-map/suggestions')).json<ModelMapSuggestion[]>();
  assert.deepEqual(
    listed.map((s) => [s.id, s.from.model, s.to.provider, s.to.model]).sort(),
    [
      ['sugg-accept', 'opus-x', 'codex', 'gpt-x'],
      ['sugg-dismiss', 'haiku-x', 'codex', 'gpt-mini'],
    ],
  );

  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/model-map/suggestions/nope', ...json({ accept: true }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/model-map/suggestions/sugg-dismiss', ...json({ accept: false }) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/model-map/suggestions/sugg-accept', ...json({ accept: true }) })).statusCode, 200);

  const map = (await app.inject('/api/providers/settings')).json<ProvidersSettings>().rotation?.modelMap ?? [];
  const entry = map.find((e) => e.from.model === 'opus-x');
  assert.deepEqual([entry?.to.provider, entry?.to.model, entry?.origin], ['codex', 'gpt-x', 'decision']);
  assert.equal(map.some((e) => e.from.model === 'haiku-x'), false, 'dismissing writes nothing');
  assert.deepEqual((await app.inject('/api/providers/model-map/suggestions')).json(), []);
  assert.equal(core.db.decision('sugg-dismiss')?.feedback, 'not_useful');
  assert.equal(core.db.decision('sugg-accept')?.feedback, 'useful');

  // A model that already has a counterpart is changed in the editor, not by a second suggestion
  record('sugg-again', 'claude-code:opus-x→codex', 'gpt-y');
  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/model-map/suggestions/sugg-again', ...json({ accept: true }) })).statusCode, 409);
});

test('the claude-swap notice reads, dismisses and removes only Agentry\'s own copy', async () => {
  const data = join(root, 'data');
  mkdirSync(join(data, 'tools'), { recursive: true });
  writeFileSync(join(data, 'accounts.json'), '{}');
  const notice = (await app.inject('/api/providers/cswap-retirement')).json<CswapRetirementState>().notice;
  assert.ok(notice?.found.includes('accounts'));
  assert.equal(notice?.managedCopy, true);

  assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/providers/cswap-retirement/managed-copy' })).json(), { removed: true });
  assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/providers/cswap-retirement/managed-copy' })).json(), { removed: false });
  assert.equal((await app.inject('/api/providers/cswap-retirement')).json<CswapRetirementState>().notice?.managedCopy, false);

  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/cswap-retirement/dismiss' })).statusCode, 200);
  assert.deepEqual((await app.inject('/api/providers/cswap-retirement')).json(), { notice: null });
});

test("the accounts routes are gone, and a chat's token cannot move, wait, cancel or answer a suggestion", async () => {
  for (const url of ['/api/accounts', '/api/accounts/policies', '/api/accounts/usage']) assert.equal((await app.inject(url)).statusCode, 404, url);

  const id = await chatAtLimit();
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token } = created.json<{ token: string }>();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  try {
    const chat = core.security.chatTokens.mint(id);
    const fromChat = (method: string, url: string, body?: unknown) => ({
      method: method as 'GET',
      url,
      remoteAddress: '127.0.0.1',
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      headers: { host: '127.0.0.1:34331', authorization: `Bearer ${chat}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const before = core.db.providerMoves().length;
    for (const [method, url, body] of [
      ['POST', `/api/chats/${id}/move`, { provider: 'codex', action: 'restart' }],
      ['POST', `/api/chats/${id}/wait`, undefined],
      ['POST', '/api/providers/moves/some/cancel', undefined],
      ['POST', '/api/providers/model-map/suggestions/some', { accept: true }],
      ['POST', '/api/providers/cswap-retirement/dismiss', undefined],
      ['DELETE', '/api/providers/cswap-retirement/managed-copy', undefined],
    ] as const) {
      assert.equal((await app.inject(fromChat(method, url, body))).statusCode, 403, `${method} ${url}`);
    }
    assert.equal(core.db.providerMoves().length, before, 'nothing moved or waited');
    // What it may read: the candidates, the preview's refusal and the history
    assert.equal((await app.inject(fromChat('GET', '/api/providers/moves'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/providers/model-map/suggestions'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/providers/cswap-retirement'))).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test('the routes of a limit are documented with a summary and a tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  for (const [method, path, tag] of [
    ['get', '/api/chats/{id}/handoff', 'Chats'],
    ['post', '/api/chats/{id}/move', 'Chats'],
    ['post', '/api/chats/{id}/wait', 'Chats'],
    ['get', '/api/providers/candidates', 'Providers'],
    ['get', '/api/providers/moves', 'Providers'],
    ['post', '/api/providers/moves/{id}/cancel', 'Providers'],
    ['get', '/api/providers/model-map/suggestions', 'Providers'],
    ['post', '/api/providers/model-map/suggestions/{id}', 'Providers'],
    ['get', '/api/providers/cswap-retirement', 'Providers'],
    ['post', '/api/providers/cswap-retirement/dismiss', 'Providers'],
    ['delete', '/api/providers/cswap-retirement/managed-copy', 'Providers'],
  ] as const) {
    const op = spec.paths[path]?.[method];
    assert.ok(op?.summary, `${method} ${path} has no summary`);
    assert.deepEqual(op.tags, [tag], `${method} ${path}`);
  }
  assert.equal(Object.keys(spec.paths).some((path) => path.startsWith('/api/accounts')), false, 'the accounts routes are not documented any more');
});
