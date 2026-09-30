import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DecisionAnswer, FlowMemoryProposal } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { JOURNAL_HANDOFF_BYTES, JournalService } from '../src/journal.ts';
import { MemoryProposalService } from '../src/memory-proposals.ts';
import { MemoryStore } from '../src/memory.ts';
import { WorkItemService } from '../src/work-items.ts';
import { choiceOf, decisionRig, noulOf, scoreOf } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// The knowledge points (memory.triage, journal.relevance, board.triage) over a real store and the
// real engine; only the provider is scripted. Each has the four tests of the plan: off changes
// nothing and asks nobody, shadow records and today's behaviour decides, active acts only where the
// point may, and an unavailable provider (no quota included) is today's behaviour at once.

function setup() {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const rig = decisionRig(db, config);
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null), decisions: rig.engine });
  const journal = new JournalService({ db, decisions: rig.engine });
  const memory = new MemoryStore(config);
  const projectDir = mkdtempSync(join(tmpdir(), 'agentry-points-'));
  const proposals = new MemoryProposalService({ db, journal, memory, project: (id) => (id === 'p1' ? { path: projectDir, memoryKey: 'p1-key' } : null), decisions: rig.engine });
  return { db, rig, items, journal, proposals };
}
type Setup = ReturnType<typeof setup>;

const AGENT = { kind: 'agent', role: 'developer' } as const;
const propose = (text: string): FlowMemoryProposal => ({ target: { kind: 'journal', file: null, section: null }, text, reason: 'seen twice' });
const orderOf = (s: Setup) => s.proposals.list('p1').map((p) => p.text);

// ---------- memory.triage ----------

/** Scores a proposal by its text: the state is what the engine sent */
const byText =
  (levels: Record<string, string>, confidence: number | null = null) =>
  (request: { state: Record<string, unknown> }): Record<string, DecisionAnswer> => ({
    usefulness: scoreOf(levels[String(request.state.proposal)] ?? 'medium', confidence),
  });
const LEVELS = { 'a duplicate of an old entry': 'duplicate', 'never mock the database': 'high', 'the port is 8799': 'low' };
const ARRIVAL = ['the port is 8799', 'never mock the database', 'a duplicate of an old entry'];
const proposeAll = (s: Setup) => {
  for (const text of [...ARRIVAL].reverse()) s.proposals.propose('p1', propose(text), { proposedBy: AGENT });
};

test('memory.triage off: the list keeps its order and no provider is asked', async () => {
  const s = setup();
  s.rig.provider.script = byText(LEVELS);
  proposeAll(s);
  assert.deepEqual(orderOf(s), ARRIVAL);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.rig.provider.calls.length, 0);
  assert.equal(s.rig.rows('memory.triage').length, 0);
});

test('memory.triage shadow: a row is recorded per proposal and the list stays in arrival order', async () => {
  const s = setup();
  await s.rig.configure('memory.triage', 'shadow');
  s.rig.provider.script = byText(LEVELS);
  proposeAll(s);
  const rows = await s.rig.rowsAfter('memory.triage', 3);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.mode === 'shadow' && r.status === 'answered' && !r.acted && !r.visible && r.subjectKind === 'memory_proposal'));
  assert.deepEqual(new Set(rows.map((r) => r.subjectId)), new Set(s.proposals.list('p1').map((p) => p.id)));
  assert.deepEqual(orderOf(s), ARRIVAL);
});

test('memory.triage active: pending proposals are ordered by usefulness, and nothing is hidden or decided', async () => {
  const s = setup();
  await s.rig.configure('memory.triage', 'active');
  // The CLI has no confidence, and a suggestion is still prepared: an answer is enough
  s.rig.provider.script = byText(LEVELS, null);
  proposeAll(s);
  await s.rig.rowsAfter('memory.triage', 3);
  assert.deepEqual(orderOf(s), ['never mock the database', 'the port is 8799', 'a duplicate of an old entry']);
  assert.ok(s.proposals.list('p1').every((p) => p.status === 'pending'));
  // A decided proposal keeps its place; the pending ones share the rest
  const decided = s.proposals.list('p1').find((p) => p.text === 'the port is 8799');
  assert.ok(decided);
  s.proposals.reject(decided.id);
  assert.equal(s.proposals.list('p1', 'pending').length, 2);
  assert.equal(s.proposals.list('p1').length, 3);
  // Turning it off puts the arrival order back
  await s.rig.configure('memory.triage', 'off');
  assert.deepEqual(orderOf(s), ARRIVAL);
});

test('memory.triage unavailable, no quota included: proposals are recorded at once, in order, with an unavailable row', async () => {
  const s = setup();
  await s.rig.configure('memory.triage', 'active');
  s.rig.provider.script = () => ({ status: 'unavailable', reason: 'no-quota', latencyMs: 2 });
  const started = Date.now();
  proposeAll(s);
  assert.ok(Date.now() - started < 500, 'the proposer never waits for the engine');
  assert.deepEqual(orderOf(s), ARRIVAL);
  const rows = await s.rig.rowsAfter('memory.triage', 3);
  assert.ok(rows.every((r) => r.status === 'unavailable' && r.unavailable === 'no-quota' && !r.acted));
  s.rig.provider.up = false;
  s.proposals.propose('p1', propose('another'), { proposedBy: AGENT });
  assert.equal(s.proposals.list('p1').length, 4);
});

// ---------- journal.relevance ----------

const TOPIC = { title: 'Add the payments webhook', criteria: ['Retries are idempotent'] };
const scoreEntries =
  (confidence: number | null = 0.95) =>
  (request: { state: Record<string, unknown> }): Record<string, DecisionAnswer> => {
    const out: Record<string, DecisionAnswer> = {};
    for (const e of request.state.entries as Array<{ id: string; lines: string }>) out[e.id] = scoreOf(e.lines.includes('idempotent') ? 'essential' : 'irrelevant', confidence);
    return out;
  };
const seedJournal = (s: Setup) => {
  for (const text of ['old: the webhook must be idempotent', 'middle: the button colour', 'new: the logo']) s.journal.create('p1', { kind: 'decision', text });
};
/** A handoff's block carries a random id, so two handoffs are compared with it masked */
const same = (a: { text: string; entries: number; bytes: number }) => ({ ...a, text: a.text.replace(/id="[0-9a-f]+"/g, 'id="x"') });
/** Where the three seeded entries stand in a handoff: idempotent (oldest), button, logo (newest) */
const placesIn = (text: string) => ['idempotent', 'button', 'logo'].map((w) => text.indexOf(w)) as [number, number, number];

test('journal.relevance off: the handoff is the newest first and no provider is asked', async () => {
  const s = setup();
  s.rig.provider.script = scoreEntries();
  seedJournal(s);
  const handed = await s.journal.handoffFor('p1', TOPIC);
  assert.deepEqual(same(handed), same(s.journal.handoff('p1')));
  const [idempotent, button, logo] = placesIn(handed.text);
  assert.ok(logo < button && button < idempotent);
  assert.equal(s.rig.provider.calls.length, 0);
});

test('journal.relevance shadow: the engine is asked and recorded, and the handoff is unchanged', async () => {
  const s = setup();
  await s.rig.configure('journal.relevance', 'shadow');
  s.rig.provider.script = scoreEntries();
  seedJournal(s);
  const handed = await s.journal.handoffFor('p1', TOPIC);
  assert.deepEqual(same(handed), same(s.journal.handoff('p1')));
  const rows = s.rig.rows('journal.relevance');
  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.mode === 'shadow' && !rows[0].acted && !rows[0].visible);
  assert.match(JSON.stringify(rows[0]?.state), /idempotent/);
});

test('journal.relevance active: above the threshold the entries are reordered, and code still wraps them and holds the budget', async () => {
  const s = setup();
  await s.rig.configure('journal.relevance', 'active');
  s.rig.provider.script = scoreEntries();
  seedJournal(s);
  const handed = await s.journal.handoffFor('p1', TOPIC);
  const [idempotent, button, logo] = placesIn(handed.text);
  assert.ok(idempotent < logo && logo < button, 'essential first, the rest newest first');
  assert.match(handed.text, /the ones this work needs most first/);
  assert.match(handed.text, /^# Project journal/);
  assert.equal(handed.entries, 3);
  assert.equal(s.rig.rows('journal.relevance')[0]?.visible, false, 'an invisible act shows no mark');
  // The budget is code's: a journal larger than it is cut, whatever the order asked for
  for (let i = 0; i < 20; i++) s.journal.create('p1', { kind: 'note', text: `${'filler '.repeat(150)}${String(i)}` });
  const big = await s.journal.handoffFor('p1', TOPIC);
  assert.ok(big.bytes <= JOURNAL_HANDOFF_BYTES);
  assert.ok(big.entries < 23);
});

test('journal.relevance active: a low confidence, or none, leaves the newest-first handoff', async () => {
  const s = setup();
  await s.rig.configure('journal.relevance', 'active');
  seedJournal(s);
  for (const confidence of [0.5, null]) {
    s.rig.provider.script = scoreEntries(confidence);
    assert.deepEqual(same(await s.journal.handoffFor('p1', TOPIC)), same(s.journal.handoff('p1')));
  }
  assert.equal(s.rig.rows('journal.relevance').length, 2);
});

test('journal.relevance unavailable, no quota included: the newest-first handoff at once', async () => {
  const s = setup();
  await s.rig.configure('journal.relevance', 'active');
  seedJournal(s);
  for (const reason of ['no-quota', 'rate-limited', 'timeout'] as const) {
    s.rig.provider.script = () => ({ status: 'unavailable', reason, latencyMs: 1 });
    assert.deepEqual(same(await s.journal.handoffFor('p1', TOPIC)), same(s.journal.handoff('p1')));
  }
  s.rig.provider.up = false;
  assert.deepEqual(same(await s.journal.handoffFor('p1', TOPIC)), same(s.journal.handoff('p1')));
  assert.ok(s.rig.rows('journal.relevance').every((r) => r.status === 'unavailable'));
});

// ---------- board.triage ----------

const triaged = (duplicate = false) => () => ({ type: choiceOf('bug'), priority: choiceOf('high'), duplicate: noulOf(duplicate) });
const DRAFT = { title: 'Login crashes on Safari', description: 'A blank page after submit.' };

test('board.triage off: creating an item asks nobody and a triage is null', async () => {
  const s = setup();
  s.rig.provider.script = triaged();
  const item = s.items.create('p1', DRAFT);
  assert.deepEqual([item.type, item.priority], ['task', 'medium']);
  assert.equal(await s.items.triage('p1', DRAFT), null);
  assert.equal(s.rig.provider.calls.length, 0);
  assert.equal(s.rig.rows('board.triage').length, 0);
});

test("board.triage shadow: a person's create is recorded against its item and keeps the person's fields", async () => {
  const s = setup();
  await s.rig.configure('board.triage', 'shadow');
  s.rig.provider.script = triaged();
  s.items.create('p1', { title: 'An open item' });
  const item = s.items.create('p1', { ...DRAFT, type: 'task', priority: 'low' });
  const rows = await s.rig.rowsAfter('board.triage', 2);
  assert.equal(rows.length, 2);
  const mine = rows.find((r) => r.subjectId === item.id);
  assert.ok(mine && mine.mode === 'shadow' && !mine.acted && !mine.visible);
  assert.deepEqual([s.items.find(item.id)?.type, s.items.find(item.id)?.priority], ['task', 'low']);
  assert.equal(await s.items.triage('p1', DRAFT), null, 'shadow never shows a suggestion');
  // An agent's create is not a person's prefill and is not measured
  const before = s.rig.rows('board.triage').length;
  s.items.create('p1', { title: 'From a run' }, { actor: AGENT });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.rig.rows('board.triage').length, before);
});

test('board.triage active: the draft gets a suggestion, and create itself is unchanged', async () => {
  const s = setup();
  await s.rig.configure('board.triage', 'active');
  s.rig.provider.script = triaged(true);
  const suggestion = await s.items.triage('p1', DRAFT);
  assert.deepEqual(suggestion, { type: 'bug', priority: 'high', duplicate: true });
  const item = s.items.create('p1', DRAFT);
  assert.deepEqual([item.type, item.priority], ['task', 'medium'], 'only the person fills the fields');
  const rows = s.rig.rows('board.triage');
  assert.equal(rows.length, 1, 'create does not ask again once the draft was');
  assert.ok(rows[0]?.acted && rows[0].visible);
  // The CLI has no confidence: a suggest point still prepares its suggestion
  s.rig.provider.script = () => ({ type: choiceOf('story', null), priority: choiceOf('low', null), duplicate: noulOf(false, null) });
  assert.deepEqual(await s.items.triage('p1', DRAFT), { type: 'story', priority: 'low', duplicate: false });
});

test('board.triage unavailable, no quota included: no suggestion, at once, and create works', async () => {
  const s = setup();
  await s.rig.configure('board.triage', 'active');
  s.rig.provider.script = () => ({ status: 'unavailable', reason: 'no-quota', latencyMs: 1 });
  assert.equal(await s.items.triage('p1', DRAFT), null);
  s.rig.provider.up = false;
  assert.equal(await s.items.triage('p1', DRAFT), null);
  assert.equal(s.items.create('p1', DRAFT).title, DRAFT.title);
  assert.ok(s.rig.rows('board.triage').every((r) => r.status === 'unavailable'));
});
