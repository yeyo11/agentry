import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_LAYOUT_WIDGETS, WIDGET_RULES, layoutOf, layoutProblem, validateLayout } from '../src/index.ts';

const widget = (over: Record<string, unknown> = {}) => ({ id: 'a', type: 'documents', size: 'm', ...over });
const layout = (...widgets: unknown[]) => ({ version: 1, widgets });

test('the Documents and Flows widgets belong on a project Home only', () => {
  assert.equal(layoutProblem(layout(widget()), 'project'), null);
  assert.equal(layoutProblem(layout(widget({ id: 'f', type: 'flows' })), 'project'), null);
  assert.match(layoutProblem(layout(widget()), 'global') ?? '', /does not belong on All projects/);
});

test('a save is refused with the reason, where a read repairs', () => {
  assert.match(layoutProblem({ version: 2, widgets: [] }, 'project') ?? '', /version 1/);
  assert.match(layoutProblem(layout(widget({ type: 'nope' })), 'project') ?? '', /not a widget/);
  assert.match(layoutProblem(layout(widget({ size: 's' })), 'project') ?? '', /size must be one of m, l, full/);
  assert.match(layoutProblem(layout(widget(), widget()), 'project') ?? '', /repeated/);
  assert.match(layoutProblem(layout(widget({ id: '' })), 'project') ?? '', /id/);
  assert.match(layoutProblem(layout(widget({ config: [] })), 'project') ?? '', /config/);
  const many = Array.from({ length: MAX_LAYOUT_WIDGETS + 1 }, (_, i) => widget({ id: `w${i}` }));
  assert.match(layoutProblem(layout(...many), 'project') ?? '', /at most/);

  const repaired = validateLayout(layout(widget({ size: 's' }), widget({ id: 'b', type: 'nope' }), widget({ id: 'a' })), WIDGET_RULES, 'project');
  assert.deepEqual(repaired, { version: 1, widgets: [{ id: 'a', type: 'documents', size: 'm' }] });
  assert.equal(validateLayout('x', WIDGET_RULES, 'project'), null);
});

test('order is the array order and survives a round trip', () => {
  const input = layout(widget({ id: 'z', type: 'flows' }), widget({ id: 'a', config: { count: 5 } }));
  assert.equal(layoutProblem(input, 'project'), null);
  assert.deepEqual(validateLayout(input, WIDGET_RULES, 'project')?.widgets.map((w) => w.id), ['z', 'a']);
  assert.deepEqual(layoutOf(['documents', 'projects'], WIDGET_RULES, 'project').widgets.map((w) => w.type), ['documents']);
});
