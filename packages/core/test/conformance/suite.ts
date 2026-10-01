import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PermissionDecision, ProviderCapability, RunEvent, RunEventKind, ToolPolicy } from '@agentry/shared';
import { ChatManager } from '../../src/chats.ts';
import { CapabilityRefusal, ChatService, type ChatServiceDeps } from '../../src/chat-service.ts';
import { Db } from '../../src/db.ts';
import type { CoreConfig } from '../../src/paths.ts';
import { PermissionBroker } from '../../src/permissions.ts';
import type { ProviderDriver, SessionInit } from '../../src/providers/driver.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import { tempConfig } from '../helpers.ts';

// What every provider's driver must do, asserted through `ChatManager` on the provider's fake CLI:
// the driver is only ever reached that way, so a case that passes here is one Agentry can rely on.
// A case whose capability the driver does not declare is skipped, with the capability as the reason.
// Nothing here names a provider's protocol: the harness says how to make its fake behave.

/** How to drive one provider's driver in the suite. */
export interface DriverHarness {
  /** The provider's manifest: which cases apply is read off its declared capabilities */
  manifest: ProviderDriver['manifest'];
  /** Variables the provider's fake needs, put on the process for the suite's duration (`PATH` for a fake binary) */
  env?: Record<string, string>;
  /** The driver, started on the provider's fake */
  driver(config: CoreConfig): ProviderDriver;
  /** What a turn says to make the fake behave; each is a whole prompt */
  script: {
    /** Two assistant messages, then the turn ends */
    turn: string;
    /** The agent asks permission for a tool and waits for the answer */
    ask(tool: string): string;
    /** The agent asks for something no agent may, and waits for it to be answered */
    unexpected: string;
    /** The turn ends because the budget ran out */
    budget: string;
    /** The turn ends against the account's rate limit */
    rateLimit: string;
    /** The turn streams its structured result and ends with it */
    structured: string;
    /** A line of stderr, and a stdout line that is not the protocol */
    noisy: string;
    /** Delegates work and runs commands, so that task events come out */
    delegating: string;
    /** A first turn whose fake holds the handshake back, so a second turn can be sent before it completes (case 15) */
    slowHandshake?: string;
    /** The agent asks to run `git push` and reports what it was told (case 16) */
    gitPush?: string;
    /** The agent asks permission and holds the request until the host cancels it (case 17) */
    holdUntilCancel?: string;
    /** The session cannot start because nobody is signed in (case 18) */
    signedOut?: string;
  };
  /** Set when the provider's fake writes what a real session would, so `transcripts` can be read back (case 19) */
  writesTranscripts?: boolean;
  /** What the turn `structured` returns */
  structuredResult: unknown;
  /** What the agent was told, read from the text of the result that ended an `ask` turn */
  decision(result: string): 'allow' | 'deny' | null;
  /** The text `script.noisy` writes to stderr */
  stderrText: string;
}

const KINDS: readonly RunEventKind[] = ['message', 'init', 'result', 'task', 'status', 'stderr', 'notice', 'other', 'partial'];
const EVENT_KEYS = new Set(['seq', 'ts', 'kind', 'entry', 'status', 'text', 'block', 'init', 'outcome', 'task', 'data']);

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Rig {
  driver: ProviderDriver;
  chats: ChatManager;
  broker: PermissionBroker;
  /** `chat-result` payloads, in order */
  results: Array<{ chatId: string; isError: boolean; result: string; structuredOutput?: unknown; cause?: string }>;
  structured: string[];
  inits: SessionInit[];
  /** The chats a rotation was asked for: what `rateLimited` leads to */
  rotations: string[];
  close(): void;
}

function rig(harness: DriverHarness): Rig {
  const config = tempConfig();
  const driver = harness.driver(config);
  const db = new Db(config);
  const chats = new ChatManager(config, db, [driver]);
  const broker = new PermissionBroker();
  chats.permissions = broker;
  const results: Rig['results'] = [];
  const structured: string[] = [];
  const inits: SessionInit[] = [];
  const rotations: string[] = [];
  chats.on('rate-limited', (chat: { id: string }) => rotations.push(chat.id));
  chats.on('chat-result', (chatId: string, result: Omit<Rig['results'][number], 'chatId'>) => results.push({ chatId, ...result }));
  chats.on('chat-structured', (_id: string, json: string) => structured.push(json));
  chats.on('chat-init', (_provider: string, init: SessionInit) => inits.push(init));
  return {
    driver,
    chats,
    broker,
    results,
    structured,
    inits,
    rotations,
    close: () => {
      chats.stopAll();
      broker.close();
      db.close();
    },
  };
}

/** Runs one case on its own rig, closed whatever happens. */
function scenario(harness: DriverHarness, name: string, run: (r: Rig) => Promise<void>, needs?: ProviderCapability, skip?: string | false): void {
  const missing = needs && !harness.manifest.capabilities.includes(needs);
  const reason = missing ? `${harness.manifest.id} does not declare ${needs}` : skip;
  test(name, reason ? { skip: reason } : {}, async () => {
    const r = rig(harness);
    try {
      await run(r);
    } finally {
      r.close();
    }
  });
}

const statuses = (events: RunEvent[]) => events.filter((e) => e.kind === 'status').map((e) => e.status);
const resultOf = (events: RunEvent[]) => events.filter((e) => e.kind === 'result');

/** Policies that probe one part each; the base is the one that says nothing, so any rule is that part's. */
const BASE: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'omit', gitPush: 'omit' };
const PROBES: Array<{ part: string; policy: ToolPolicy }> = [
  { part: 'read.allow', policy: { ...BASE, read: { allow: true } } },
  { part: 'read.denyPaths', policy: { ...BASE, read: { allow: true, denyPaths: ['.env', 'secrets/**'] } } },
  { part: 'edit.allow', policy: { ...BASE, edit: { allow: 'any' } } },
  { part: 'edit.allow', policy: { ...BASE, edit: { allow: ['docs', 'src/**'] } } },
  { part: 'edit.deny', policy: { ...BASE, edit: { allow: 'none', deny: true } } },
  { part: 'commands.allow', policy: { ...BASE, commands: { allow: 'any' } } },
  { part: 'commands.allow', policy: { ...BASE, commands: { allow: [{ command: 'git status', args: 'none' }, { pattern: 'npm test*' }] } } },
  { part: 'commands.deny', policy: { ...BASE, commands: { allow: 'none', deny: 'all' } } },
  { part: 'commands.deny', policy: { ...BASE, commands: { allow: 'any', deny: [{ command: 'rm', args: 'prefix' }] } } },
  { part: 'network', policy: { ...BASE, network: 'allow' } },
  { part: 'network', policy: { ...BASE, network: 'deny' } },
  { part: 'delegate', policy: { ...BASE, delegate: 'deny' } },
  { part: 'workflow', policy: { ...BASE, workflow: 'allow' } },
  { part: 'gitPush', policy: { ...BASE, gitPush: 'deny' } },
  { part: 'exclusive', policy: { ...BASE, read: { allow: true }, exclusive: true } },
];

const GIT_PUSH_POLICY: ToolPolicy = { ...BASE, commands: { allow: 'any' }, gitPush: 'deny' };

/** Case 16 applies to a driver whose policy translation leaves `commands` to the judge. */
function hostSkip(harness: DriverHarness): string | false {
  const host = harness.driver(tempConfig()).translatePolicy(GIT_PUSH_POLICY).host;
  if (!host?.includes('commands')) return `${harness.manifest.id} has no host part for the judge to enforce`;
  return harness.script.gitPush ? false : 'the harness has no git push script';
}

/** Case 19 applies to a driver that keeps transcripts and a fake that writes them. */
function transcriptsSkip(harness: DriverHarness): string | false {
  if (!harness.driver(tempConfig()).transcripts) return `${harness.manifest.id} has no transcript store in the suite's rig`;
  return harness.writesTranscripts ? false : `the ${harness.manifest.id} fake writes no transcript`;
}

/** Every case every driver must pass; call it from a test file with the provider's harness. */
export function driverConformance(name: string, harness: DriverHarness): void {
  const declared = new Set(harness.manifest.capabilities);

  describe(`driver conformance: ${name}`, () => {
    const saved: Record<string, string | undefined> = {};
    before(() => {
      for (const [key, value] of Object.entries(harness.env ?? {})) {
        saved[key] = process.env[key];
        process.env[key] = value;
      }
    });
    after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    // 1
    scenario(harness, 'a start gives one init with the session id Agentry chose, and confirmed capabilities within the declared ones', async ({ chats, inits, driver }) => {
      const chat = chats.start({ prompt: harness.script.turn, name: 'conformance', keepAlive: false });
      await chats.exited(chat.id);
      const events = chats.events(chat.id);
      const init = events.filter((e) => e.kind === 'init');
      assert.equal(init.length, 1, 'one init event');
      if (driver.sessionIds === 'imposed') {
        assert.equal(init[0]?.init?.sessionId, chat.id);
      } else {
        const native = chats.get(chat.id)?.nativeSessionId;
        assert.ok(native, 'the native id is recorded on the chat');
        assert.equal(init[0]?.init?.sessionId, native);
      }
      const first = inits[0];
      assert.ok(first, 'the session announced what it is');
      const confirmation = driver.confirm(first);
      for (const capability of [...confirmation.confirmed, ...confirmation.missing]) {
        assert.ok(declared.has(capability), `${capability} is confirmed or contradicted but not declared`);
      }
      assert.deepEqual(
        confirmation.confirmed.filter((c) => confirmation.missing.includes(c)),
        [],
        'nothing is both confirmed and missing',
      );
    });

    // 2
    scenario(harness, 'a turn gives assistant messages and then one result, starting → busy → idle', async ({ chats }) => {
      const chat = chats.start({ prompt: harness.script.turn, name: 'conformance' });
      assert.ok(['starting', 'busy'].includes(chat.status), 'a chat starts out busy, never idle');
      await until(() => chats.get(chat.id)?.status === 'idle' && resultOf(chats.events(chat.id)).length > 0, 'the turn to end');
      const events = chats.events(chat.id);
      assert.deepEqual(statuses(events), ['busy', 'idle']);
      const kinds = events.map((e) => e.kind);
      const messages = kinds.filter((k) => k === 'message').length;
      assert.ok(messages >= 2, 'assistant messages came out');
      assert.equal(resultOf(events).length, 1);
      assert.ok(kinds.lastIndexOf('message') < kinds.indexOf('result'), 'the messages come before the result');
    });

    scenario(harness, 'with keepAlive false the process exits and the chat is completed', async ({ chats }) => {
      const chat = chats.start({ prompt: harness.script.turn, name: 'conformance', keepAlive: false });
      await chats.exited(chat.id);
      const done = chats.get(chat.id);
      assert.equal(done?.status, 'completed');
      assert.equal(done?.pid, null);
      assert.deepEqual(statuses(chats.events(chat.id)), ['busy', 'completed']);
    });

    // 3
    scenario(
      harness,
      'resume keeps the id',
      async ({ chats, driver }) => {
        const chat = chats.start({ prompt: harness.script.turn, name: 'conformance', keepAlive: false });
        await chats.exited(chat.id);
        chats.resume(chat.id, { prompt: harness.script.turn });
        await until(() => chats.get(chat.id)?.executions.length === 2, 'the second execution');
        await chats.exited(chat.id);
        assert.equal(chats.get(chat.id)?.id, chat.id);
        const inits = chats.events(chat.id).filter((e) => e.kind === 'init');
        assert.equal(inits.length, 2);
        const expected = driver.sessionIds === 'imposed' ? chat.id : chats.get(chat.id)?.nativeSessionId;
        assert.ok(expected, 'there is a session id to compare');
        assert.ok(inits.every((e) => e.init?.sessionId === expected), 'every process reports the same session');
      },
      'resume',
    );

    scenario(
      harness,
      'fork makes a new id that records its source',
      async ({ chats, driver }) => {
        const source = chats.start({ prompt: harness.script.turn, name: 'conformance', keepAlive: false });
        await chats.exited(source.id);
        const summary = chats.get(source.id);
        assert.ok(summary);
        const copy = chats.fork(source.id, { prompt: harness.script.turn }, { cwd: summary.cwd, name: summary.name, model: summary.model });
        assert.notEqual(copy.id, source.id);
        assert.equal(copy.derivedFrom?.chatId, source.id);
        await until(() => chats.events(copy.id).some((e) => e.kind === 'init'), 'the copy to start');
        const copyInit = chats.events(copy.id).find((e) => e.kind === 'init')?.init?.sessionId;
        if (driver.sessionIds === 'imposed') assert.equal(copyInit, copy.id);
        else assert.notEqual(copyInit, chats.get(source.id)?.nativeSessionId, 'the copy has an id of its own');
      },
      'fork',
    );

    // 4
    scenario(
      harness,
      'interrupt ends the turn with cause stopped, keeps the process and withdraws a pending permission request',
      async ({ chats, broker, results }) => {
        const chat = chats.start({ prompt: harness.script.ask('Bash'), name: 'conformance', permissionPrompts: 'host' });
        await until(() => broker.list(chat.id)[0], 'the request');
        const pid = chats.get(chat.id)?.pid;
        assert.ok(pid);
        await chats.interrupt(chat.id);
        await until(() => chats.get(chat.id)?.status === 'idle', 'the interrupted turn');
        assert.equal(results.at(-1)?.cause, 'stopped');
        assert.equal(resultOf(chats.events(chat.id))[0]?.outcome?.cause, 'stopped');
        assert.equal(chats.get(chat.id)?.pid, pid, 'the same process');
        assert.ok(alive(pid), 'the process is still up');
        assert.deepEqual(broker.list(chat.id), [], 'nothing is left pending');
      },
      'interrupt',
    );

    // 5
    scenario(
      harness,
      'setModel and the permission mode switch a live process',
      async ({ chats }) => {
        const chat = chats.start({ prompt: harness.script.turn, name: 'conformance' });
        await until(() => chats.get(chat.id)?.status === 'idle', 'the first turn');
        const pid = chats.get(chat.id)?.pid;
        assert.ok(pid);
        await chats.updateSettings(chat.id, { permissionMode: 'plan' });
        await until(() => chats.get(chat.id)?.permissionMode === 'plan', 'the mode');
        await chats.updateSettings(chat.id, { model: 'conformance-model' });
        assert.equal(chats.get(chat.id)?.model, 'conformance-model');
        assert.equal(chats.get(chat.id)?.pid, pid, 'no new process');
        assert.equal(chats.get(chat.id)?.executions.length, 1);
      },
      'setModel',
    );

    // 6
    for (const decision of ['allow', 'deny'] as const) {
      scenario(
        harness,
        `with interactive permissions, ${decision} reaches the agent`,
        async ({ chats, broker, results }) => {
          const chat = chats.start({ prompt: harness.script.ask('Bash'), name: 'conformance', permissionPrompts: 'host' });
          const asked = await until(() => broker.list(chat.id)[0], 'the request');
          const answer: PermissionDecision = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'not now' };
          broker.answer(asked.id, answer);
          await until(() => results.length > 0, 'the turn to end');
          assert.equal(harness.decision(results[0]?.result ?? ''), decision);
        },
        'interactivePermissions',
      );
    }

    scenario(
      harness,
      'an unexpected request from the agent is answered, never left pending',
      async ({ chats, broker, results }) => {
        const chat = chats.start({ prompt: harness.script.unexpected, name: 'conformance', permissionPrompts: 'host' });
        await until(() => results.length > 0, 'the agent to get an answer and end the turn');
        assert.equal(chats.get(chat.id)?.pendingPrompts, 0);
        assert.deepEqual(broker.list(chat.id), []);
      },
      'interactivePermissions',
    );

    // 7
    scenario(
      harness,
      'structured output returns the object and streams it as it is written',
      async ({ chats, structured, results }) => {
        const chat = chats.start({ prompt: harness.script.structured, name: 'conformance', keepAlive: false, jsonSchema: { type: 'object' } });
        await chats.exited(chat.id);
        assert.deepEqual(results[0]?.structuredOutput, harness.structuredResult);
        assert.ok(structured.length >= 2, 'it streamed in more than one piece');
        assert.deepEqual(JSON.parse(structured.at(-1) ?? 'null'), harness.structuredResult);
        assert.ok(structured[0] && structured[0].length < (structured.at(-1) ?? '').length, 'the first piece is less than the whole');
        assert.deepEqual(resultOf(chats.events(chat.id))[0]?.outcome?.structuredOutput, harness.structuredResult);
      },
      'structuredOutput',
    );

    // 8
    scenario(
      harness,
      'a spent budget ends with cause budget',
      async ({ chats, results }) => {
        const chat = chats.start({ prompt: harness.script.budget, name: 'conformance', keepAlive: false, maxBudgetUsd: 1 });
        await chats.exited(chat.id);
        assert.equal(results[0]?.isError, true);
        assert.equal(results[0]?.cause, 'budget');
        assert.equal(resultOf(chats.events(chat.id))[0]?.outcome?.cause, 'budget');
      },
      'budgetLimit',
    );

    scenario(
      harness,
      'a rate limit ends with cause rate-limit and sets rateLimited',
      async ({ chats, results, rotations }) => {
        const chat = chats.start({ prompt: harness.script.rateLimit, name: 'conformance', keepAlive: false });
        await chats.exited(chat.id);
        assert.equal(results[0]?.cause, 'rate-limit');
        assert.equal(resultOf(chats.events(chat.id))[0]?.outcome?.cause, 'rate-limit');
        // What `rateLimited` is for: a rotation is asked for on it
        assert.deepEqual(rotations, [chat.id]);
      },
      'rateLimitWindows',
    );

    // 9
    scenario(harness, 'stderr lines are stderr events, and a non-protocol stdout line is other', async ({ chats }) => {
      const chat = chats.start({ prompt: harness.script.noisy, name: 'conformance', keepAlive: false });
      await chats.exited(chat.id);
      const events = chats.events(chat.id);
      assert.ok(events.some((e) => e.kind === 'stderr' && e.text === harness.stderrText), 'the stderr line');
      assert.ok(
        events.some((e) => e.kind === 'other' && typeof e.text === 'string' && e.text.length > 0),
        'the unreadable line',
      );
    });

    // 10
    scenario(harness, 'every event validates against the neutral RunEvent, with no key outside it', async ({ chats, broker }) => {
      const ids = [
        chats.start({ prompt: harness.script.turn, name: 'a', keepAlive: false }).id,
        chats.start({ prompt: harness.script.noisy, name: 'b', keepAlive: false }).id,
        chats.start({ prompt: harness.script.delegating, name: 'c', keepAlive: false }).id,
        chats.start({ prompt: harness.script.budget, name: 'd', keepAlive: false, maxBudgetUsd: 1 }).id,
      ];
      const asking = chats.start({ prompt: harness.script.ask('Bash'), name: 'e', permissionPrompts: 'host' });
      await until(() => broker.list(asking.id)[0], 'the request');
      await chats.interrupt(asking.id);
      await until(() => chats.get(asking.id)?.status === 'idle', 'the interrupted turn');
      for (const id of ids) await chats.exited(id);
      let seen = 0;
      let last = 0;
      for (const id of [...ids, asking.id]) {
        for (const event of chats.events(id)) {
          seen++;
          const keys = Object.keys(event);
          assert.deepEqual(
            keys.filter((k) => !EVENT_KEYS.has(k)),
            [],
            `event "${event.kind}" has a key outside RunEvent`,
          );
          assert.ok(KINDS.includes(event.kind), `unknown kind ${String(event.kind)}`);
          assert.equal(typeof event.seq, 'number');
          assert.ok(Number.isFinite(Date.parse(event.ts)), 'ts is a time');
          if (event.kind === 'message') assert.ok(event.entry, 'a message carries its entry');
          if (event.kind === 'status') assert.ok(event.status, 'a status event carries its status');
          if (event.kind === 'init') assert.ok(event.init?.sessionId, 'an init carries the session');
          if (event.kind === 'result') assert.ok(event.outcome, 'a result carries its outcome');
          if (event.kind === 'task') assert.ok(event.task?.change && event.task.taskKind, 'a task carries its change');
          if (event.kind !== 'notice') assert.equal(event.data, undefined, 'raw data is for notices only');
        }
        last = Math.max(last, chats.events(id).length);
      }
      assert.ok(seen > 10 && last > 0, 'there were events to check');
      assert.ok(
        ids.some((id) => chats.events(id).some((e) => e.kind === 'task')),
        'the delegating turn produced task events',
      );
    });

    // 11
    describe('translatePolicy', () => {
      const driver = harness.driver(tempConfig());
      const baseline = driver.translatePolicy(BASE);
      test('the policy that says nothing gives no rules', () => {
        assert.deepEqual(baseline.rules.allowedTools, []);
        assert.deepEqual(baseline.rules.disallowedTools, []);
        assert.deepEqual(baseline.unsupported, []);
      });
      for (const { part, policy } of PROBES) {
        test(`enforces or lists as unsupported: ${part} ${JSON.stringify(policy).slice(0, 80)}`, () => {
          const translation = driver.translatePolicy(policy);
          assert.deepEqual(driver.translatePolicy(policy), translation, 'pure: the same policy gives the same rules');
          const listed = translation.unsupported.some((u) => u === part || u.startsWith(`${part}.`) || part.startsWith(`${u}.`));
          const { allowedTools, disallowedTools, tools } = translation.rules;
          const inRules = allowedTools.length > 0 || disallowedTools.length > 0 || (tools?.length ?? 0) > 0;
          const inSettings = (translation.settings ?? []).some((s) => s.part === part || part.startsWith(`${s.part}.`));
          const inHost = (translation.host ?? []).some((h) => h === part || part.startsWith(`${h}.`));
          assert.ok(listed || inRules || inSettings || inHost, `${part} is not in rules, settings or host, and not listed as unsupported`);
        });
      }
      test('gitPush deny is enforced: a driver that cannot enforce it fails', () => {
        const translation = driver.translatePolicy({ ...BASE, gitPush: 'deny' });
        assert.ok(!translation.unsupported.includes('gitPush'), 'gitPush deny may not be listed as unsupported');
        const newRules = translation.rules.disallowedTools.filter((rule) => !baseline.rules.disallowedTools.includes(rule));
        const inSettings = (translation.settings ?? []).some((s) => s.part === 'gitPush');
        assert.ok(newRules.length > 0 || inSettings, 'gitPush deny is a new rule or a native setting');
        if (translation.host?.includes('commands')) {
          assert.ok(harness.script.gitPush, 'a driver that leaves commands to the judge must script case 16');
        }
      });
    });

    // 12
    test('models() is not empty, and every tier the driver claims resolves', () => {
      const driver = harness.driver(tempConfig());
      const models = driver.models();
      assert.ok(models.length > 0, 'the picker has models');
      assert.equal(new Set(models.map((m) => m.value)).size, models.length, 'values are unique');
      for (const tier of new Set(models.flatMap((m) => (m.tier ? [m.tier] : [])))) {
        const choices = models.filter((m) => m.tier === tier && !m.disabled && m.value.length > 0);
        assert.ok(choices.length > 0, `the ${tier} tier resolves to a model that can run`);
      }
    });

    // 13
    scenario(harness, 'stop leaves no process behind', async ({ chats, driver }) => {
      const chat = chats.start({ prompt: harness.script.ask('Bash'), name: 'conformance', permissionPrompts: 'host' });
      const pid = await until(() => chats.get(chat.id)?.pid, 'the process');
      await until(() => chats.events(chat.id).some((e) => e.kind === 'init'), 'the session to start');
      assert.ok(driver.sessionHolders(chat.id).includes(pid) || driver.liveSessions().some((s) => s.sessionId === chat.id), 'the driver sees the session while it runs');
      chats.stop(chat.id);
      await chats.exited(chat.id);
      await until(() => !alive(pid), 'the process to go');
      await until(() => driver.sessionHolders(chat.id).length === 0 && !driver.liveSessions().some((s) => s.sessionId === chat.id), 'the driver to stop seeing it');
    });

    // 15
    scenario(
      harness,
      'a turn sent before the handshake completes is delivered once, after it',
      async ({ chats }) => {
        const first = harness.script.slowHandshake;
        assert.ok(first);
        const chat = chats.start({ prompt: first, name: 'conformance' });
        chats.send(chat.id, harness.script.turn);
        await until(() => resultOf(chats.events(chat.id)).length >= 2 && chats.get(chat.id)?.status === 'idle', 'both turns to end');
        await new Promise((r) => setTimeout(r, 300));
        const events = chats.events(chat.id);
        assert.equal(resultOf(events).length, 2, 'each turn was delivered exactly once');
        const initAt = events.findIndex((e) => e.kind === 'init');
        const secondResult = events.map((e) => e.kind).lastIndexOf('result');
        assert.ok(initAt >= 0 && initAt < secondResult, 'the second turn ran after the session started');
      },
      undefined,
      !harness.script.slowHandshake && 'the harness has no slow handshake',
    );

    // 16
    scenario(
      harness,
      'a git push the policy leaves to the judge is denied without reaching the broker',
      async ({ chats, broker, results }) => {
        const script = harness.script.gitPush;
        assert.ok(script);
        const chat = chats.start({ prompt: script, name: 'conformance', keepAlive: false, permissionPrompts: 'host', toolConfig: { preset: null, allowedTools: [], disallowedTools: [], mcp: null, policy: GIT_PUSH_POLICY } });
        await chats.exited(chat.id);
        assert.deepEqual(broker.list(chat.id), [], 'nothing reached the broker');
        assert.equal(harness.decision(results[0]?.result ?? ''), 'deny', 'the agent was told no');
      },
      undefined,
      hostSkip(harness),
    );

    // 17
    scenario(
      harness,
      'interrupt answers a pending permission request before the turn ends',
      async ({ chats, broker, results }) => {
        const script = harness.script.holdUntilCancel;
        assert.ok(script);
        const chat = chats.start({ prompt: script, name: 'conformance', permissionPrompts: 'host' });
        await until(() => broker.list(chat.id)[0], 'the request');
        await chats.interrupt(chat.id);
        await until(() => results.length > 0, 'the held turn to end');
        assert.equal(results.at(-1)?.cause, 'stopped');
        assert.deepEqual(broker.list(chat.id), []);
      },
      'interrupt',
      !harness.script.holdUntilCancel && 'the harness has no request held until cancel',
    );

    // 18
    scenario(
      harness,
      'an authentication failure at session start ends failed with auth-required',
      async ({ chats }) => {
        const script = harness.script.signedOut;
        assert.ok(script);
        const chat = chats.start({ prompt: script, name: 'conformance', keepAlive: false });
        await chats.exited(chat.id);
        const done = chats.get(chat.id);
        assert.equal(done?.status, 'failed', 'the chat is not left starting');
        assert.match(done?.error ?? '', /auth-required/);
      },
      undefined,
      !harness.script.signedOut && 'the harness has no signed-out session',
    );

    // 19
    scenario(
      harness,
      'transcripts lists the session the turn created, with its entries, by native id',
      async ({ chats, driver }) => {
        const store = driver.transcripts;
        assert.ok(store);
        const chat = chats.start({ prompt: harness.script.turn, name: 'conformance', keepAlive: false });
        await chats.exited(chat.id);
        const native = chats.get(chat.id)?.nativeSessionId ?? chat.id;
        const listed = await store.list();
        assert.ok(listed.some((t) => t.id === native), 'the session is listed');
        const page = await store.page(native);
        assert.ok(page && page.entries.length > 0, 'its entries can be read');
      },
      undefined,
      transcriptsSkip(harness),
    );

    // 14
    describe('a driver whose manifest lacks a capability is refused the request that needs it', () => {
      /** The same driver behind a registry whose manifest lacks `capability`: a double that cannot do it */
      function without(capability: ProviderCapability) {
        const config = tempConfig();
        const driver = harness.driver(config);
        const db = new Db(config);
        const chats = new ChatManager(config, db, [driver]);
        const manifest = { ...harness.manifest, capabilities: harness.manifest.capabilities.filter((c) => c !== capability) };
        (chats as unknown as { providers: ProviderRegistry }).providers = new ProviderRegistry([manifest], [driver]);
        const service = new ChatService({ config, runtime: chats } as unknown as ChatServiceDeps);
        return { service, close: () => (chats.stopAll(), db.close()) };
      }
      const cases: Array<[ProviderCapability, string, (s: ChatService) => Promise<unknown>]> = [
        ['structuredOutput', 'a JSON schema', (s) => s.create({ prompt: 'x', jsonSchema: { type: 'object' } })],
        ['worktreeFlag', 'a worktree', (s) => s.create({ prompt: 'x', worktree: 'w' })],
        ['multiAccount', 'a pinned account', (s) => s.create({ prompt: 'x', account: 'someone' })],
        ['budgetLimit', 'a budget', (s) => s.create({ prompt: 'x', maxBudgetUsd: 1 })],
        ['interactivePermissions', 'host prompts', (s) => s.create({ prompt: 'x', permissionPrompts: 'host' })],
        ['interrupt', 'an interrupt', (s) => s.interrupt('any')],
        ['setModel', 'a model switch', (s) => s.updateSettings('any', { model: 'other' })],
      ];
      for (const [capability, what, call] of cases) {
        test(`${what} needs ${capability}`, { skip: declared.has(capability) ? false : `${harness.manifest.id} does not declare ${capability}` }, async () => {
          const { service, close } = without(capability);
          try {
            await assert.rejects(call(service), (err: unknown) => err instanceof CapabilityRefusal && err.capability === capability && err.statusCode === 400);
          } finally {
            close();
          }
        });
      }
    });
  });
}
