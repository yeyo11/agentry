import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationsFor as englishDraftsFor, waitingDrafts as englishWaitingDrafts, type AgentryEvent } from '@agentry/shared';

/*
 * The words a notification is born with come from two places: i18next in the browser, and the
 * English built into `@agentry/shared` for the push sender, which has no language of its own. They
 * are the same sentences written twice, so this holds them together: every event below goes
 * through both and must come out saying exactly the same thing.
 */

// The wording follows navigator.languages; pin it so the web's side of the comparison is English.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
const { notificationsFor, waitingDrafts } = await import('../src/lib/notifications-model.ts');

let nextId = 1;
const AT = '2026-01-01T12:00:00Z';
const base = (title: string) => ({ id: nextId++, at: AT, title });
const run = { runId: 'run1', runName: 'fix the build', sessionId: null, orchestrationId: null, internal: false };
const ended = (turns: number, error: string | null): AgentryEvent => ({ type: 'run.ended', ...base('done'), ...run, status: error ? 'failed' : 'completed', error, turns, costUsd: 0.1 });
const rotated = (from: string | null, resumed: boolean): AgentryEvent => ({ type: 'run.accountRotated', ...base('rotated'), ...run, from, to: from ? 'b@x' : null, resumed });
const orchestration = (status: 'completed' | 'failed'): AgentryEvent => ({
  type: 'orchestration.updated',
  ...base('o'),
  orchestrationId: 'o1',
  orchestrationName: 'refactor',
  status,
  previousStatus: 'running',
  integrationStatus: null,
  costUsd: 1,
});
const conflict = (paths: string[], resolving: boolean): AgentryEvent => ({
  type: 'orchestration.conflict',
  ...base('Merge conflict in refactor'),
  orchestrationId: 'o1',
  orchestrationName: 'refactor',
  integrationStatus: 'conflicted',
  branch: 'agentry/o1',
  paths,
  resolving,
});

// One event per sentence, including both halves of every plural and the fallbacks for an account
// or an error Agentry cannot name.
const EVENTS: AgentryEvent[] = [
  { type: 'run.waiting', ...base('waiting'), ...run, reason: 'permission', permissionId: 'p1', toolName: 'Bash' },
  { type: 'run.waiting', ...base('waiting'), ...run, reason: 'question', permissionId: 'p2', toolName: 'AskUserQuestion' },
  { type: 'run.waiting', ...base('waiting'), ...run, reason: 'plan', permissionId: 'p3', toolName: 'ExitPlanMode' },
  { type: 'run.updated', ...base('idle'), ...run, status: 'idle', previousStatus: 'busy', turns: 2, costUsd: 0.1, pendingPrompts: 0 },
  ended(1, null),
  ended(3, null),
  ended(3, 'boom'),
  // A run that failed without saying why is the one case that needs a sentence of ours
  { ...(ended(3, 'boom') as Extract<AgentryEvent, { type: 'run.ended' }>), error: null },
  { type: 'run.rateLimited', ...base('limited'), ...run },
  rotated('a@x', true),
  rotated('a@x', false),
  rotated(null, false),
  orchestration('completed'),
  orchestration('failed'),
  conflict(['a.ts'], false),
  conflict(['a.ts', 'b.ts'], false),
  conflict(['a.ts'], true),
  conflict(['a.ts', 'b.ts'], true),
  { type: 'task.ended', ...base('npm test'), ...run, sessionId: 's1', taskId: 't1', taskType: 'bash', description: 'npm test', status: 'completed', summary: null, fromSubagent: true },
  { type: 'supervisor.proposed', ...base('hint'), ...run, taskId: null, taskName: null, proposal: { id: 'sp1', chatId: 'run1', signal: 'hung-command', hint: 'Run the unit tests instead.', costUsd: 0.01, at: AT, status: 'proposed' } },
  { type: 'health.changed', ...base('stuck'), ...run, taskId: null, taskName: null, level: 'warn', previousLevel: 'ok', reason: 'It has been quiet for 5 min.', signals: ['hung-command'] },
];

for (const [index, event] of EVENTS.entries()) {
  const kind = event.type === 'run.waiting' ? `${event.type}:${event.reason}` : event.type;
  test(`the web and the push sender say the same thing about ${kind} (${index})`, () => {
    assert.deepEqual(notificationsFor(event), englishDraftsFor(event));
  });
}

test('the web and the push sender say the same thing about a prompt found on a reload', () => {
  const chat = { id: 'run1', title: 'fix the build', firstPrompt: null, orchestration: null };
  const requests = [
    { id: 'p1', runId: 'run1', toolName: 'Bash', toolUseId: 'a', input: {}, requestedAt: AT },
    { id: 'q', runId: 'run1', toolName: 'AskUserQuestion', toolUseId: 'b', input: {}, requestedAt: AT },
    { id: 'pl', runId: 'run1', toolName: 'ExitPlanMode', toolUseId: 'c', input: {}, requestedAt: AT },
  ];
  assert.deepEqual(waitingDrafts(chat, requests), englishWaitingDrafts(chat, requests));
});

test('a sentence the server wrote is left alone when this build has no key for its code', () => {
  const unknown: AgentryEvent = {
    type: 'health.changed',
    ...base('stuck'),
    ...run,
    taskId: null,
    taskName: null,
    level: 'bad',
    previousLevel: 'ok',
    reason: 'Something this build has never heard of.',
    reasonCode: 'health.fromTheFuture',
    signals: ['loop'],
  };
  assert.deepEqual(notificationsFor(unknown), englishDraftsFor(unknown));
});
