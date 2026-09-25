import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { interrupts, KINDS, LEVELS, notificationsFor, settlesWaiting, waitingDrafts, type AgentryEvent, type NotificationDraft } from '../src/index.ts';

/*
 * The mapping the web's toasts and the server's push sender share. The web covers it through its
 * own store; these tests hold it from the server's side, where there is no browser and no
 * translation: one representative event of each of the seven kinds, and the English the sender
 * puts on a lock screen.
 */

let nextId = 1;
const AT = '2026-01-01T12:00:00Z';
const base = (title: string) => ({ id: nextId++, at: AT, title });
const run = { runId: 'run1', runName: 'fix the build', sessionId: null, orchestrationId: null, internal: false };

const only = (drafts: NotificationDraft[]): NotificationDraft => {
  assert.equal(drafts.length, 1);
  const [draft] = drafts;
  assert.ok(draft);
  return draft;
};

const waiting = (permissionId = 'p1', reason: 'permission' | 'question' | 'plan' = 'permission'): AgentryEvent => ({
  type: 'run.waiting',
  ...base('fix the build needs your approval to use Bash'),
  ...run,
  reason,
  permissionId,
  toolName: 'Bash',
});

test('a chat waiting for a person is the news worth waking someone for', () => {
  const draft = only(notificationsFor(waiting()));
  assert.equal(draft.kind, 'waiting');
  assert.equal(draft.priority, 'high');
  assert.equal(draft.key, 'wait:run1:p1');
  // The push notification has to open the very prompt, not just the chat
  assert.equal(draft.href, '/chats/run1?prompt=p1');
  assert.equal(draft.title, 'fix the build needs your approval to use Bash');
  assert.equal(draft.body, 'Approve or deny Bash to let it continue.');
  assert.equal(draft.permissionId, 'p1');
  // A question or a plan cannot be answered with two buttons
  assert.equal(only(notificationsFor(waiting('q', 'question'))).body, 'It is waiting for your answer.');
  assert.equal(only(notificationsFor(waiting('pl', 'plan'))).permissionId, null);
  // Housekeeping runs never wait for a person
  assert.deepEqual(notificationsFor({ ...(waiting() as Extract<AgentryEvent, { type: 'run.waiting' }>), internal: true }), []);
});

test('a run that ended says how it went, and one the person stopped is not news', () => {
  const ended = (status: 'completed' | 'failed' | 'stopped', extra: Partial<Extract<AgentryEvent, { type: 'run.ended' }>> = {}): AgentryEvent => ({
    type: 'run.ended',
    ...base(`fix the build ${status}`),
    ...run,
    status,
    error: status === 'failed' ? 'boom' : null,
    turns: 3,
    costUsd: 0.1,
    ...extra,
  });
  const done = only(notificationsFor(ended('completed')));
  assert.equal(done.kind, 'run');
  assert.equal(done.tone, 'ok');
  assert.equal(done.body, '3 turns');
  assert.equal(done.href, '/chats/run1');
  assert.equal(only(notificationsFor(ended('completed', { turns: 1 }))).body, '1 turn');
  assert.equal(only(notificationsFor(ended('failed'))).body, 'boom');
  assert.equal(only(notificationsFor(ended('failed', { error: null }))).body, 'It ended with an error.');
  assert.deepEqual(notificationsFor(ended('stopped')), []);
  // A worker reports through its orchestration, not one by one
  assert.deepEqual(notificationsFor(ended('completed', { orchestrationId: 'o1' })), []);
});

test('an orchestration tells its own ending, whichever way it went', () => {
  const done = (status: 'completed' | 'failed', previousStatus: 'running' | null): AgentryEvent => ({
    type: 'orchestration.updated',
    ...base('o'),
    orchestrationId: 'o1',
    orchestrationName: 'refactor',
    status,
    previousStatus,
    integrationStatus: null,
    costUsd: 1,
  });
  const finished = only(notificationsFor(done('completed', 'running')));
  assert.equal(finished.kind, 'orchestration');
  assert.equal(finished.title, 'Orchestration refactor finished');
  assert.equal(finished.body, 'Every task completed.');
  assert.equal(finished.href, '/orchestration/o1');
  const failed = only(notificationsFor(done('failed', 'running')));
  assert.equal(failed.tone, 'bad');
  assert.equal(failed.title, 'Orchestration refactor failed');
  assert.equal(failed.body, 'A task failed and the graph stopped.');
  // Nothing changed is not an ending
  assert.deepEqual(notificationsFor(done('completed', null)), []);
});

test('a conflict counts the files it is about', () => {
  const conflict = (paths: string[], resolving = false): AgentryEvent => ({
    type: 'orchestration.conflict',
    ...base('Merge conflict in refactor'),
    orchestrationId: 'o1',
    orchestrationName: 'refactor',
    integrationStatus: 'conflicted',
    branch: 'agentry/o1',
    paths,
    resolving,
  });
  const two = only(notificationsFor(conflict(['a.ts', 'b.ts'])));
  assert.equal(two.kind, 'conflict');
  assert.equal(two.body, '2 files in agentry/o1 need your attention.');
  assert.equal(only(notificationsFor(conflict(['a.ts']))).body, '1 file in agentry/o1 need your attention.');
  assert.equal(only(notificationsFor(conflict(['a.ts', 'b.ts'], true))).body, '2 files in agentry/o1.');
});

test('a rate limit and the account it moved to are one kind', () => {
  const limited: AgentryEvent = { type: 'run.rateLimited', ...base('limited'), ...run };
  const draft = only(notificationsFor(limited));
  assert.equal(draft.kind, 'limit');
  assert.equal(draft.title, 'fix the build hit a rate limit');
  assert.equal(draft.body, 'The turn stopped because the account ran out of quota.');

  const rotated = (extra: Partial<Extract<AgentryEvent, { type: 'run.accountRotated' }>> = {}): AgentryEvent => ({
    type: 'run.accountRotated',
    ...base('rotated'),
    ...run,
    from: 'a@x',
    to: 'b@x',
    resumed: true,
    ...extra,
  });
  assert.equal(only(notificationsFor(rotated())).body, 'a@x → b@x, and the turn was replayed.');
  assert.equal(only(notificationsFor(rotated({ resumed: false }))).body, 'a@x → b@x.');
  // Accounts Agentry cannot name are still an account
  assert.equal(only(notificationsFor(rotated({ from: null, to: null, resumed: false }))).body, 'The previous account → the next account.');
});

test('finished work inside a chat stays low unless it failed, and opens the panel that shows it', () => {
  const task = (status: string): AgentryEvent => ({
    type: 'task.ended',
    ...base('npm test'),
    runId: 'run1',
    runName: 'fix the build',
    sessionId: 's1',
    taskId: 't1',
    taskType: 'bash',
    description: 'npm test',
    status,
    summary: null,
    fromSubagent: true,
  });
  const done = only(notificationsFor(task('completed')));
  assert.equal(done.kind, 'activity');
  assert.equal(done.priority, 'low');
  assert.equal(done.body, 'Started by a subagent.');
  assert.equal(done.href, '/chats/s1?detail=task%3As1%3At1');
  assert.equal(only(notificationsFor(task('failed'))).priority, 'normal');
});

test('a chat that looks stuck carries the reason the server wrote, and a recovery is not news', () => {
  const health = (level: 'ok' | 'warn' | 'bad'): AgentryEvent => ({
    type: 'health.changed',
    ...base('fix the build: `pnpm e2e` has been running for 5 min'),
    ...run,
    taskId: null,
    taskName: null,
    level,
    previousLevel: 'ok',
    reason: '`pnpm e2e` has been running for 5 min.',
    reasonCode: 'health.hungCommand.usual',
    signals: ['hung-command'],
  });
  const stuck = only(notificationsFor(health('warn')));
  assert.equal(stuck.kind, 'health');
  assert.equal(stuck.priority, 'normal');
  // With no translations of its own, a sender says the sentence the server already wrote
  assert.equal(stuck.body, '`pnpm e2e` has been running for 5 min.');
  assert.equal(stuck.key, 'health:run1:hung-command');
  assert.equal(only(notificationsFor(health('bad'))).priority, 'high');
  assert.deepEqual(notificationsFor(health('ok')), []);
});

test('every kind the preferences list can be produced by some event', () => {
  const events: AgentryEvent[] = [
    waiting(),
    { type: 'run.ended', ...base('done'), ...run, status: 'completed', error: null, turns: 1, costUsd: 0 },
    { type: 'orchestration.updated', ...base('o'), orchestrationId: 'o1', orchestrationName: 'refactor', status: 'completed', previousStatus: 'running', integrationStatus: null, costUsd: 0 },
    { type: 'orchestration.conflict', ...base('c'), orchestrationId: 'o1', orchestrationName: 'refactor', integrationStatus: 'conflicted', branch: 'b', paths: ['a.ts'], resolving: false },
    { type: 'run.rateLimited', ...base('limited'), ...run },
    { type: 'subagent.ended', ...base('sub'), ...run, sessionId: 's9', toolUseId: 'tu1', agentId: 'a1', subagentType: 'Explore', description: 'find things', status: 'completed' },
    { type: 'health.changed', ...base('stuck'), ...run, taskId: null, taskName: null, level: 'bad', previousLevel: 'ok', reason: 'Stuck.', signals: ['loop'] },
  ];
  assert.deepEqual(events.flatMap((event) => notificationsFor(event)).map((draft) => draft.kind), KINDS);
});

test('the mapping is the same news for a prompt heard live and one found on a reload', () => {
  const chat = { id: 'run1', title: 'fix the build', orchestration: null };
  const live = only(notificationsFor(waiting('p1')));
  const [seeded] = waitingDrafts(chat, [{ id: 'p1', runId: 'run1', toolName: 'Bash', toolUseId: 'tu1', input: {}, requestedAt: AT }]);
  assert.ok(seeded);
  assert.equal(seeded.key, live.key);
  assert.equal(seeded.href, live.href);
  assert.equal(seeded.title, live.title);
  assert.equal(seeded.permissionId, 'p1');
});

test('answering or ending settles what was waiting, and nothing else does', () => {
  const resolved: AgentryEvent = { type: 'permission.resolved', ...base('resolved'), ...run, permissionId: 'p1', toolName: 'Bash', outcome: 'allow' };
  const open = only(notificationsFor(waiting('p1')));
  const other = only(notificationsFor(waiting('p2')));
  const matches = settlesWaiting(resolved);
  assert.ok(matches);
  assert.equal(matches(open), true);
  assert.equal(matches(other), false);

  const ended = settlesWaiting({ type: 'run.removed', ...base('removed'), runId: 'run1' });
  assert.ok(ended);
  assert.equal(ended(open), true);
  assert.equal(settlesWaiting(waiting()), null);
});

test('nothing in the mapping reaches for a browser: the sender runs it in Node', () => {
  for (const file of ['notifications.ts', 'detail.ts']) {
    // Comments go first: they are free to talk about a dedupe window or the browser's own bookkeeping
    const code = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    assert.equal(code.match(/\b(window|document|localStorage|sessionStorage|navigator)\b/)?.[0], undefined, `${file} reaches for the browser`);
  }
});

test('the level decides what interrupts, from everything down to nothing, and background activity never does', () => {
  const n = (kind: NotificationDraft['kind'], priority: NotificationDraft['priority'], tone: NotificationDraft['tone']) => ({ kind, priority, tone });
  const waiting = n('waiting', 'high', 'warn');
  const failed = n('run', 'normal', 'bad');
  const orchestrationDone = n('orchestration', 'normal', 'ok');
  const conflict = n('conflict', 'normal', 'warn');
  const turnDone = n('run', 'normal', 'ok');
  const rotated = n('limit', 'normal', 'info');
  const subagentDone = n('activity', 'low', 'ok');
  const all = [waiting, failed, orchestrationDone, conflict, turnDone, rotated, subagentDone];
  const passing = (level: (typeof LEVELS)[number]) => all.filter((x) => interrupts(x, level));

  assert.deepEqual(passing('all'), [waiting, failed, orchestrationDone, conflict, turnDone, rotated]);
  assert.deepEqual(passing('important'), [waiting, failed, orchestrationDone, conflict]);
  assert.deepEqual(passing('urgent'), [waiting]);
  assert.deepEqual(passing('silent'), []);
});
