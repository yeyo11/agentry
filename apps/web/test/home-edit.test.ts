import { WIDGET_RULES, layoutProblem, type DocumentNode, type FlowRun } from '@agentry/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { addableWidgets, addWidget, moveWidgetTo, positionOf, removeWidget, resizeWidget, sameLayout, shiftWidget, widgetsInArea } from '../src/pages/dashboard/edit.ts';
import type { DashboardLayout } from '../src/pages/dashboard/layout.ts';
import { documentFolder, flowRows, recentDocuments } from '../src/pages/dashboard/model.ts';
import { defaultLayout, resolveLayout, WIDGETS } from '../src/pages/dashboard/registry.ts';

// Editing a Home is a sequence of pure steps from a layout to a layout; what is stored must always
// pass the rules the API checks, and a layout that does not pass falls back to the default.

const ids = (layout: DashboardLayout) => layout.widgets.map((widget) => widget.id);

test('the registry and the shared rules describe the same widget types', () => {
  const byType = (a: { type: string }, b: { type: string }) => a.type.localeCompare(b.type);
  const fromRegistry = WIDGETS.map(({ type, sizes, defaultSize, scope }) => ({ type, sizes, defaultSize, scope })).sort(byType);
  assert.deepEqual(fromRegistry, [...WIDGET_RULES].sort(byType));
});

test('both default layouts pass the API rules, and carry the new widgets only on a project', () => {
  for (const scope of ['project', 'global'] as const) assert.equal(layoutProblem(defaultLayout(scope), scope), null);
  assert.ok(ids(defaultLayout('project')).includes('documents'));
  assert.ok(ids(defaultLayout('project')).includes('flows'));
  assert.ok(!ids(defaultLayout('global')).includes('documents'));
});

test('a stored layout that is not a layout, or names nothing this version knows, is replaced by the default where it cannot be read', () => {
  assert.deepEqual(resolveLayout(null, 'project'), defaultLayout('project'));
  assert.deepEqual(resolveLayout({ version: 2, widgets: [] }, 'project'), defaultLayout('project'));
  assert.deepEqual(resolveLayout('nope', 'global'), defaultLayout('global'));
  // Unknown types and the other scope's types are dropped, the rest is kept
  const kept = resolveLayout({ version: 1, widgets: [{ id: 'a', type: 'gone', size: 'm' }, { id: 'projects', type: 'projects', size: 'l' }, { id: 'now', type: 'now', size: 'l' }] }, 'project');
  assert.deepEqual(ids(kept), ['now']);
});

test('adding puts the widget at the end of its area, at its default size, once', () => {
  const base: DashboardLayout = { version: 1, widgets: [{ id: 'now', type: 'now', size: 'full' }, { id: 'memory', type: 'memory', size: 's' }, { id: 'kpis', type: 'kpis', size: 'l' }] };
  const withDocs = addWidget(base, 'documents');
  // documents is a wide-column widget: it goes right after `now`, the last of the wide column
  assert.deepEqual(ids(withDocs), ['now', 'documents', 'memory', 'kpis']);
  assert.equal(withDocs.widgets[1]?.size, 'm');
  assert.equal(addWidget(withDocs, 'documents'), withDocs);
  assert.equal(addWidget(base, 'unknown'), base);
  assert.equal(layoutProblem(withDocs, 'project'), null);
});

test('the picker offers what fits the scope and is not on the page', () => {
  const layout = defaultLayout('project');
  const offered = addableWidgets(layout, 'project').map((definition) => definition.type);
  assert.ok(offered.includes('orchestrations'));
  assert.ok(!offered.includes('projects'));
  assert.ok(!offered.includes('documents'));
  assert.ok(addableWidgets({ version: 1, widgets: [] }, 'global').every((definition) => definition.scope !== 'project'));
});

test('removing then adding brings a widget back; removing what is not there changes nothing', () => {
  const layout = defaultLayout('project');
  const without = removeWidget(layout, 'documents');
  assert.ok(!ids(without).includes('documents'));
  assert.ok(addableWidgets(without, 'project').some((definition) => definition.type === 'documents'));
  assert.equal(removeWidget(layout, 'nothing'), layout);
});

test('resizing accepts only the sizes the type allows', () => {
  const layout = defaultLayout('project');
  assert.equal(resizeWidget(layout, 'documents', 'l').widgets.find((widget) => widget.id === 'documents')?.size, 'l');
  assert.equal(resizeWidget(layout, 'documents', 'full'), layout);
  assert.equal(resizeWidget(layout, 'kpis', 's'), layout);
  assert.equal(layoutProblem(resizeWidget(layout, 'flows', 'full'), 'project'), null);
});

test('a widget moves only inside its area, and the others keep their places', () => {
  const layout: DashboardLayout = {
    version: 1,
    widgets: [
      { id: 'now', type: 'now', size: 'full' },
      { id: 'memory', type: 'memory', size: 's' },
      { id: 'flows', type: 'flows', size: 'm' },
      { id: 'documents', type: 'documents', size: 'm' },
      { id: 'worktrees', type: 'worktrees', size: 's' },
    ],
  };
  const mainBefore = widgetsInArea(layout, 'main').map((widget) => widget.id);
  assert.deepEqual(mainBefore, ['now', 'flows', 'documents']);
  const moved = shiftWidget(layout, 'documents', -1);
  assert.deepEqual(widgetsInArea(moved, 'main').map((widget) => widget.id), ['now', 'documents', 'flows']);
  // The side column did not move, and each area's widgets sit where its widgets sat
  assert.deepEqual(widgetsInArea(moved, 'side').map((widget) => widget.id), ['memory', 'worktrees']);
  assert.deepEqual(ids(moved), ['now', 'memory', 'documents', 'flows', 'worktrees']);
  // The ends do not wrap
  assert.equal(shiftWidget(layout, 'now', -1), layout);
  assert.equal(shiftWidget(layout, 'documents', 1), layout);
  assert.deepEqual(positionOf(moved, 'documents'), { index: 1, count: 3 });
  assert.deepEqual(widgetsInArea(moveWidgetTo(layout, 'now', 99), 'main').map((widget) => widget.id), ['flows', 'documents', 'now']);
});

test('sameLayout tells a move from no move', () => {
  const layout = defaultLayout('project');
  assert.ok(sameLayout(layout, structuredClone(layout)));
  assert.ok(!sameLayout(layout, shiftWidget(layout, 'documents', -1)));
  assert.ok(!sameLayout(layout, resizeWidget(layout, 'documents', 'l')));
});

const file = (path: string, updatedAt: string | null): DocumentNode => ({ name: path.split('/').pop() ?? path, path, type: 'file', updatedAt, ties: [] });

test('the Documents widget lists the most recently modified files first, undated last', () => {
  const tree: DocumentNode[] = [
    { name: 'docs', path: 'docs', type: 'dir', ties: [], children: [file('docs/old.md', '2026-01-01T00:00:00Z'), file('docs/new.md', '2026-10-01T00:00:00Z'), file('docs/none.md', null)] },
    file('status.md', '2026-06-01T00:00:00Z'),
  ];
  assert.deepEqual(recentDocuments(tree, 3).map((node) => node.path), ['docs/new.md', 'status.md', 'docs/old.md']);
  assert.deepEqual(recentDocuments(tree, 0), []);
  assert.deepEqual(recentDocuments([], 4), []);
  assert.equal(documentFolder('docs/specs/a.md'), 'docs/specs');
  assert.equal(documentFolder('status.md'), '');
});

const run = (id: string, state: FlowRun['state'], outcome: FlowRun['outcome']): FlowRun =>
  ({ id, state, outcome, role: 'developer', queuedAt: '2026-10-08T00:00:00Z', startedAt: null, endedAt: null }) as unknown as FlowRun;

test('the Flow widget orders what is live, queued, waiting and sent back, and cuts at the limit', () => {
  const flow = { running: [run('r1', 'running', null)], queued: [run('q1', 'queued', null)] };
  const waiting = { columns: [{ column: 'in_review' as const, role: 'qa', count: 2 }] };
  const recent = [run('e1', 'ended', 'passed'), run('e2', 'ended', 'rejected'), run('e3', 'ended', 'failed')];
  const rows = flowRows(flow, waiting, recent, 10);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['running', 'queued', 'waiting', 'ended', 'ended'],
  );
  // A run that passed says nothing the item's history does not
  assert.deepEqual(
    rows.filter((row) => row.kind === 'ended').map((row) => (row.kind === 'ended' ? row.run.id : '')),
    ['e2', 'e3'],
  );
  assert.equal(flowRows(flow, waiting, recent, 2).length, 2);
  assert.deepEqual(flowRows(undefined, undefined, [], 5), []);
});
