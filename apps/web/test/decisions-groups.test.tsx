import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSummary } from '../src/pages/config/DecisionsTab.tsx';

const label = (mode: string, count: number) => `${String(count)} ${mode}`;

test("a folded group's head says how its points stand, most engaged first, without the empty modes", () => {
  assert.equal(groupSummary(['active', 'off', 'shadow', 'active'], label), '2 active · 1 shadow · 1 off');
  assert.equal(groupSummary(['shadow', 'shadow'], label), '2 shadow');
  assert.equal(groupSummary([], label), '');
});
