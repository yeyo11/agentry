import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ChatSummary, LimitAction, ProviderMove, ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { ChatService, type ChatMoveDeps, type ChatServiceDeps, type ChatWork } from '../src/chat-service.ts';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import type { ModelMapSubject, OnLimitSubject, ProviderPoints } from '../src/decisions/provider-points.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { CodexDriver } from '../src/providers/codex/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { ProviderRotation, candidateContext, effectiveOnLimit, type WaitEnd } from '../src/rotation.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

// The rotation over the fake Claude (`FAKE-LIMIT-ONCE`) and the fake Codex app-server (`RATE`): what
// happens at a limit for a person's chat and for automated work, the wait timers, the claim and the
// recovery after a restart.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

const ready = (id: string, label: string): ProviderStatus =>
  ({ id, label, state: 'ready', reason: null, version: '1', compatibleRange: '*', binaryPath: '/bin/x', configHome: null, account: null, capabilities: [], checkedAt: new Date().toISOString() }) as ProviderStatus;

interface Options {
  action?: LimitAction;
  allowed?: LimitAction[];
  maxMoves?: number;
  mapped?: boolean;
  /** Automated work: what the chat works for, and who re-points it */
  work?: ChatWork | null;
  repoint?: boolean;
  points?: Pick<ProviderPoints, 'onLimit' | 'suggestMapping'> | null;
}

function settingsOf(o: Options): ProvidersSettings {
  const settings = defaultProvidersSettings(['claude-code', 'codex']);
  const rotation = defaultRotationSettings();
  rotation.onLimit = { ...rotation.onLimit, action: o.action ?? 'wait', allowed: o.allowed ?? [o.action ?? 'wait'], maxMoves: o.maxMoves ?? 2 };
  if (o.mapped !== false) rotation.modelMap = [{ from: { provider: 'claude-code', model: 'fake' }, to: { provider: 'codex', model: '' }, origin: 'person', at: new Date().toISOString() }];
  settings.rotation = rotation;
  return settings;
}

function rig(o: Options = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE), new CodexDriver(FAKE_CODEX)]);
  const settings = settingsOf(o);
  const move: ChatMoveDeps = {
    settings: () => settings,
    statuses: () => [ready('claude-code', 'Claude Code'), ready('codex', 'Codex')],
    projectProviders: () => null,
    moves: db,
    ...(o.work ? { work: () => o.work ?? null } : {}),
  };
  const service = new ChatService({ config, runtime: chats, sessions: new SessionStore(config), move, place: () => ({ project: null, worktree: null }) } as unknown as ChatServiceDeps);
  service.summaryOf = async (id) => ({ id }) as ChatSummary;
  const events: AgentryEventInput[] = [];
  const repointed: ProviderMove[] = [];
  const ended: Array<{ move: ProviderMove; end: WaitEnd; reason: string | null }> = [];
  let offset = 0;
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    chats: service,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    decisions: o.points ? { effective: () => ({ mode: 'active', limited: false }), ask: async () => null } as never : null,
    points: (o.points as ProviderPoints | null | undefined) ?? null,
    emit: (event) => events.push(event),
    ...(o.work ? { work: () => o.work ?? null } : {}),
    ...(o.repoint ? { repoint: (m: ProviderMove) => repointed.push(m) } : {}),
    ended: (m, end, reason) => ended.push({ move: m, end, reason }),
    now: () => Date.now() + offset,
    pollMs: 20,
    slackMs: 0,
  });
  rotation.start();
  const limited = async (provider: 'claude-code' | 'codex' = 'claude-code', extra: Partial<Parameters<ChatManager['start']>[0]> = {}) => {
    const chat = chats.start({ prompt: provider === 'codex' ? 'RATE' : 'FAKE-LIMIT-ONCE', name: 'limited', keepAlive: false, provider, ...extra });
    await chats.exited(chat.id);
    // The announcement is handled in the next turn of the loop
    await new Promise((r) => setTimeout(r, 30));
    return chat.id;
  };
  return {
    config,
    db,
    chats,
    service,
    rotation,
    events,
    repointed,
    ended,
    limited,
    skip: (ms: number) => {
      offset += ms;
    },
    close: () => (rotation.close(), chats.stopAll(), db.close()),
  };
}

const waitFor = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const pastMove = (chatId: string, provider: string, resetsAt: string | null = new Date(Date.now() - 1000).toISOString()): ProviderMove => {
  const at = new Date(Date.now() - 60_000).toISOString();
  return {
    id: `wait-${chatId}-${Math.random().toString(16).slice(2)}`,
    at,
    subjectKind: 'chat',
    subjectId: chatId,
    projectId: null,
    fromChat: chatId,
    toChat: null,
    fromProvider: provider,
    toProvider: null,
    fromModel: null,
    toModel: null,
    action: 'wait',
    state: 'waiting',
    decidedBy: 'setting',
    decisionId: null,
    resetsAt,
    reason: null,
    updatedAt: at,
  };
};

const work: ChatWork = { kind: 'flow-run', subjectKind: 'flow_run', subjectId: 'run-1', prompt: 'FAKE-LIMIT-ONCE' };

test("a person's chat at a limit is announced and left alone, until its click", async () => {
  const { chats, db, events, limited, rotation, close } = rig({ action: 'handoff', allowed: ['handoff', 'restart', 'wait'], repoint: true });
  try {
    const id = await limited();
    assert.equal(events.filter((e) => e.type === 'run.rateLimited').length, 1);
    assert.equal(db.providerMoves({ chatId: id }).length, 0, 'nothing moves on its own (P4-2)');
    assert.equal(rotation.holds(id), false);
    assert.ok(!chats.get(id)?.continuedIn);

    const wait = rotation.waitFor(id);
    assert.equal(wait?.state, 'waiting');
    assert.equal(wait?.decidedBy, 'person');
    assert.equal(wait?.fromProvider, 'claude-code');
    assert.equal(rotation.holds(id), true);
    assert.equal(events.filter((e) => e.type === 'run.limitWaiting').length, 1);
    assert.equal(rotation.waitOf(id), wait?.id);
    assert.equal(rotation.waitFor(id), null, 'one open wait per chat');
  } finally {
    close();
  }
});

test('wait on Claude: the turn is replayed once when the reset has passed', async () => {
  const { chats, db, ended, limited, rotation, close } = rig();
  try {
    const id = await limited();
    const row = pastMove(id, 'claude-code');
    assert.equal(db.insertProviderMove(row), true);
    rotation.recover();
    await waitFor(() => db.providerMove(row.id)?.state === 'resumed');
    await chats.exited(id);
    assert.equal(chats.get(id)?.executions.at(-1)?.outcome, 'completed', 'the replay went through');
    assert.deepEqual(ended.map((e) => e.end), ['resumed']);
    assert.equal(rotation.holds(id), false);
  } finally {
    close();
  }
});

test('wait on Codex: the same chat goes on in its own provider', async () => {
  const { chats, db, limited, rotation, close } = rig();
  try {
    const id = await limited('codex');
    assert.equal(chats.get(id)?.provider, 'codex');
    assert.equal(chats.atLimit(id), true);
    const wait = rotation.waitFor(id);
    assert.equal(wait?.fromProvider, 'codex');
    // The fake's snapshot says when it resets: the wait took it
    assert.ok(wait?.resetsAt === null || typeof wait?.resetsAt === 'string');
    rotation.cancel(wait?.id ?? '');
    const row = pastMove(id, 'codex');
    db.insertProviderMove(row);
    rotation.recover();
    await waitFor(() => db.providerMove(row.id)?.state === 'resumed');
    assert.equal(chats.get(id)?.executions.length, 2, 'the turn was sent again');
  } finally {
    close();
  }
});

test('a wait with no reset known ends failed once the cap passes', async () => {
  const { db, ended, limited, rotation, skip, close } = rig();
  try {
    const id = await limited();
    const wait = rotation.waitFor(id);
    assert.ok(wait && wait.resetsAt === null, 'the fake reports no reset');
    skip(7 * 3_600_000);
    await waitFor(() => db.providerMove(wait.id)?.state === 'failed');
    assert.equal(db.providerMove(wait.id)?.reason, 'limit-wait-expired');
    assert.deepEqual(ended.map((e) => [e.end, e.reason]), [['failed', 'limit-wait-expired']]);
    assert.equal(rotation.holds(id), false);
  } finally {
    close();
  }
});

test('stopping a wait closes it as cancelled and the turn is never replayed', async () => {
  const { chats, db, ended, limited, rotation, close } = rig();
  try {
    const id = await limited();
    const wait = rotation.waitFor(id);
    assert.ok(wait);
    assert.equal(rotation.cancel(wait.id), true);
    assert.equal(db.providerMove(wait.id)?.state, 'cancelled');
    assert.equal(rotation.cancel(wait.id), false, 'not open any more');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(chats.get(id)?.executions.length, 1);
    assert.deepEqual(ended.map((e) => e.end), ['cancelled']);
  } finally {
    close();
  }
});

test('a wait survives a restart: the chat is restored and its turn goes on', async () => {
  const first = rig();
  let id = '';
  let rowId = '';
  try {
    id = await first.limited();
    const row = pastMove(id, 'claude-code', new Date(Date.now() + 3_600_000).toISOString());
    rowId = row.id;
    first.db.insertProviderMove(row);
  } finally {
    first.rotation.close();
    first.chats.stopAll();
  }
  // A new process on the same data directory
  const db = new Db(first.config);
  const chats = new ChatManager(first.config, db, [new ClaudeCodeDriver(FAKE_CLAUDE), new CodexDriver(FAKE_CODEX)]);
  const settings = settingsOf({});
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    chats: { candidates: () => ({ candidates: [], excluded: [], movesCapped: false }), continueOn: async () => assert.fail('no move') } as never,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    decisions: null,
    points: null,
    emit: () => undefined,
    // The reset passes while the process is down
    now: () => Date.now() + 2 * 3_600_000,
    pollMs: 20,
    slackMs: 0,
  });
  try {
    await chats.restore(new SessionStore(first.config));
    assert.ok(chats.get(id), 'the chat is back');
    rotation.recover();
    await waitFor(() => db.providerMove(rowId)?.state === 'resumed');
    await waitFor(() => (chats.get(id)?.executions.length ?? 0) >= 2);
  } finally {
    rotation.close();
    chats.stopAll();
    db.close();
    first.db.close();
  }
});

test('two processes on one data directory replay a wait once', async () => {
  const { chats, config, db, limited, rotation: one, close } = rig();
  const db2 = new Db(config);
  try {
    const id = await limited();
    const row = pastMove(id, 'claude-code');
    db.insertProviderMove(row);
    const settings = settingsOf({});
    const two = new ProviderRotation({
      db: db2,
      runtime: chats,
      chats: { candidates: () => ({ candidates: [], excluded: [], movesCapped: false }), continueOn: async () => assert.fail('no move') } as never,
      settings: () => settings,
      projectProviders: () => null,
      projectOf: () => null,
      decisions: null,
      points: null,
      emit: () => undefined,
      pollMs: 20,
      slackMs: 0,
    });
    one.recover();
    two.recover();
    await waitFor(() => db.providerMove(row.id)?.state === 'resumed');
    await chats.exited(id);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(chats.get(id)?.executions.length, 2, 'the original turn and one replay');
    two.close();
  } finally {
    db2.close();
    close();
  }
});

test('automated work at a limit moves by the setting: handoff, re-pointed, once', async () => {
  const { chats, db, limited, repointed, close } = rig({ action: 'handoff', allowed: ['handoff', 'wait'], work, repoint: true });
  try {
    const id = await limited();
    await waitFor(() => repointed.length === 1);
    const move = repointed[0];
    assert.equal(move?.state, 'moved');
    assert.equal(move?.action, 'handoff');
    assert.equal(move?.decidedBy, 'setting');
    assert.equal(move?.toProvider, 'codex');
    assert.equal(move?.subjectKind, 'flow_run');
    assert.equal(move?.subjectId, 'run-1');
    assert.equal(chats.get(id)?.continuedIn?.chatId, move?.toChat);
    assert.equal(db.providerMoves({ chatId: id }).length, 1);
    await chats.exited(move?.toChat ?? '');
  } finally {
    close();
  }
});

test('automated work at a limit restarts on the other provider with its prompt', async () => {
  const { chats, limited, repointed, close } = rig({ action: 'restart', allowed: ['restart', 'wait'], work, repoint: true });
  try {
    await limited();
    await waitFor(() => repointed.length === 1);
    assert.equal(repointed[0]?.action, 'restart');
    assert.equal(chats.get(repointed[0]?.toChat ?? '')?.prompt, 'FAKE-LIMIT-ONCE');
    await chats.exited(repointed[0]?.toChat ?? '');
  } finally {
    close();
  }
});

test('with nobody to re-point the run, automated work waits instead of moving', async () => {
  const { db, limited, repointed, close } = rig({ action: 'handoff', allowed: ['handoff', 'wait'], work });
  try {
    const id = await limited();
    const [row] = db.providerMoves({ chatId: id });
    assert.equal(row?.action, 'wait');
    assert.equal(row?.state, 'waiting');
    assert.match(row?.reason ?? '', /cannot be moved/);
    assert.equal(repointed.length, 0);
  } finally {
    close();
  }
});

test('an action the person did not allow is never taken', async () => {
  const { db, limited, close } = rig({ action: 'handoff', allowed: ['wait'], work, repoint: true });
  try {
    const id = await limited();
    assert.equal(db.providerMoves({ chatId: id })[0]?.action, 'wait');
  } finally {
    close();
  }
});

test('the moves cap turns a move into a wait', async () => {
  const { db, limited, close } = rig({ action: 'handoff', allowed: ['handoff', 'wait'], maxMoves: 0, work, repoint: true });
  try {
    const id = await limited();
    const [row] = db.providerMoves({ chatId: id });
    assert.equal(row?.action, 'wait');
    assert.match(row?.reason ?? '', /moves/);
  } finally {
    close();
  }
});

test('no move when every candidate is excluded: it waits, and the missing mapping is suggested', async () => {
  const suggested: ModelMapSubject[] = [];
  const points = {
    onLimit: async () => null,
    suggestMapping: async (_stance: string, subject: ModelMapSubject) => {
      suggested.push(subject);
      return null;
    },
  };
  const { db, limited, close } = rig({ action: 'handoff', allowed: ['handoff', 'wait'], mapped: false, work, repoint: true, points });
  try {
    const id = await limited();
    const [row] = db.providerMoves({ chatId: id });
    assert.equal(row?.action, 'wait');
    assert.match(row?.reason ?? '', /no counterpart/);
    assert.equal(suggested.length, 1);
    assert.equal(suggested[0]?.from.provider, 'claude-code');
    assert.equal(suggested[0]?.from.model, 'fake');
    assert.equal(suggested[0]?.target, 'codex');
  } finally {
    close();
  }
});

test('provider.on-limit chooses among the feasible, allowed actions and its id goes on the row', async () => {
  const asked: OnLimitSubject[] = [];
  const points = {
    onLimit: async (_stance: string, subject: OnLimitSubject) => {
      asked.push(subject);
      return { action: 'restart' as const, decisionId: 'decision-1' };
    },
    suggestMapping: async () => null,
  };
  const { limited, repointed, close } = rig({ action: 'wait', allowed: ['wait', 'handoff', 'restart'], work, repoint: true, points });
  try {
    await limited();
    await waitFor(() => repointed.length === 1);
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]?.allowed.sort(), ['handoff', 'restart', 'wait']);
    assert.equal(asked[0]?.kind, 'flow_run');
    assert.equal(asked[0]?.candidates[0]?.id, 'codex');
    assert.equal(repointed[0]?.action, 'restart');
    assert.equal(repointed[0]?.decidedBy, 'decision');
    assert.equal(repointed[0]?.decisionId, 'decision-1');
  } finally {
    close();
  }
});

test('a provider.on-limit that cannot answer leaves the setting in charge', async () => {
  const points = {
    onLimit: async () => {
      throw new Error('the decision engine is down');
    },
    suggestMapping: async () => null,
  };
  const { limited, repointed, close } = rig({ action: 'restart', allowed: ['wait', 'handoff', 'restart'], work, repoint: true, points });
  try {
    await limited();
    await waitFor(() => repointed.length === 1);
    assert.equal(repointed[0]?.action, 'restart');
    assert.equal(repointed[0]?.decidedBy, 'setting');
  } finally {
    close();
  }
});

test('automated work whose limit handling fails waits for the reset instead of being left open', async () => {
  const points = {
    // Thrown before any promise exists, so it escapes the decision and the whole handling fails
    onLimit: () => {
      throw new Error('broken point');
    },
    suggestMapping: async () => null,
  };
  const { limited, rotation, repointed, close } = rig({ action: 'restart', allowed: ['wait', 'handoff', 'restart'], work, repoint: true, points });
  try {
    const id = await limited();
    await waitFor(() => rotation.waitOf(id) !== null);
    assert.equal(repointed.length, 0);
    assert.equal(rotation.holds(id), true);
  } finally {
    close();
  }
});

test('a move whose re-pointing fails does not also wait on the old chat', async () => {
  const { limited, rotation, service, close } = rig({ action: 'restart', allowed: ['wait', 'handoff', 'restart'], work, points: null, repoint: true });
  const continued: string[] = [];
  const original = service.continueOn.bind(service);
  service.continueOn = async (...args: Parameters<typeof original>) => {
    const out = await original(...args);
    continued.push(out.move.id);
    return out;
  };
  (rotation as unknown as { deps: { repoint: () => void } }).deps.repoint = () => {
    throw new Error('the flow run is gone');
  };
  try {
    const id = await limited();
    await waitFor(() => continued.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rotation.waitOf(id), null);
  } finally {
    close();
  }
});

test("a point is not asked when only one action is feasible, and a person's chat is never put to it", async () => {
  let calls = 0;
  const points = {
    onLimit: async () => {
      calls++;
      return null;
    },
    suggestMapping: async () => null,
  };
  const only = rig({ action: 'wait', allowed: ['wait'], work, repoint: true, points });
  try {
    await only.limited();
    assert.equal(calls, 0);
  } finally {
    only.close();
  }
  const person = rig({ action: 'wait', allowed: ['wait', 'handoff'], repoint: true, points });
  try {
    await person.limited();
    assert.equal(calls, 0);
  } finally {
    person.close();
  }
});

test("the decision engine's own chats never move or wait", async () => {
  const { db, events, limited, rotation, close } = rig({ action: 'handoff', allowed: ['handoff', 'wait'], repoint: true });
  try {
    const id = await limited('claude-code', { internal: true });
    assert.equal(db.providerMoves({ chatId: id }).length, 0);
    assert.equal(rotation.holds(id), false);
    assert.equal(events.filter((e) => e.type === 'run.rateLimited').length, 1);
  } finally {
    close();
  }
});

test('the effective setting is the project override on the global one', () => {
  const settings = settingsOf({ action: 'wait', allowed: ['wait', 'handoff'] });
  assert.equal(effectiveOnLimit(settings, null).action, 'wait');
  assert.equal(effectiveOnLimit(settings, { onLimit: { action: 'handoff', maxWaitHours: 12 } }).maxWaitHours, 12);
  assert.equal(effectiveOnLimit({}, null).action, 'wait', 'a file written before rotation reads as the defaults');
});

test("the candidates' context reads the registry, the detector and the limits", async () => {
  const { chats, close } = rig();
  try {
    const context = candidateContext(chats, { settings: settingsOf({}), project: null, statuses: [ready('claude-code', 'Claude Code'), ready('codex', 'Codex')] });
    assert.deepEqual(Object.keys(context.providers).sort(), ['claude-code', 'codex']);
    assert.equal(context.providers.codex?.hasDriver, true);
    assert.ok(context.providers['claude-code']?.capabilities.includes('structuredOutput'));
  } finally {
    close();
  }
});
