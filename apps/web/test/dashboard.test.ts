import type { Orchestration, OrchestrationTaskState, PermissionRequest, Schedule } from '@agentry/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { configCount, SIZE_SPANS, validateLayout, WIDGET_SIZES, type WidgetRule } from '../src/pages/dashboard/layout.ts';
import {
  excerpt,
  homeHeadline,
  initials,
  limitSummary,
  liveByProject,
  orchestrationStages,
  orchestrationsToShow,
  scheduleCwd,
  taskCounts,
  taskSegments,
  upcomingSchedules,
  waitingFor,
} from '../src/pages/dashboard/model.ts';
import { defaultLayout, resolveLayout, WIDGET_AREAS, widgetDefinition, WIDGETS } from '../src/pages/dashboard/registry.ts';
import { legacyTabRedirect } from '../src/pages/dashboard/views.ts';

// Home draws whatever layout it is handed. A stored layout is data from another version, or from a
// person's hands, so what the page is allowed to draw from it is decided here, not in the page.

const RULES: WidgetRule[] = [
  { type: 'now', sizes: ['l', 'full'], defaultSize: 'full', scope: 'both' },
  { type: 'memory', sizes: ['s', 'm'], defaultSize: 's', scope: 'project' },
  { type: 'projects', sizes: ['m', 'l'], defaultSize: 'l', scope: 'global' },
];

test('a layout keeps its widgets in order, with their sizes and configs', () => {
  const layout = validateLayout(
    { version: 1, widgets: [{ id: 'a', type: 'memory', size: 'm', config: { limit: 3 } }, { id: 'b', type: 'now', size: 'l' }] },
    RULES,
    'project',
  );
  assert.deepEqual(layout, {
    version: 1,
    widgets: [
      { id: 'a', type: 'memory', size: 'm', config: { limit: 3 } },
      { id: 'b', type: 'now', size: 'l' },
    ],
  });
});

test('unknown types, widgets of the other scope and repeated ids are dropped', () => {
  const layout = validateLayout(
    {
      version: 1,
      widgets: [
        { id: 'a', type: 'documents', size: 'm' },
        { id: 'b', type: 'projects', size: 'l' },
        { id: 'c', type: 'now', size: 'full' },
        { id: 'c', type: 'memory', size: 's' },
        { id: '', type: 'memory', size: 's' },
        'now',
        null,
      ],
    },
    RULES,
    'project',
  );
  assert.deepEqual(layout?.widgets.map((w) => w.id), ['c']);
});

test('a size the type does not offer falls back to its default instead of dropping the widget', () => {
  const layout = validateLayout({ version: 1, widgets: [{ id: 'a', type: 'now', size: 's' }, { id: 'b', type: 'now', size: 'huge' }, { id: 'c', type: 'now' }] }, RULES, 'global');
  assert.deepEqual(layout?.widgets.map((w) => w.size), ['full', 'full', 'full']);
});

test('a config that is not an object is left out', () => {
  const layout = validateLayout({ version: 1, widgets: [{ id: 'a', type: 'now', size: 'l', config: [1, 2] }] }, RULES, 'global');
  assert.deepEqual(layout?.widgets, [{ id: 'a', type: 'now', size: 'l' }]);
});

test('what is not a layout of this version is no layout at all', () => {
  for (const input of [null, undefined, 'x', [], {}, { version: 2, widgets: [] }, { version: 1 }, { version: 1, widgets: {} }]) {
    assert.equal(validateLayout(input, RULES, 'project'), null, JSON.stringify(input));
  }
});

test('config counts: a positive integer, capped; anything else is the fallback', () => {
  assert.equal(configCount({ limit: 3 }, 'limit', 5), 3);
  assert.equal(configCount({ limit: 500 }, 'limit', 5), 50);
  for (const limit of [0, -1, 2.5, '3', null]) assert.equal(configCount({ limit }, 'limit', 5), 5);
  assert.equal(configCount(undefined, 'limit', 5), 5);
});

test('every size has a span on both grids, and none is wider than its grid', () => {
  for (const size of WIDGET_SIZES) {
    assert.ok(SIZE_SPANS[size].wide >= 1 && SIZE_SPANS[size].wide <= 12, size);
    assert.ok(SIZE_SPANS[size].medium >= 1 && SIZE_SPANS[size].medium <= 6, size);
  }
});

// ---------- The registry ----------

test('the registry: unique types, a default size each type offers, a title key', () => {
  assert.equal(new Set(WIDGETS.map((w) => w.type)).size, WIDGETS.length);
  for (const widget of WIDGETS) {
    assert.ok(widget.sizes.length > 0, widget.type);
    assert.ok(widget.sizes.includes(widget.defaultSize), `${widget.type} offers its default size`);
    assert.match(widget.titleKey, /^widgets\.\w+\.title$/, widget.type);
    assert.equal(widgetDefinition(widget.type), widget);
    assert.ok(WIDGET_AREAS.includes(widget.area), `${widget.type} has an area the page draws`);
  }
  assert.equal(widgetDefinition('documents'), undefined);
});

test('the default layouts: what the plan asks for, each widget in its scope, and a valid layout', () => {
  const project = defaultLayout('project');
  const global = defaultLayout('global');
  assert.deepEqual(
    project.widgets.map((w) => w.type).sort(),
    ['export', 'kpis', 'limits', 'memory', 'now', 'pickUp', 'quickStart', 'resources', 'schedules', 'today', 'worktrees'].sort(),
  );
  // Orchestrations are part of "In progress": their own widget would show them twice
  assert.deepEqual(global.widgets.map((w) => w.type).sort(), ['kpis', 'limits', 'now', 'pickUp', 'projects', 'schedules', 'today'].sort());
  for (const [scope, layout] of [['project', project], ['global', global]] as const) {
    assert.deepEqual(resolveLayout(layout, scope), layout, `${scope} survives its own validation`);
    const main = layout.widgets.filter((w) => widgetDefinition(w.type)?.area === 'main');
    assert.equal(main[0]?.type, 'now', 'what is live comes first in the wide column');
    const top = layout.widgets.filter((w) => widgetDefinition(w.type)?.area === 'top').map((w) => w.type);
    assert.deepEqual(top, ['kpis', 'limits'], 'the figures, then the limit beside them');
  }
});

test('a layout that cannot be read falls back to the default; one that can is trimmed, not replaced', () => {
  assert.deepEqual(resolveLayout(undefined, 'global'), defaultLayout('global'));
  assert.deepEqual(resolveLayout({ version: 1, widgets: [{ id: 'x', type: 'flows', size: 'm' }, { id: 'n', type: 'now', size: 'l' }] }, 'global'), {
    version: 1,
    widgets: [{ id: 'n', type: 'now', size: 'l' }],
  });
  // Project-only widgets stored for a project never leak onto All projects
  assert.deepEqual(resolveLayout({ version: 1, widgets: [{ id: 'q', type: 'quickStart', size: 'l' }] }, 'global').widgets, []);
});

// ---------- The old address ----------

test('?tab= becomes ?view=, keeping the section and the project; activity is the dashboard itself', () => {
  assert.equal(legacyTabRedirect(new URLSearchParams('tab=settings&section=files&project=p1')), '?section=files&project=p1&view=settings');
  assert.equal(legacyTabRedirect(new URLSearchParams('project=p1&tab=memory')), '?project=p1&view=memory');
  assert.equal(legacyTabRedirect(new URLSearchParams('tab=activity')), '');
  assert.equal(legacyTabRedirect(new URLSearchParams('tab=nonsense&project=p1')), '?project=p1');
  assert.equal(legacyTabRedirect(new URLSearchParams('project=p1')), null);
  assert.equal(legacyTabRedirect(new URLSearchParams('view=worktrees')), null);
});

// ---------- What the widgets compute ----------

const task = (id: string, status: OrchestrationTaskState['status'], dependsOn: string[] = []): OrchestrationTaskState =>
  ({ id, name: id, prompt: '', dependsOn, status, attempts: 1, runId: null, sessionId: null, result: null, error: null, startedAt: null, endedAt: null, costUsd: 0 }) as OrchestrationTaskState;

const orch = (id: string, status: Orchestration['status'], createdAt: string, tasks: OrchestrationTaskState[] = []): Orchestration =>
  ({ id, name: id, status, createdAt, tasks }) as Orchestration;

test('stages: a task sits one stage after the latest task it depends on', () => {
  const stages = orchestrationStages(
    orch('o', 'running', '2026-01-01', [task('a', 'completed'), task('b', 'completed'), task('c', 'running', ['a']), task('d', 'pending', ['c', 'b']), task('e', 'pending', ['ghost'])]),
  );
  assert.deepEqual(
    stages.map((s) => s.tasks.map((t) => t.id)),
    [['a', 'b', 'e'], ['c'], ['d']],
  );
  assert.deepEqual(stages.map((s) => s.state), ['pending', 'current', 'pending']);
  assert.deepEqual(stages.map((s) => s.done), [2, 0, 0]);
});

test('stage states: done, failed, waiting on a person, skipped', () => {
  const state = (status: Orchestration['status'], ...tasks: OrchestrationTaskState[]) => orchestrationStages(orch('o', status, '2026-01-01', tasks))[0]?.state;
  assert.equal(state('completed', task('a', 'completed'), task('b', 'skipped')), 'done');
  assert.equal(state('failed', task('a', 'completed'), task('b', 'failed')), 'failed');
  assert.equal(state('waiting', task('a', 'failed')), 'waiting');
  assert.equal(state('stopped', task('a', 'stopped')), 'skipped');
  assert.equal(state('running', task('a', 'pending')), 'pending');
});

test('a dependency cycle in a stored graph ends instead of recursing for ever', () => {
  const stages = orchestrationStages(orch('o', 'running', '2026-01-01', [task('a', 'pending', ['b']), task('b', 'pending', ['a'])]));
  assert.equal(stages.flatMap((s) => s.tasks).length, 2);
});

test('task counts: interrupted goes on by itself, stopped reads as given up', () => {
  assert.deepEqual(taskCounts([task('a', 'completed'), task('b', 'interrupted'), task('c', 'blocked'), task('d', 'stopped'), task('e', 'failed'), task('f', 'running')]), {
    done: 1,
    pending: 2,
    skipped: 1,
    failed: 1,
    running: 1,
  });
});

test('orchestrations to show: the live ones newest first; the latest one when nothing runs', () => {
  const list = [orch('old', 'completed', '2026-01-01'), orch('run1', 'running', '2026-01-02'), orch('wait', 'waiting', '2026-01-04'), orch('new', 'failed', '2026-01-05')];
  assert.deepEqual(orchestrationsToShow(list, 5).map((o) => o.id), ['wait', 'run1']);
  assert.deepEqual(orchestrationsToShow(list, 1).map((o) => o.id), ['wait']);
  assert.deepEqual(orchestrationsToShow([list[0]!, list[3]!], 3).map((o) => o.id), ['new']);
  assert.deepEqual(orchestrationsToShow([], 3), []);
});

const schedule = (id: string, nextRunAt: string | null, enabled = true, cwd?: string): Schedule =>
  ({ id, name: id, enabled, nextRunAt, target: { kind: 'chat', chat: { prompt: 'x', cwd } } }) as Schedule;

test('upcoming schedules: enabled, due again, soonest first, filtered and capped', () => {
  const list = [schedule('late', '2026-02-01T00:00:00Z'), schedule('off', '2026-01-01T00:00:00Z', false), schedule('never', null), schedule('soon', '2026-01-10T00:00:00Z', true, '/p')];
  assert.deepEqual(upcomingSchedules(list, () => true, 5).map((s) => s.id), ['soon', 'late']);
  assert.deepEqual(upcomingSchedules(list, (s) => scheduleCwd(s) === '/p', 5).map((s) => s.id), ['soon']);
  assert.deepEqual(upcomingSchedules(list, () => true, 1).map((s) => s.id), ['soon']);
  assert.equal(scheduleCwd({ target: { kind: 'orchestration', spec: { name: 'o', tasks: [], cwd: '/o' } } }), '/o');
});

test('live by project: working and waiting per project, a chat counted once, loose chats left out', () => {
  const live = liveByProject([
    { id: '1', state: 'working', project: { id: 'p', name: 'p' } },
    { id: '2', state: 'waiting', project: { id: 'p', name: 'p' } },
    { id: '1', state: 'working', project: { id: 'p', name: 'p' } },
    { id: '3', state: 'working', project: null },
  ]);
  assert.deepEqual([...live.entries()], [['p', { working: 1, waiting: 1 }]]);
});

test('waiting reasons: a plan, a question, a tool, or nothing known yet', () => {
  const request = (toolName: string, extra: Partial<PermissionRequest> = {}) => ({ toolName, input: {}, ...extra }) as PermissionRequest;
  assert.deepEqual(waitingFor(undefined), { kind: 'generic', tool: '', more: 0, detail: null });
  assert.equal(waitingFor([request('ExitPlanMode')]).kind, 'plan');
  assert.equal(waitingFor([request('AskUserQuestion')]).kind, 'question');
  const bash = waitingFor([request('Bash', { input: { command: 'rm -rf build' } }), request('Edit')]);
  assert.deepEqual(bash, { kind: 'tool', tool: 'Bash', more: 1, detail: 'rm -rf build' });
});

test('an excerpt skips front matter and runs of blank lines, and stops after a few lines', () => {
  const doc = '---\nname: x\n---\n\n# Rules\n\n\nOne\nTwo\n\nThree\nFour\nFive\nSix\n';
  assert.equal(excerpt(doc, 3), '# Rules\n\nOne\nTwo');
  assert.equal(excerpt('\n\n'), '');
});

// ---------- Home's hero and figures ----------

test('the headline: someone waiting outranks everything, then running, then nothing', () => {
  assert.deepEqual(homeHeadline({ running: 3, waiting: 0 }), { kind: 'running' });
  assert.deepEqual(homeHeadline({ running: 3, waiting: 2 }), { kind: 'waiting', n: 2 });
  assert.deepEqual(homeHeadline({ running: 0, waiting: 1 }), { kind: 'waiting', n: 1 });
  assert.deepEqual(homeHeadline({ running: 0, waiting: 0 }), { kind: 'idle' });
});

test('initials: the first letters of the first two words, whatever splits them', () => {
  assert.equal(initials('spanish-copy'), 'SC');
  assert.equal(initials('google-docs-mcp'), 'GD');
  assert.equal(initials('claude_wrapper'), 'CW');
  assert.equal(initials('obra10'), 'O');
  assert.equal(initials('ñandú rápido'), 'ÑR');
  assert.equal(initials('--'), '?');
});

test('task segments: one per task, done first and what is ahead last', () => {
  const tasks = (['pending', 'running', 'completed', 'failed', 'blocked', 'completed', 'stopped'] as const).map((status) => ({ status }));
  assert.deepEqual(taskSegments(tasks), ['done', 'done', 'skipped', 'failed', 'running', 'pending', 'pending']);
  assert.deepEqual(taskSegments([]), []);
});

test('limits: the active account from claude-swap first, the CLI windows by name otherwise', () => {
  const swap = {
    rateLimit: { status: 'allowed', windows: { five_hour: { utilization: 0.9, resetsAt: 100 } }, observedAt: '' },
    accounts: {
      installed: true,
      total: 1,
      autoSwitchRunning: false,
      active: {
        number: 1,
        email: 'a@b.c',
        organizationName: null,
        alias: null,
        active: true,
        disabled: false,
        usageStatus: 'ok',
        usageFetchedAt: null,
        headroomPct: 55,
        usage: { fiveHour: { pct: 45.4, resetsAt: '2026-09-25T12:00:00Z', countdown: null }, sevenDay: { pct: 5, resetsAt: null, countdown: null }, scoped: [] },
      },
    },
  };
  assert.deepEqual(limitSummary(swap), { fiveHour: { pct: 45, resetsAt: Date.parse('2026-09-25T12:00:00Z') }, weekly: { pct: 5, resetsAt: null } });
  const cli = { accounts: null, rateLimit: { status: 'allowed', windows: { seven_day: { utilization: 0.051, resetsAt: 200 }, five_hour: { utilization: 1.2, resetsAt: 100 } }, observedAt: '' } };
  assert.deepEqual(limitSummary(cli), { fiveHour: { pct: 100, resetsAt: 100_000 }, weekly: { pct: 5, resetsAt: 200_000 } });
  assert.deepEqual(limitSummary(undefined), { fiveHour: null, weekly: null });
  assert.deepEqual(limitSummary({ accounts: null, rateLimit: null }), { fiveHour: null, weekly: null });
});
