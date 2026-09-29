// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrchestrationTimings } from '@agentry/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimingsBody } from '../src/components/TimingsPanel';
import { formatDuration as d } from '@agentry/ui/lib/format';
import i18n, { setLanguage } from '../src/i18n';
import { PHASE_CELLS, phaseCellCounts, phaseCells, timingsPhaseKey } from '../src/lib/orchestration-timings';

const MIN = 60_000;
const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString();

const TIMINGS: OrchestrationTimings = {
  orchestrationId: 'g1',
  at: at(120),
  createdAt: at(0),
  endedAt: at(100),
  wallMs: 100 * MIN,
  phases: [
    { phase: 'tasks', startedAt: at(0), endedAt: at(60), durationMs: 60 * MIN },
    { phase: 'integration', startedAt: at(60), endedAt: at(61), durationMs: MIN },
    { phase: 'verification', startedAt: at(61), endedAt: at(95), durationMs: 34 * MIN },
    { phase: 'synthesis', startedAt: at(95), endedAt: at(100), durationMs: 5 * MIN },
  ],
  afterTasksMs: 40 * MIN,
  parallelism: 1.4,
  criticalPath: {
    durationMs: 60 * MIN,
    links: [
      { taskId: 'core', taskName: 'Core work', startedAt: at(0), endedAt: at(20), workMs: 20 * MIN, waitBeforeMs: 0, waits: [] },
      {
        taskId: 'web',
        taskName: 'Web work',
        startedAt: at(22),
        endedAt: at(60),
        workMs: 20 * MIN,
        waitBeforeMs: 2 * MIN,
        waits: [{ taskId: 'web', kind: 'limit', startedAt: at(30), endedAt: at(48), durationMs: 18 * MIN, reason: 'session limit' }],
      },
    ],
  },
  waits: {
    slotMs: 2 * MIN,
    limitMs: 18 * MIN,
    retryMs: 3 * MIN,
    items: [],
  },
  verification: {
    checksMs: 29 * MIN,
    fixerMs: 5 * MIN,
    passes: 2,
    commands: [
      {
        command: 'pnpm e2e',
        install: false,
        totalMs: 29 * MIN,
        runs: [
          { pass: 1, startedAt: at(61), durationMs: 15 * MIN, status: 'failed' },
          { pass: 2, startedAt: at(81), durationMs: 14 * MIN, status: 'passed' },
        ],
      },
    ],
    fixes: [{ runId: 'fixer', command: 'pnpm e2e', attempt: 1, startedAt: at(76), endedAt: at(81), costUsd: 1 }],
  },
  missing: [],
};

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
});

test('each phase gets its share of the bar, and a short one still gets a cell', () => {
  const counts = phaseCellCounts(TIMINGS.phases);
  assert.equal(counts.reduce((a, b) => a + b, 0), PHASE_CELLS);
  assert.ok(counts.every((c) => c >= 1));
  assert.equal(counts[1], 1, 'a one-minute integration is one cell');
  assert.ok((counts[0] ?? 0) > (counts[2] ?? 0));
  // Neutral tones alternating by phase, never a status colour
  const cells = phaseCells(TIMINGS.phases);
  assert.deepEqual([...new Set(cells)].sort(), ['pending', 'skipped']);
  assert.equal(cells[0], 'skipped');
  assert.equal(cells[counts[0] ?? 0], 'pending');
  assert.deepEqual(phaseCellCounts([]), []);
  assert.deepEqual(phaseCellCounts([{ durationMs: 0 }, { durationMs: 0 }]), [1, 1]);
});

test('the timings are read again when the graph moves to another phase', () => {
  const base = { status: 'running' as const, integration: null, verification: null, synthesisRunId: null };
  assert.notEqual(timingsPhaseKey(base), timingsPhaseKey({ ...base, integration: { status: 'merging' } as never }));
  assert.notEqual(timingsPhaseKey(base), timingsPhaseKey({ ...base, status: 'completed' }));
});

test('the panel words the phases, the critical path, the waits and the failed runs, in English and Spanish', async () => {
  const en = renderToStaticMarkup(<TimingsBody timings={TIMINGS} running={false} />);
  const enText = text(en);
  assert.match(en, /class="progress-segbar orch-timings-bar"/);
  assert.ok(en.includes(`aria-label="Time by phase: Tasks ${d(60 * MIN)}, Integration ${d(MIN)}, Verification ${d(34 * MIN)}, Synthesis ${d(5 * MIN)}"`));
  assert.match(enText, /Critical path/);
  assert.ok(enText.includes(`Web work work ${d(20 * MIN)} ${d(2 * MIN)} before it started waiting on a limit · ${d(18 * MIN)}`));
  assert.ok(enText.includes(`waiting for a slot · ${d(2 * MIN)}`));
  assert.ok(enText.includes(`waiting for a retry · ${d(3 * MIN)}`));
  assert.ok(enText.includes(`checks ${d(29 * MIN)} · fixer ${d(5 * MIN)}, 1 attempt`));
  assert.ok(enText.includes(`pass 1 ${d(15 * MIN)} failed`));
  // Colour only where a wait or a failure is, each with its word
  assert.equal((en.match(/badge-warn/g) ?? []).length, 3, 'the limit on the path, and the limit and slot totals');
  assert.equal((en.match(/badge-idle/g) ?? []).length, 1);
  assert.equal((en.match(/badge-bad/g) ?? []).length, 1);
  assert.doesNotMatch(en, /grad|energy|is-done|is-running/);
  assert.doesNotMatch(enText, /Older graph/);
  assert.doesNotMatch(enText, /Still running/);

  setLanguage('es');
  await i18n.changeLanguage('es');
  const es = text(renderToStaticMarkup(<TimingsBody timings={{ ...TIMINGS, missing: ['integration.startedAt'] }} running />));
  assert.match(es, /Sigue en curso/);
  assert.match(es, /Ruta crítica/);
  assert.ok(es.includes(`esperando un límite · ${d(18 * MIN)}`));
  assert.ok(es.includes(`esperando turno · ${d(2 * MIN)}`));
  assert.ok(es.includes(`esperando un reintento · ${d(3 * MIN)}`));
  assert.ok(es.includes(`pasada 1 ${d(15 * MIN)} fallida`));
  assert.match(es, /Grafo antiguo: algunas fases no se registraron\./);
  assert.equal(i18n.getFixedT('es', 'orchestrationV2')('timings.title'), 'En qué se fue el tiempo');
  assert.equal(i18n.getFixedT('en', 'orchestrationV2')('timings.title'), 'Where the time went');
});
