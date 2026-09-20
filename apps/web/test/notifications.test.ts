import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent } from '@agentry/shared';

// The wording of a notification follows navigator.languages; pin it so these texts are the English
// ones whatever the machine's locale is.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
const {
  addNotifications,
  defaultPrefs,
  hasUrgent,
  isRedundant,
  MAX_NOTIFICATIONS,
  notificationsFor,
  parseStored,
  serializeStored,
  settle,
  settlesWaiting,
  unreadCount,
  waitingDrafts,
} = await import('../src/lib/notifications-model.ts');
type AppNotification = import('../src/lib/notifications-model.ts').AppNotification;
type NotificationDraft = import('../src/lib/notifications-model.ts').NotificationDraft;

let nextId = 1;
const at = (offsetMs = 0) => new Date(Date.parse('2026-01-01T12:00:00Z') + offsetMs).toISOString();
const base = (title: string, offsetMs = 0) => ({ id: nextId++, at: at(offsetMs), title });
const run = { runId: 'run1', runName: 'fix the build', sessionId: null, orchestrationId: null, internal: false };

const waiting = (permissionId = 'p1', reason: 'permission' | 'question' | 'plan' = 'permission'): AgentryEvent => ({
  type: 'run.waiting',
  ...base('fix the build needs your approval to use Bash'),
  ...run,
  reason,
  permissionId,
  toolName: 'Bash',
});

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

const apply = (items: AppNotification[], events: AgentryEvent[], prefs = defaultPrefs(), now = Date.parse(at(1000))) => {
  let list = items;
  const added: AppNotification[] = [];
  for (const event of events) {
    const settlement = settlesWaiting(event);
    if (settlement) list = settle(list, settlement).items;
    const result = addNotifications(list, notificationsFor(event), prefs, () => false, now);
    list = result.items;
    added.push(...result.added);
  }
  return { items: list, added };
};

test('a run waiting for the person is the highest priority and links straight to the run', () => {
  const [n] = notificationsFor(waiting());
  assert.ok(n);
  assert.equal(n.priority, 'high');
  assert.equal(n.kind, 'waiting');
  // Naming the prompt lets the chat page scroll to it instead of leaving the person to find it
  assert.equal(n.href, '/chats/run1?prompt=p1');
  assert.match(n.body, /Bash/);
});

test('questions and plans get their own wording rather than the tool approval text', () => {
  assert.match(notificationsFor(waiting('q', 'question'))[0]?.body ?? '', /answer/i);
  assert.match(notificationsFor(waiting('pl', 'plan'))[0]?.body ?? '', /plan/i);
});

test('two prompts of one run are two notifications, and the same prompt is never told twice', () => {
  const { items } = apply([], [waiting('a'), waiting('b'), waiting('a')]);
  assert.equal(items.length, 2);
});

test('answering, withdrawing or ending a run settles its waiting notifications and marks them read', () => {
  const resolved: AgentryEvent = { type: 'permission.resolved', ...base('resolved'), ...run, permissionId: 'a', toolName: 'Bash', outcome: 'allow' };
  const { items } = apply([], [waiting('a'), waiting('b'), resolved]);
  const byKey = new Map(items.map((n) => [n.key, n]));
  assert.equal(byKey.get('wait:run1:a')?.resolved, true);
  assert.equal(byKey.get('wait:run1:a')?.read, true);
  assert.equal(byKey.get('wait:run1:b')?.resolved, false);
  assert.equal(hasUrgent(items), true);

  const gone = apply(items, [{ type: 'run.removed', ...base('removed'), runId: 'run1' }]);
  assert.equal(hasUrgent(gone.items), false);
  assert.ok(gone.items.every((n) => n.resolved));
});

test('housekeeping runs never notify', () => {
  const internal = { ...run, internal: true };
  assert.deepEqual(notificationsFor({ ...(waiting() as Extract<AgentryEvent, { type: 'run.waiting' }>), ...internal }), []);
  assert.deepEqual(notificationsFor(ended('failed', internal)), []);
});

test('a finished turn and the process ending after it are told once', () => {
  const turn: AgentryEvent = {
    type: 'run.updated',
    ...base('idle'),
    ...run,
    status: 'idle',
    previousStatus: 'busy',
    turns: 3,
    costUsd: 0.1,
    pendingPrompts: 0,
  };
  const { items } = apply([], [turn, ended('completed')]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.tone, 'ok');
});

test('a failed run says why, and a run the person stopped is not news', () => {
  const failed = apply([], [ended('failed')]).items[0];
  assert.equal(failed?.tone, 'bad');
  assert.equal(failed?.body, 'boom');
  assert.deepEqual(notificationsFor(ended('stopped')), []);
});

test('workers of an orchestration report through the orchestration, not one by one', () => {
  assert.deepEqual(notificationsFor(ended('completed', { orchestrationId: 'o1' })), []);
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
  assert.equal(notificationsFor(done('completed', 'running'))[0]?.href, '/orchestration/o1');
  assert.equal(notificationsFor(done('failed', 'running'))[0]?.tone, 'bad');
  // A newly created orchestration or a status that did not change is not a finish
  assert.deepEqual(notificationsFor(done('completed', null)), []);
});

test('an integration conflict links to the orchestration and counts the files', () => {
  const conflict: AgentryEvent = {
    type: 'orchestration.conflict',
    ...base('Merge conflict in refactor'),
    orchestrationId: 'o1',
    orchestrationName: 'refactor',
    integrationStatus: 'conflicted',
    branch: 'agentry/o1',
    paths: ['a.ts', 'b.ts'],
    resolving: false,
  };
  const [n] = notificationsFor(conflict);
  assert.equal(n?.kind, 'conflict');
  assert.match(n?.body ?? '', /2 files/);
});

test('rate limits and account rotation are notified with the run they stopped', () => {
  const limited: AgentryEvent = { type: 'run.rateLimited', ...base('limited'), ...run };
  const rotated: AgentryEvent = { type: 'run.accountRotated', ...base('rotated'), ...run, from: 'a@x', to: 'b@x', resumed: true };
  const { items } = apply([], [limited, rotated]);
  assert.deepEqual(items.map((n) => n.kind), ['limit', 'limit']);
  assert.match(items[0]?.body ?? '', /a@x → b@x.*replayed/);
});

test('finished tasks and subagents stay low priority unless they failed', () => {
  const task = (status: string): AgentryEvent => ({
    type: 'task.ended',
    ...base('task'),
    runId: 'run1',
    runName: 'fix the build',
    sessionId: 's1',
    taskId: 't1',
    taskType: 'bash',
    description: 'npm test',
    status,
    summary: null,
    fromSubagent: false,
  });
  assert.equal(notificationsFor(task('completed'))[0]?.priority, 'low');
  assert.equal(notificationsFor(task('failed'))[0]?.priority, 'normal');
  const sub: AgentryEvent = {
    type: 'subagent.ended',
    ...base('sub'),
    runId: '',
    runName: '',
    sessionId: 's9',
    toolUseId: 'tu1',
    agentId: 'a1',
    subagentType: 'Explore',
    description: 'find things',
    status: 'completed',
  };
  // The side panel is the most specific place; it opens over the chat, which a terminal's chat has too
  assert.equal(notificationsFor(sub)[0]?.href, '/chats/s9?detail=subagent%3As9%3Aa1');
  // Without the agent's id there is no panel to open: the chat is the next best place
  assert.equal(notificationsFor({ ...sub, agentId: null })[0]?.href, '/chats/s9');
});

test('a finished workflow opens the agent that ended it, and the chat when it names none', () => {
  const workflow: AgentryEvent = {
    type: 'workflow.ended',
    ...base('wf'),
    runId: 'run1',
    runName: 'fix the build',
    sessionId: 's9',
    workflowId: 'wf_1',
    taskId: null,
    agentId: 'a7',
    name: 'audit',
    status: 'completed',
    summary: null,
    totalTokens: null,
  };
  assert.equal(notificationsFor(workflow)[0]?.href, '/chats/s9?detail=workflow-agent%3As9%3Awf_1%3Aa7');
  assert.equal(notificationsFor({ ...workflow, agentId: null })[0]?.href, '/chats/s9');
  // A workflow the CLI has not given a `wf_` id has no agent transcripts to open
  assert.equal(notificationsFor({ ...workflow, workflowId: 'task-3' })[0]?.href, '/chats/s9');
});

test('the same news inside the window is dropped, and comes back once the window has passed', () => {
  const limited = (offsetMs: number): AgentryEvent => ({ type: 'run.rateLimited', ...base('limited', offsetMs), ...run });
  const first = apply([], [limited(0)], defaultPrefs(), Date.parse(at(0)));
  const soon = apply(first.items, [limited(5_000)], defaultPrefs(), Date.parse(at(5_000)));
  assert.equal(soon.items.length, 1);
  const later = apply(first.items, [limited(120_000)], defaultPrefs(), Date.parse(at(120_000)));
  assert.equal(later.items.length, 2);
});

test('the list is capped at its newest notifications', () => {
  const events = Array.from({ length: MAX_NOTIFICATIONS + 25 }, (_, i) => waiting(`p${i}`));
  const { items } = apply([], events);
  assert.equal(items.length, MAX_NOTIFICATIONS);
  assert.equal(items[0]?.key, `wait:run1:p${MAX_NOTIFICATIONS + 24}`);
});

test('a kind the person switched off is not recorded at all', () => {
  const prefs = defaultPrefs();
  prefs.kinds.run = false;
  assert.equal(apply([], [ended('completed')], prefs).items.length, 0);
  assert.equal(apply([], [waiting()], prefs).items.length, 1);
});

test('what the person was already looking at arrives read', () => {
  const seen = (d: NotificationDraft) => isRedundant(d, '/chats/run1', true);
  const { items, added } = addNotifications([], notificationsFor(waiting()), defaultPrefs(), seen);
  assert.equal(items[0]?.read, true);
  assert.equal(unreadCount(items), 0);
  assert.equal(added.length, 1);
});

test('a hidden tab or another page is never redundant', () => {
  const [n] = notificationsFor(waiting());
  assert.ok(n);
  assert.equal(isRedundant(n, '/chats/run1', false), false);
  assert.equal(isRedundant(n, '/chats/run2', true), false);
  assert.equal(isRedundant(n, '/chats', true), false);
});

test('saved notifications and preferences survive a round trip', () => {
  const prefs = defaultPrefs();
  prefs.toasts = false;
  prefs.kinds.activity = false;
  const { items } = apply([], [waiting(), ended('failed')], prefs);
  const restored = parseStored(serializeStored({ items, prefs }));
  assert.deepEqual(restored.items, items);
  assert.deepEqual(restored.prefs, prefs);
});

test('corrupt or foreign storage gives an empty, usable state instead of an error', () => {
  for (const raw of [null, '', '{', '[]', '"x"', JSON.stringify({ version: 99, items: [] }), JSON.stringify({ items: [] })]) {
    const restored = parseStored(raw);
    assert.deepEqual(restored.items, []);
    assert.deepEqual(restored.prefs, defaultPrefs());
  }
});

test('storage keeps the entries that are valid and drops the ones that are not', () => {
  const good = apply([], [waiting()]).items[0];
  const raw = JSON.stringify({
    version: 1,
    items: [good, null, 7, { id: 'x' }, { ...good, kind: 'nonsense' }, { ...good, id: 'other', key: 'k2', read: 'yes' }],
    prefs: { toasts: 'nope', browser: true, kinds: { run: false, waiting: 'x' } },
  });
  const restored = parseStored(raw);
  assert.deepEqual(restored.items.map((n) => n.id), [good?.id, 'other']);
  // A non-boolean read flag is not trusted
  assert.equal(restored.items[1]?.read, false);
  // Unknown or malformed preferences fall back to the defaults, valid ones are kept
  assert.equal(restored.prefs.toasts, true);
  assert.equal(restored.prefs.browser, true);
  assert.equal(restored.prefs.kinds.run, false);
  assert.equal(restored.prefs.kinds.waiting, true);
});

test('a prompt a chat was already holding when the page loaded becomes the same notification its event would have made', () => {
  const chat = { id: 'run1', title: 'fix the build', orchestration: null };
  const request = { id: 'p1', runId: 'run1', toolName: 'Bash', toolUseId: 'tu1', input: {}, requestedAt: at(-5000) };
  const [seeded] = waitingDrafts(chat, [request]);
  assert.ok(seeded);
  assert.equal(seeded.kind, 'waiting');
  assert.equal(seeded.priority, 'high');
  assert.equal(seeded.at, at(-5000));
  assert.match(seeded.title, /fix the build needs your approval to use Bash/);
  assert.equal(seeded.key, notificationsFor(waiting('p1'))[0]?.key);
  assert.equal(seeded.href, notificationsFor(waiting('p1'))[0]?.href);

  // The live event arriving after the seed does not double it
  const { items } = apply(addNotifications([], [seeded], defaultPrefs(), () => false).items, [waiting('p1')]);
  assert.equal(items.length, 1);
});

test('seeded questions and plans read as such, and carry the orchestration they work for', () => {
  const chat = { id: 'run1', title: 'plan the work', orchestration: { id: 'o1', name: 'graph', taskId: 't1', taskName: 'plan' } };
  const [question, plan] = waitingDrafts(chat, [
    { id: 'q', runId: 'run1', toolName: 'AskUserQuestion', toolUseId: 'a', input: {}, requestedAt: at() },
    { id: 'pl', runId: 'run1', toolName: 'ExitPlanMode', toolUseId: 'b', input: {}, requestedAt: at() },
  ]);
  assert.match(question?.title ?? '', /asking you a question/);
  assert.match(plan?.title ?? '', /plan for you to approve/);
  assert.equal(question?.orchestrationId, 'o1');
});
