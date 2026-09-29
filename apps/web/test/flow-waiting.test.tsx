// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowRun, FlowWaiting } from '@agentry/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n, { setLanguage } from '../src/i18n';
import { FlowWaitingBody, startedMessage, switchesFlowOn, waitingToAsk } from '../src/pages/team/FlowWaiting';
import { retriesOf } from '../src/pages/tasks/item/runs';

// The Flow screen's prompt after a save switched the flow on while cards already waited
// (docs/plans/flow-start-waiting.md): when it asks, what it says, and what the toast says after it.

const WAITING: FlowWaiting = {
  total: 3,
  columns: [
    { column: 'backlog', role: 'product-owner', count: 2 },
    { column: 'in_progress', role: 'developer', count: 1 },
  ],
};

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const team = () => i18n.getFixedT(null, 'team');

test.beforeEach(async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
});

test('only a save that takes the saved flow from off to on asks about the waiting cards', () => {
  assert.equal(switchesFlowOn({ enabled: false }, { enabled: true }), true);
  assert.equal(switchesFlowOn({ enabled: true }, { enabled: true }), false, 'saving a flow already on asks nothing');
  assert.equal(switchesFlowOn({ enabled: true }, { enabled: false }), false);
  assert.equal(switchesFlowOn({ enabled: false }, { enabled: false }), false);
});

test('the prompt opens only when cards wait, and a count that cannot be read asks nothing', async () => {
  assert.equal(await waitingToAsk(async () => ({ total: 0, columns: [] })), null);
  assert.equal(await waitingToAsk(async () => Promise.reject(new Error('offline'))), null);
  assert.deepEqual(await waitingToAsk(async () => WAITING), WAITING);
});

test('the prompt names each column with its role and its count, in English and Spanish', async () => {
  const en = text(renderToStaticMarkup(<FlowWaitingBody waiting={WAITING} />));
  assert.match(en, /Backlog (PO )?Product Owner 2 cards/);
  assert.match(en, /In progress (DEV )?Developer 1 card/);
  assert.equal(team()('flow.waiting.title', { count: 3 }), '3 cards are waiting in columns with a responsible role');
  assert.equal(team()('flow.waiting.start'), 'Start them');
  assert.equal(team()('flow.waiting.onlyNew'), 'Only new ones');

  setLanguage('es');
  await i18n.changeLanguage('es');
  const es = text(renderToStaticMarkup(<FlowWaitingBody waiting={WAITING} />));
  assert.match(es, /Product Owner 2 tarjetas/);
  assert.match(es, /Desarrollador 1 tarjeta/);
  assert.equal(team()('flow.waiting.title', { count: 3 }), '3 tarjetas esperan en columnas con responsable');
  assert.equal(team()('flow.waiting.title', { count: 1 }), '1 tarjeta espera en una columna con responsable');
  assert.equal(team()('flow.waiting.start'), 'Ponerlas en marcha');
  assert.equal(team()('flow.waiting.onlyNew'), 'Solo las nuevas');
});

test('after starting them the toast says how many start now and how many wait, each pluralised', async () => {
  assert.equal(startedMessage({ queued: 3, startingNow: 2, waiting: 1 }, team()), '2 start now and 1 waits in the queue');
  assert.equal(startedMessage({ queued: 1, startingNow: 1, waiting: 0 }, team()), '1 starts now and 0 wait in the queue');
  assert.equal(startedMessage({ queued: 0, startingNow: 0, waiting: 0 }, team()), 'Nothing was left to start');
  setLanguage('es');
  await i18n.changeLanguage('es');
  assert.equal(startedMessage({ queued: 5, startingNow: 2, waiting: 3 }, team()), '2 empiezan ahora y 3 esperan en cola');
  assert.equal(startedMessage({ queued: 2, startingNow: 1, waiting: 1 }, team()), '1 empieza ahora y 1 espera en cola');
});

test("a run a person started from the waiting cards is in the item's history, as a retry is", () => {
  const run = (id: string, over: Partial<FlowRun>) => ({ id, retryOf: null, queuedBy: null, queuedAt: `2026-09-28T10:0${id}:00Z`, ...over });
  const runs = [run('1', {}), run('2', { queuedBy: 'person' }), run('3', { retryOf: 'r0' })];
  assert.deepEqual(retriesOf(runs).map((r) => r.id), ['2', '3']);
  assert.equal(i18n.getFixedT(null, 'workItem')('run.startedWaiting.refine'), 'Refinement started');
});
