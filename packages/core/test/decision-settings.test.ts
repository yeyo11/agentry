import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS, parseDecisionSettings, parseProjectDecisions } from '../src/decisions/settings.ts';
import { loadConfig } from '../src/paths.ts';
import { defaultProjectSettings, parseProjectSettings } from '../src/project-settings.ts';

function stores() {
  const root = mkdtempSync(join(tmpdir(), 'agentry-decisions-'));
  const config = loadConfig({ CLAUDE_BIN: '/nonexistent/claude', CLAUDE_CONFIG_DIR: join(root, 'claude'), AGENTRY_WORKSPACE_DIR: join(root, 'ws'), AGENTRY_DATA_DIR: join(root, 'data') });
  const credentials = new DecisionCredentialStore(config);
  return { config, credentials, settings: new DecisionSettingsStore(config, credentials), dir: config.dataDir };
}

const body = () => ({ ...structuredClone(DEFAULT_DECISION_SETTINGS) });

test('an install that saved nothing reads as the defaults: cli, haiku at low effort, nothing on', () => {
  const { settings } = stores();
  assert.deepEqual(settings.get(), { ...DEFAULT_DECISION_SETTINGS, jev: { model: 'jev-1.13.0', keySet: false, keyHint: null } });
  assert.equal(settings.get().cli.effort, 'low');
});

test('PUT validates the whole document and refuses a bad value', () => {
  assert.throws(() => parseDecisionSettings({ ...body(), provider: 'gpt' }), /provider/);
  assert.throws(() => parseDecisionSettings({ ...body(), cli: { model: 'haiku', effort: 'turbo', maxCostUsd: 0.02 } }), /effort/);
  assert.throws(() => parseDecisionSettings({ ...body(), cli: { model: 'haiku', effort: 'low', maxCostUsd: 50 } }), /maxCostUsd/);
  assert.throws(() => parseDecisionSettings({ ...body(), historyDays: 0 }), /historyDays/);
  assert.throws(() => parseDecisionSettings({ ...body(), historyDays: 366 }), /historyDays/);
  assert.throws(() => parseDecisionSettings({ ...body(), points: { 'flow.bounce': { mode: 'active', threshold: 0.4 } } }), /threshold/);
  assert.throws(() => parseDecisionSettings({ ...body(), points: { 'nope.point': { mode: 'off' } } }), /unknown decision point/);
});

test('saving keeps the consent already given and ignores one in the body', async () => {
  const { settings } = stores();
  await settings.setConsent('flow.bounce', { granted: true, stateVersion: 2, providers: ['cli'] });
  const forged = { at: new Date().toISOString(), stateVersion: 9, providers: ['jev'] };
  const saved = await settings.set({
    ...body(),
    points: { 'flow.bounce': { mode: 'shadow', threshold: 0.9, consent: null }, 'flow.restart': { mode: 'active', threshold: 0.85, consent: forged } },
  });
  assert.equal(saved.points['flow.bounce']?.mode, 'shadow');
  assert.equal(saved.points['flow.bounce']?.consent?.stateVersion, 2);
  assert.equal(saved.points['flow.restart']?.consent, null);
});

test('consent names the providers it covers and can be withdrawn', async () => {
  const { settings } = stores();
  const granted = await settings.setConsent('memory.triage', { granted: true, stateVersion: 1, providers: ['cli', 'cli'] });
  assert.deepEqual(granted.points['memory.triage']?.consent?.providers, ['cli']);
  assert.equal(granted.points['memory.triage']?.mode, 'off');
  const withdrawn = await settings.setConsent('memory.triage', { granted: false, stateVersion: 1, providers: [] });
  assert.equal(withdrawn.points['memory.triage']?.consent, null);
  await assert.rejects(settings.setConsent('nope', { granted: true, stateVersion: 1, providers: ['cli'] }), /unknown decision point/);
});

test('a hand-edited file falls back per field and per point', () => {
  const { settings, dir } = stores();
  writeFileSync(join(dir, 'decisions.json'), JSON.stringify({ provider: 'jev', cli: { model: 'bad model!', effort: 'low', maxCostUsd: 1 }, historyDays: 7, points: { 'flow.bounce': { mode: 'shadow' }, 'flow.restart': { mode: 'sideways' } } }));
  const read = settings.get();
  assert.equal(read.provider, 'jev');
  assert.equal(read.historyDays, 7);
  assert.equal(read.cli.model, 'haiku');
  assert.equal(read.points['flow.bounce']?.mode, 'shadow');
  assert.equal(read.points['flow.restart'], undefined);
});

test('the key is stored with mode 0600, reported only by its last four characters, and removable', async () => {
  const { credentials, settings, dir } = stores();
  const status = await credentials.set({ key: '  jev_secret_abcd1234  ' });
  assert.deepEqual(status, { keySet: true, keyHint: '1234' });
  assert.equal(statSync(join(dir, 'decision-credentials.json')).mode & 0o777, 0o600);
  assert.equal(credentials.getKey(), 'jev_secret_abcd1234');
  assert.equal(JSON.stringify(settings.get()).includes('secret'), false);
  assert.equal(readFileSync(join(dir, 'decision-credentials.json'), 'utf8').includes('jev_secret_abcd1234'), true);
});

test('a rejected key is not echoed, and clearing removes it', async () => {
  const { credentials, config } = stores();
  await assert.rejects(credentials.set({ key: 'has space inside' }), (err: Error) => !err.message.includes('space'));
  await assert.rejects(credentials.set({ key: '' }), /key/);
  await credentials.set({ key: 'abcdefgh' });
  assert.equal(new DecisionCredentialStore(config).getKey(), 'abcdefgh');
  credentials.clear();
  assert.equal(new DecisionCredentialStore(config).status().keySet, false);
});

test('project overrides: only project-scope points, no consent', () => {
  assert.deepEqual(parseProjectDecisions({ provider: 'jev', points: { 'flow.bounce': { mode: 'shadow', threshold: 0.9 } } }), { provider: 'jev', points: { 'flow.bounce': { mode: 'shadow', threshold: 0.9 } } });
  assert.throws(() => parseProjectDecisions({ points: { 'palette.intent': { mode: 'active' } } }), /globally/);
  assert.throws(() => parseProjectDecisions({ points: { 'flow.bounce': { mode: 'active', consent: { at: 'x' } } } }), /consent/);
  assert.throws(() => parseProjectDecisions({ provider: 'nope' }), /provider/);
});

test('the provider points ship off, and only the model mapping is global', () => {
  const { settings } = stores();
  // No entry is the same as `off`: nothing is stored until a person sets a mode
  for (const id of ['provider.on-limit', 'provider.pick', 'provider.model-map'] as const) assert.equal(settings.get().points[id], undefined);
  assert.throws(() => parseProjectDecisions({ points: { 'provider.model-map': { mode: 'active' } } }), /globally/);
  assert.doesNotThrow(() => parseProjectDecisions({ points: { 'provider.on-limit': { mode: 'shadow' }, 'provider.pick': { mode: 'shadow' } } }));
});

test('ProjectSettings carries the decisions field through parseProjectSettings', () => {
  const base = defaultProjectSettings('ABC');
  assert.deepEqual(parseProjectSettings({ ...base, decisions: { provider: 'jev', points: { 'flow.bounce': { mode: 'shadow' } } } }).decisions, {
    provider: 'jev',
    points: { 'flow.bounce': { mode: 'shadow' } },
  });
  assert.equal(parseProjectSettings({ ...base, decisions: {} }).decisions, undefined);
  assert.throws(() => parseProjectSettings({ ...base, decisions: { points: { 'palette.intent': { mode: 'active' } } } }), /globally/);
});
