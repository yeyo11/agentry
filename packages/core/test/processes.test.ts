import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { cliProcessOf, commandRoots, descendantsOf, processTable, terminateTree, type ProcessEntry } from '../src/processes.ts';

// Cancelling a command kills a process tree, so what is under test is that it is exactly that tree:
// found from the process table by parentage and start time, and nothing else on the machine.

const entry = (pid: number, ppid: number, argv: string[] = []): ProcessEntry => ({ pid, ppid, started: 0, argv });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
};
/** A command the way the CLI runs one: a shell with its own child, which has to die with it. */
const shellWithChild = (): ChildProcess => spawn('sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore' });

test('the descendants of a process are every process under it, deepest first, and nothing beside it', () => {
  const table = [entry(1, 0), entry(10, 1), entry(11, 10), entry(12, 11), entry(20, 1), entry(21, 20)];
  assert.deepEqual(descendantsOf(table, 10).map((p) => p.pid), [12, 11]);
  assert.deepEqual(descendantsOf(table, 1).map((p) => p.pid).sort((a, b) => a - b), [10, 11, 12, 20, 21]);
  assert.deepEqual(descendantsOf(table, 12), []);
  // A cycle in a corrupt table ends the walk instead of never returning
  assert.deepEqual(descendantsOf([entry(1, 2), entry(2, 1)], 1).map((p) => p.pid), [2]);
});

test('the CLI is found under a wrapper by what it drives, not by its name', () => {
  const table = [
    entry(100, 1, ['cswap', 'chat', 'work', '--']),
    entry(101, 100, ['claude', '--input-format', 'stream-json', '--session-id', 'abc']),
    entry(102, 101, ['bash', '-c', 'pnpm e2e']),
  ];
  assert.equal(cliProcessOf(table, 100, 'abc')?.pid, 101);
  // Started directly, the spawned process is the CLI
  assert.equal(cliProcessOf([entry(200, 1, ['claude', '--input-format', 'stream-json', '--resume', 'abc'])], 200, 'abc')?.pid, 200);
  assert.equal(cliProcessOf([], 200, 'abc'), null);
});

test('two commands running at once each get their own process, in the order they were called', async () => {
  const first = shellWithChild();
  const t1 = Date.now() - 20;
  await new Promise((r) => setTimeout(r, 120));
  const second = shellWithChild();
  const t2 = Date.now() - 20;
  try {
    assert.ok(first.pid && second.pid);
    await until(() => processTable().some((p) => p.pid === second.pid));
    // This process stands in for the CLI, but it has children of its own (tsx's esbuild service,
    // started moments before the first test), and one inside the window would take the first slot
    const ours = new Set([first.pid, second.pid]);
    const table = processTable().filter((p) => p.ppid !== process.pid || ours.has(p.pid));
    const { roots } = commandRoots(table, process.pid, [t1, t2], 50);
    assert.equal(roots[0]?.pid, first.pid);
    assert.equal(roots[1]?.pid, second.pid);
    // A command called after every process started has none of its own yet
    assert.equal(commandRoots(table, process.pid, [Date.now() + 60_000], 50).roots[0], null);
    // Not a child of that CLI: not a command of it
    assert.equal(commandRoots(table, 1, [t1], 50).roots.every((r) => r?.pid !== first.pid), true);
  } finally {
    first.kill('SIGKILL');
    second.kill('SIGKILL');
  }
});

test('cancelling a command takes its shell and everything it started, and leaves the rest running', async () => {
  const doomed = shellWithChild();
  const bystander = shellWithChild();
  try {
    assert.ok(doomed.pid && bystander.pid);
    await until(() => descendantsOf(processTable(), doomed.pid as number).length > 0);
    const table = processTable();
    const root = table.find((p) => p.pid === doomed.pid);
    assert.ok(root);
    const grandchildren = descendantsOf(table, root.pid).map((p) => p.pid);
    assert.ok(grandchildren.length >= 1, 'the shell started something of its own');

    const signalled = terminateTree(root, table, 200);
    assert.equal(signalled, 1 + grandchildren.length);
    assert.ok(await until(() => ![root.pid, ...grandchildren].some(alive)), 'the whole tree is gone');
    assert.equal(alive(bystander.pid), true, 'a sibling command is untouched');
  } finally {
    doomed.kill('SIGKILL');
    bystander.kill('SIGKILL');
  }
});

test('a process that ignores SIGTERM is killed after the grace period', async () => {
  const stubborn = spawn('sh', ['-c', "trap '' TERM; sleep 60 & wait"], { stdio: 'ignore' });
  try {
    assert.ok(stubborn.pid);
    await until(() => descendantsOf(processTable(), stubborn.pid as number).length > 0);
    const table = processTable();
    const root = table.find((p) => p.pid === stubborn.pid);
    assert.ok(root);
    terminateTree(root, table, 300);
    assert.ok(await until(() => !alive(root.pid), 4000), 'SIGKILL followed');
  } finally {
    stubborn.kill('SIGKILL');
  }
});
