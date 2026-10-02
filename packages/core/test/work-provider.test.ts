import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ProviderLimit, ProviderStatus, ProvidersSettings, ToolPolicy } from '@agentry/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import type { ProviderPoints } from '../src/decisions/provider-points.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { CodexDriver } from '../src/providers/codex/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { NoProviderError, WorkProviders, type StartInput } from '../src/work-provider.ts';
import { stagePolicy } from '../src/flow.ts';
import { tempConfig } from './helpers.ts';

// Where automated work starts: the candidates a move reads, with `from: null`, and `provider.pick` among them.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus =>
  ({ id, label: id, state: 'ready', reason: null, version: '1', compatibleRange: '*', binaryPath: '/bin/x', configHome: null, account: null, capabilities: [], checkedAt: new Date().toISOString(), ...over }) as ProviderStatus;

const policy: ToolPolicy = stagePolicy('work', undefined, { documentsPath: 'docs', checks: [] }).policy;
const input = (over: Partial<StartInput> = {}): StartInput => ({
  kind: 'flow-run',
  subjectKind: 'flow_run',
  subjectId: 'run-1',
  projectId: null,
  title: 'Fix the cart',
  model: 'sonnet',
  needs: ['structuredOutput'],
  policy,
  ...over,
});

function rig(o: { statuses?: ProviderStatus[] | null; mapped?: boolean; order?: string[]; pick?: { provider: string; decisionId: string } | null; stance?: 'off' | 'active' } = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const runtime = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE), new CodexDriver(FAKE_CODEX)]);
  const settings: ProvidersSettings = defaultProvidersSettings(['claude-code', 'codex']);
  if (o.order) settings.order = o.order;
  settings.rotation = {
    ...defaultRotationSettings(),
    modelMap: o.mapped === false ? [] : [{ from: { provider: 'claude-code', model: 'sonnet' }, to: { provider: 'codex', model: '' }, origin: 'person', at: new Date().toISOString() }],
  };
  const statuses = o.statuses === undefined ? [status('claude-code'), status('codex')] : o.statuses;
  const picks: unknown[] = [];
  const work = new WorkProviders({
    runtime,
    settings: () => settings,
    projectProviders: () => null,
    statuses: async () => statuses ?? [],
    known: () => statuses,
    decisions: o.stance === 'active' ? ({ effective: () => ({ mode: 'active', limited: false }), ask: async () => null } as never) : null,
    points:
      o.stance === 'active'
        ? ({
            pick: async (_stance: string, subject: unknown) => {
              picks.push(subject);
              return o.pick ?? null;
            },
          } as unknown as ProviderPoints)
        : null,
  });
  return { work, runtime, picks, close: () => (runtime.stopAll(), db.close()) };
}

test('work starts on the first provider of the order that can take it, with its model there', async () => {
  const { work, close } = rig();
  assert.deepEqual(await work.choose(input()), { provider: 'claude-code', model: 'sonnet', effort: null, decisionId: null });
  close();
  // With Codex first and a mapping for the model, it starts there, on the mapped model
  const codexFirst = rig({ order: ['codex', 'claude-code'] });
  const choice = await codexFirst.work.choose(input());
  assert.equal(choice.provider, 'codex');
  codexFirst.close();
});

test('a provider that cannot enforce the policy, or has no counterpart for the model, is passed over', async () => {
  // Codex first but the model has no counterpart there: Claude takes it
  const unmapped = rig({ order: ['codex', 'claude-code'], mapped: false });
  assert.equal((await unmapped.work.choose(input())).provider, 'claude-code');
  unmapped.close();
  // A graph's own rules are written for Claude Code, so nothing else can take them
  const native = rig({ order: ['codex', 'claude-code'] });
  assert.equal((await native.work.choose(input({ policy: null, nativeRules: true }))).provider, 'claude-code');
  // A budget needs a provider that reports cost
  assert.equal((await native.work.choose(input({ needs: ['structuredOutput', 'budgetLimit'] }))).provider, 'claude-code');
  native.close();
});

test('with no provider ready the work cannot start and the reasons are named; one only at its limit still starts there', async () => {
  const none = rig({ statuses: [status('claude-code', { state: 'signed-out', reason: 'missing-credentials' }), status('codex', { state: 'not-installed', reason: 'binary-not-found' })] });
  await assert.rejects(none.work.choose(input()), (err: unknown) => err instanceof NoProviderError && /claude-code: not-ready/.test(err.message));
  assert.throws(() => none.work.chooseNow(input()), NoProviderError);
  none.close();

  // The only provider that could take it is exhausted: the rotation waits for its reset rather than the run never starting
  const limit: ProviderLimit = { provider: 'claude-code', state: 'exhausted', window: '5h', utilization: 1, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), windows: {}, observedAt: new Date().toISOString(), source: 'stream' } as ProviderLimit;
  const exhausted = rig({ statuses: [status('claude-code', { limit }), status('codex', { state: 'not-installed', reason: 'binary-not-found' })] });
  const choice = await exhausted.work.choose(input());
  assert.equal(choice.provider, 'claude-code');
  assert.equal(choice.model, 'sonnet');
  exhausted.close();
});

test('before the providers have been read, a synchronous start keeps the default it always had', () => {
  const unread = rig({ statuses: null });
  assert.equal(unread.work.chooseNow(input()), null);
  unread.close();
  const read = rig();
  assert.equal(read.work.chooseNow(input())?.provider, 'claude-code');
  read.close();
});

test('provider.pick chooses among the candidates and nothing outside them', async () => {
  const picked = rig({ order: ['claude-code', 'codex'], stance: 'active', pick: { provider: 'codex', decisionId: 'd1' } });
  assert.equal(picked.work.wantsPick(input()), true);
  const choice = await picked.work.choose(input());
  assert.deepEqual([choice.provider, choice.decisionId], ['codex', 'd1']);
  assert.equal((picked.picks[0] as { candidates: unknown[] }).candidates.length, 2);
  picked.close();

  // An answer that names a provider that was not a candidate is dropped: the first candidate starts the work
  const stray = rig({ stance: 'active', pick: { provider: 'gemini', decisionId: 'd2' } });
  assert.equal((await stray.work.choose(input())).provider, 'claude-code');
  stray.close();

  // With one candidate there is nothing to choose between, and nothing is asked
  const single = rig({ stance: 'active', mapped: false });
  assert.equal((await single.work.choose(input())).provider, 'claude-code');
  assert.equal(single.picks.length, 0);
  single.close();
  assert.equal(rig().work.wantsPick(input()), false);
});

test('a provider that cannot prove its sign-in is never a candidate for automated work, however the order puts it', async () => {
  // Gemini and Copilot have no probe that spends nothing: a person's chat may try them, automated work may not
  const unproven = (id: string) => status(id, { state: 'unknown', reason: 'no-probe' });
  const claude = rig({ order: ['gemini', 'claude-code'], statuses: [status('claude-code'), status('codex', { state: 'not-installed', reason: 'binary-not-found' }), unproven('gemini')] });
  assert.equal((await claude.work.choose(input())).provider, 'claude-code');
  claude.close();

  const only = rig({ order: ['gemini', 'copilot'], statuses: [status('claude-code', { state: 'signed-out', reason: 'missing-credentials' }), unproven('gemini'), unproven('copilot')] });
  await assert.rejects(only.work.choose(input()), (err: unknown) => err instanceof NoProviderError && /gemini: (not-ready|not-in-order|disabled|no-driver)/.test(err.message));
  only.close();
});
