import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTasks } from '../src/orchestrator.ts';

const task = (id: string, dependsOn: string[] = []) => ({ id, name: id, prompt: 'do it', dependsOn });

test('accepts a valid DAG', () => {
  assert.doesNotThrow(() => validateTasks([task('a'), task('b'), task('c', ['a', 'b']), task('d', ['c'])]));
});

test('rejects invalid task lists', () => {
  assert.throws(() => validateTasks([]), /at least one task/);
  assert.throws(() => validateTasks([task('a'), task('a')]), /duplicate/);
  assert.throws(() => validateTasks([task('bad id')]), /invalid task id/);
  assert.throws(() => validateTasks([{ id: 'a', name: 'a', prompt: '  ' }]), /empty prompt/);
  assert.throws(() => validateTasks([task('a', ['ghost'])]), /unknown task/);
  assert.throws(() => validateTasks([task('a', ['a'])]), /depends on itself/);
});

test('detects cycles', () => {
  assert.throws(() => validateTasks([task('a', ['c']), task('b', ['a']), task('c', ['b']), task('ok')]), /cycle between: a, b, c/);
});
