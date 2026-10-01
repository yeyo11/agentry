import assert from 'node:assert/strict';
import test from 'node:test';

// The wording of a notification follows navigator.languages; pin it so the texts are the English
// ones whatever the machine's locale is. Node has no localStorage, so the store lives in memory for
// this file, which is all a page that has just loaded needs.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
const { seedWaiting, waitingDrafts, ingest, removeNotification } = await import('../src/lib/notifications.ts');

const at = (offsetMs = 0) => new Date(Date.parse('2026-01-01T12:00:00Z') + offsetMs).toISOString();
const chat = { id: 'run1', title: 'fix the build', firstPrompt: null, orchestration: null };
const request = (id: string, offsetMs: number) => ({ id, runId: 'run1', toolName: 'Bash', toolUseId: `tu-${id}`, input: {}, requestedAt: at(offsetMs) });
const notSeen = () => false;

test('a page that loads while a chat is already waiting raises the notification, once', () => {
  const drafts = waitingDrafts(chat, [request('p1', -60_000)]);
  const first = seedWaiting(drafts, Date.parse(at()), notSeen);
  assert.equal(first.added.length, 1);
  assert.equal(first.added[0]?.kind, 'waiting');
  assert.match(first.added[0]?.title ?? '', /fix the build needs your approval to use Bash/);

  // A second load with the same prompt still pending adds nothing
  const again = seedWaiting(drafts, Date.parse(at(1000)), notSeen);
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.settled, []);
  removeNotification(first.added[0]!.id);
});

test('a prompt answered while no page was open is settled on load, and one newer than the read is left alone', () => {
  const [old] = seedWaiting(waitingDrafts(chat, [request('p2', -60_000)]), Date.parse(at()), notSeen).added;
  assert.ok(old);
  // The live feed told of p3 after the read was taken: the read cannot know it yet
  const live = ingest(
    { type: 'run.waiting', id: 99, at: at(5000), title: 'fix the build needs your approval to use Bash', runId: 'run1', runName: 'fix the build', sessionId: null, orchestrationId: null, internal: false, reason: 'permission', permissionId: 'p3', toolName: 'Bash' },
    notSeen,
  );
  assert.equal(live.added.length, 1);

  // The chat holds no prompt any more, as read at a moment between the two
  const seeded = seedWaiting([], Date.parse(at(1000)), notSeen);
  assert.deepEqual(seeded.settled.map((n) => n.key), [old.key]);
  assert.equal(seeded.settled[0]?.resolved, true);
  assert.deepEqual(seeded.added, []);
});
