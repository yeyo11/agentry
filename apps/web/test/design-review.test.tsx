// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { FlowRun } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@agentry/ui/components/Dialog';
import { TeamCrumbs } from '../src/components/shell/TeamCrumbs';
import { ToastProvider } from '@agentry/ui/components/Toast';
import i18n from '../src/i18n';
import { BoardTeamProvider, BounceFact, type BoardTeam } from '../src/pages/tasks/board/team';
import { runStep as itemRunStep } from '../src/pages/tasks/item/runs';
import { runStep as teamRunStep } from '../src/pages/team/model';
import { FlowRunRow } from '../src/pages/team/runs';

// What the final pass of the ecosystem design review fixed across the screen tasks, each against the
// reference in docs/design-system/reference/.

function wrap(children: ReactNode) {
  const page = (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
  const router = createMemoryRouter([{ path: '*', element: page }]);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('Team activity names itself in the crumbs, as Flow does (DesktopEquipoActividad)', async () => {
  await i18n.changeLanguage('es');
  assert.equal(text(wrap(<TeamCrumbs projectId="p" search="?view=team&section=activity" />)), 'Equipo / Actividad');
  assert.equal(text(wrap(<TeamCrumbs projectId="p" search="?view=team&section=flow" />)), 'Equipo / Flujo');
  // Members is Team itself: one crumb, and not a link back to where it already is
  const members = wrap(<TeamCrumbs projectId="p" search="?view=team" />);
  assert.equal(text(members), 'Equipo');
  assert.doesNotMatch(members, /<a /);
});

const board = (maxBounces: number): BoardTeam => ({
  flowOn: true,
  columns: {},
  maxBounces,
  running: new Map(),
  queued: new Map(),
  ended: new Map(),
  maxParallel: 2,
  queuedCount: 0,
  verifier: 'qa',
});

test("a card's bounces count against the flow's limit, and stand alone with the Team module off", async () => {
  await i18n.changeLanguage('es');
  assert.match(text(wrap(<BoardTeamProvider value={board(3)}><BounceFact item={{ bounces: 1 }} /></BoardTeamProvider>)), /rebote 1 de 3/);
  // No team, no limit: it read "rebote 1 de 1", as if that one had been the last
  const bare = wrap(<BounceFact item={{ bounces: 1 }} />);
  assert.match(text(bare), /rebote 1/);
  assert.doesNotMatch(text(bare), /de 1/);
  assert.match(text(bare), /QA la devolvió 1 vez/);
  assert.doesNotMatch(text(wrap(<BounceFact item={{ bounces: 0 }} />)), /rebote/);
});

test('a run row keeps who and the step together, so a narrow phone moves the badge down instead', async () => {
  await i18n.changeLanguage('es');
  const run: FlowRun = {
    id: 'r',
    projectId: 'p',
    itemId: 'i',
    item: { id: 'i', key: 'AGN-36', title: 'Tablas de tareas en SQLite', type: 'task', status: 'todo' },
    role: 'product-owner',
    agent: 'product-owner',
    model: 'opus',
    stage: 'refine',
    step: 'check',
    column: 'todo',
    state: 'ended',
    chatId: null,
    outcome: 'failed',
    summary: null,
    error: 'Rate limited',
    cause: 'no-account',
    retryOf: null,
    queuedBy: null,
    retriedBy: null,
    retryable: false,
    restarts: 0,
    continuations: 0,
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
  const html = wrap(<FlowRunRow run={run} days={0} context={{ running: 0, maxParallel: 2 }} phone projectId="p" />);
  const actor = /<span class="flow-run-actor">(.*?)<\/span><\/span>/.exec(html)?.[1] ?? '';
  assert.match(text(actor), /Product Owner · comprobación/);
  // The badge is the title's next child, outside the pair
  assert.doesNotMatch(actor, /badge/);
  assert.match(html, /flow-run-actor.*badge/s);
});

test("the phone header gives back the stack's gap, as Night Shift starts the body 4 px under .m-head", () => {
  const css = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const rule = /\.phone-head \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /margin: calc\(2px - var\(--main-pad-top, 16px\)\) -8px -10px/);
});

test("the board's phone flow row is set at the reference's 13 px, so its figures fit on a 390 px phone", () => {
  const css = readFileSync(new URL('../src/styles/board.css', import.meta.url), 'utf8');
  const rule = /\.board-flow-row \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /font-size: 13px/);
  assert.match(rule, /padding: 0 12px/);
});

test('choosing cards on a phone hides the tab bar, and its bar sits at the bottom (MobileTableroSeleccion)', () => {
  const css = readFileSync(new URL('../src/styles/board.css', import.meta.url), 'utf8');
  assert.match(css, /\.shell:has\(\.selection-foot\) \.fab,\n\.shell:has\(\.selection-foot\) \.tabbar \{\n {2}display: none;/);
  const foot = /\n\.selection-foot \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(foot, /bottom: env\(safe-area-inset-bottom, 0px\);/);
  assert.doesNotMatch(foot, /tabbar-h/);
});

test("the empty team's card reaches the status bar, as the empty board's does (DesktopEquipoVacio)", () => {
  const css = readFileSync(new URL('../src/styles/team.css', import.meta.url), 'utf8');
  assert.match(css, /\.page:has\(> \.tab-panel > \.team-page\.is-empty\) \{\n {2}min-height: 100%;/);
  assert.match(css, /\.team-page\.is-empty > \.team-empty:not\(\.is-phone\) \{\n {2}flex: 1 1 auto;/);
});

test("Milestones' row actions are ghost buttons, as DesktopHitos draws them", () => {
  const source = readFileSync(new URL('../src/pages/tasks/Milestones.tsx', import.meta.url), 'utf8');
  assert.match(source, /className="btn btn-quiet btn-small milestone-row-action">\s*\{t\('milestones\.viewList'\)\}/);
  assert.doesNotMatch(source, /className="btn btn-small/);
});

test('a work item and Team activity name a run stored without its step by the same rule', () => {
  const cases: Array<Pick<FlowRun, 'stage' | 'column'>> = [
    { stage: 'refine', column: 'backlog' },
    { stage: 'refine', column: 'todo' },
    { stage: 'work', column: 'in_progress' },
    { stage: 'verify', column: 'in_review' },
    // A column that does not match its stage keeps the stage's own name
    { stage: 'work', column: 'todo' },
  ];
  for (const run of cases) assert.equal(itemRunStep({ ...run, step: null }), teamRunStep({ ...run, step: null }), `${run.stage} in ${run.column}`);
  assert.equal(itemRunStep({ stage: 'refine', column: 'todo', step: null }), 'check');
});
