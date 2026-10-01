// Drift net for the web packages split: what `main.tsx` reaches keeps its shape (a moved file has
// the same basename and the same exports), the lazy chunks stay lazy, and nothing is copied
// instead of moved. A task that changes the graph on purpose updates the fixture and says how.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FIXTURE, moduleGraph, type ModuleGraph } from '../scripts/module-graph';

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ModuleGraph;
const now = moduleGraph();

function difference(a: string[], b: string[]): string[] {
  const rest = [...b];
  return a.filter((item) => {
    const at = rest.indexOf(item);
    if (at < 0) return true;
    rest.splice(at, 1);
    return false;
  });
}

test('the reachable modules are the same, by name and exports', () => {
  assert.deepEqual({ lost: difference(fixture.nodes, now.nodes), added: difference(now.nodes, fixture.nodes) }, { lost: [], added: [] });
});

test('the lazy chunks are the same dynamic imports', () => {
  assert.deepEqual({ lost: difference(fixture.lazy, now.lazy), added: difference(now.lazy, fixture.lazy) }, { lost: [], added: [] });
});

test('no two reachable files are copies of each other', () => {
  assert.deepEqual(now.duplicates, []);
});
