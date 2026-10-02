import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ChatSummary, ProviderLimit, ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { AccountsRetired, ChatService, MoveRefusal, type ChatMoveDeps, type ChatServiceDeps } from '../src/chat-service.ts';
import { ChatManager, ChatRefusal, type ChatRuntime } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { CodexDriver } from '../src/providers/codex/driver.ts';
import { SessionStore } from '../src/sessions.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { tempConfig } from './helpers.ts';

// A chat at its provider's limit, over the fake Claude (`FAKE-LIMIT-ONCE`) and the fake Codex
// app-server: the limit is recorded per provider, the chat announces it once, a wait replays the turn
// and a move starts a linked chat on the other provider.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

const ready = (id: string, label: string): ProviderStatus =>
  ({ id, label, state: 'ready', reason: null, version: '1', compatibleRange: '*', binaryPath: '/bin/x', configHome: null, account: null, capabilities: [], checkedAt: new Date().toISOString() }) as ProviderStatus;

/** The fake Claude reports the model `fake`; a counterpart is mapped for it unless a test is about the missing one. */
function settingsWith(mapped: boolean): ProvidersSettings {
  const settings = defaultProvidersSettings(['claude-code', 'codex']);
  if (mapped) settings.rotation = { ...defaultRotationSettings(), modelMap: [{ from: { provider: 'claude-code', model: 'fake' }, to: { provider: 'codex', model: '' }, origin: 'person', at: new Date().toISOString() }] };
  return settings;
}

function rig(settings: ProvidersSettings = settingsWith(true)) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE), new CodexDriver(FAKE_CODEX)]);
  const move: ChatMoveDeps = {
    settings: () => settings,
    statuses: () => [ready('claude-code', 'Claude Code'), ready('codex', 'Codex')],
    projectProviders: () => null,
    moves: db,
  };
  const service = new ChatService({ config, runtime: chats, sessions: new SessionStore(config), move, place: () => ({ project: null, worktree: null }) } as unknown as ChatServiceDeps);
  // The assembled chat needs the transcript store and the CLI's list; what is under test is the runtime's
  service.summaryOf = async (id) => ({ id }) as ChatSummary;
  const hits: Array<{ run: ChatRuntime; limit: ProviderLimit | null }> = [];
  chats.on('limit-hit', (run: ChatRuntime, limit: ProviderLimit | null) => hits.push({ run, limit }));
  const limited = async (prompt = 'FAKE-LIMIT-ONCE', model?: string) => {
    const chat = chats.start({ prompt, name: 'limited', keepAlive: false, ...(model ? { model } : {}) });
    await chats.exited(chat.id);
    return chat.id;
  };
  return { db, chats, service, hits, limited, settings, close: () => (chats.stopAll(), db.close()) };
}

test('a turn lost to the limit is recorded for its provider and announced once', async () => {
  const { chats, db, hits, limited, close } = rig();
  try {
    const id = await limited();
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.run.id, id);
    assert.equal(hits[0]?.limit?.state, 'exhausted');
    assert.equal(db.providerLimit('claude-code')?.state, 'exhausted', 'the row every process on the data directory shares');
    assert.equal(chats.limitOf(id)?.provider, 'claude-code');
    assert.equal(chats.atLimit(id), true);
    assert.equal(chats.limitComing(id), false, 'it was announced already');
  } finally {
    close();
  }
});

test('wait: the same chat replays its turn on the same provider, once', async () => {
  const { chats, hits, limited, close } = rig();
  try {
    const id = await limited();
    assert.equal(await chats.replayLastTurn(id), true);
    await chats.exited(id);
    assert.equal(chats.get(id)?.executions.at(-1)?.outcome, 'completed');
    assert.equal(hits.length, 1);
    assert.equal(await chats.replayLastTurn(id), false, 'a second failure is a real one');
  } finally {
    close();
  }
});

test('a request that sends an account is refused: accounts were retired', async () => {
  const { chats, service, limited, close } = rig();
  // Built apart from the call: the field is gone from the types, and a body can still carry it
  const pinned = { prompt: 'hi', account: '1' };
  try {
    assert.throws(() => chats.start(pinned), (err: unknown) => err instanceof ChatRefusal && err.statusCode === 400 && /accounts were retired/.test(err.message));
    const id = await limited('hello');
    assert.throws(() => chats.resume(id, { prompt: 'again', ...{ account: null } }), ChatRefusal);
    await assert.rejects(() => service.create(pinned), AccountsRetired);
    await assert.rejects(() => service.fork(id, pinned), AccountsRetired);
  } finally {
    close();
  }
});

test('a handoff moves the work to a new chat on the other provider, linked both ways', async () => {
  const { chats, db, service, limited, close } = rig();
  try {
    const id = await limited();
    const candidates = service.candidates(id);
    assert.deepEqual(candidates.candidates.map((c) => c.provider), ['codex']);
    assert.ok(candidates.excluded.some((e) => e.provider === 'claude-code' && e.excluded === 'exhausted'));

    const preview = await service.handoff(id, 'codex');
    assert.match(preview.text, /What was asked/);
    assert.ok(preview.bytes > 0 && preview.sections.length === 5);

    const { chat, move } = await service.continueOn(id, { provider: 'codex', action: 'handoff' });
    const next = chats.get(chat.id);
    await chats.exited(chat.id);
    assert.equal(next?.provider, 'codex');
    assert.equal(next?.continuedFrom?.chatId, id);
    assert.equal(next?.continuedFrom?.action, 'handoff');
    assert.equal(chats.get(id)?.continuedIn?.chatId, chat.id);
    assert.equal(move.state, 'moved');
    assert.equal(move.toProvider, 'codex');
    assert.equal(db.providerMoves({ chatId: id })[0]?.id, move.id);
    assert.equal(next?.cwd, chats.get(id)?.cwd, 'the same directory');
    assert.ok(next?.prompt.includes('What was asked'), 'the first turn is the handoff');

    await assert.rejects(() => service.continueOn(id, { provider: 'codex', action: 'restart' }), MoveRefusal);
  } finally {
    close();
  }
});

test('a restart starts the original prompt on the other provider', async () => {
  const { chats, service, limited, close } = rig();
  try {
    const id = await limited();
    const { chat } = await service.continueOn(id, { provider: 'codex', action: 'restart' });
    await chats.exited(chat.id);
    assert.equal(chats.get(chat.id)?.prompt, 'FAKE-LIMIT-ONCE');
    assert.equal(chats.get(chat.id)?.continuedFrom?.action, 'restart');
  } finally {
    close();
  }
});

test('a model with no counterpart waits: the move names the missing mapping', async () => {
  const { service, limited, close } = rig(settingsWith(false));
  try {
    const id = await limited();
    assert.deepEqual(service.candidates(id).excluded.find((e) => e.provider === 'codex'), { provider: 'codex', excluded: 'no-mapping' });
    await assert.rejects(() => service.continueOn(id, { provider: 'codex', action: 'handoff' }), /no-mapping/);
  } finally {
    close();
  }
});

test('a chat that is working and has not reached a limit is not moved', async () => {
  const { chats, service, close } = rig();
  try {
    const chat = chats.start({ prompt: 'FAKE-HANG', name: 'busy' });
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(() => service.continueOn(chat.id, { provider: 'codex', action: 'restart' }), MoveRefusal);
    chats.stop(chat.id);
    await chats.exited(chat.id);
  } finally {
    close();
  }
});

test('a chat with no move dependencies cannot be moved', async () => {
  const config = tempConfig();
  const db = new Db(config);
  const chats = new ChatManager(config, db);
  const service = new ChatService({ config, runtime: chats } as unknown as ChatServiceDeps);
  try {
    assert.throws(() => service.candidates('x'), MoveRefusal);
  } finally {
    db.close();
  }
});
