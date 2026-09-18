import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isLiveCliSession } from '../src/cli.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

const line = (o: object) => JSON.stringify(o);

test('summarizes sessions and reads transcripts', async () => {
  const config = tempConfig();
  const dir = join(config.projectsDir, '-work-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'aaaa-1111.jsonl'),
    [
      line({ type: 'mode', mode: 'normal' }),
      line({ type: 'user', uuid: '1', timestamp: '2026-01-01T10:00:00Z', cwd: '/work/demo', gitBranch: 'main', version: '2.1.0', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      line({ type: 'user', uuid: '2', timestamp: '2026-01-01T10:00:01Z', cwd: '/work/demo', message: { role: 'user', content: 'Fix the login bug\nplease' } }),
      line({ type: 'assistant', uuid: '3', timestamp: '2026-01-01T10:00:05Z', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'On it' }] } }),
      line({ type: 'assistant', uuid: '4', isSidechain: true, timestamp: '2026-01-01T10:00:06Z', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
      '{"broken json',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'empty-0000.jsonl'), line({ type: 'mode', mode: 'normal' }));

  const store = new SessionStore(config);
  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1); // sessions without messages are hidden
  const [s] = sessions;
  assert.equal(s?.title, 'Fix the login bug'); // synthetic <command> message skipped
  assert.equal(s?.messageCount, 3); // sidechain not counted
  assert.equal(s?.projectPath, '/work/demo');
  assert.equal(s?.model, 'claude-sonnet');
  assert.equal(s?.gitBranch, 'main');
  assert.equal(s?.updatedAt, '2026-01-01T10:00:06Z');

  const projects = await store.listProjects();
  assert.deepEqual(projects.map((p) => [p.id, p.path, p.name, p.sessionCount]), [['-work-demo', '/work/demo', 'demo', 1]]);

  assert.equal((await store.getSession('aaaa-1111'))?.entries.length, 3);
  assert.equal((await store.getSession('aaaa-1111', { includeSidechains: true }))?.entries.length, 4);
  assert.equal(await store.getSession('missing'), null);
  await assert.rejects(store.deleteSession('missing'), /not found/);
  assert.equal(await store.getSession('../../etc/passwd'), null);

  await store.deleteSession('aaaa-1111');
  assert.deepEqual(await store.listSessions(), []);
});

test('a spare session is one with a transcript but no user turn', async () => {
  const config = tempConfig();
  const dir = join(config.projectsDir, '-work-spare');
  mkdirSync(dir, { recursive: true });
  // What `claude attach` leaves behind: the slash command that spawned it and nothing else
  writeFileSync(
    join(dir, 'bbbb-2222.jsonl'),
    [
      line({ type: 'user', uuid: '1', timestamp: '2026-01-01T10:00:00Z', cwd: '/work/spare', message: { role: 'user', content: '<command-name>/resume</command-name>' } }),
      line({ type: 'user', uuid: '2', timestamp: '2026-01-01T10:00:01Z', cwd: '/work/spare', message: { role: 'user', content: '<local-command-stdout>(no content)</local-command-stdout>' } }),
    ].join('\n'),
  );

  const store = new SessionStore(config);
  const spare = await store.summary('bbbb-2222');
  assert.equal(spare?.firstPrompt, null); // the signature the liveness rule keys on
  assert.equal(spare?.messageCount, 2); // it is not empty, so the store still lists it
  assert.equal(spare?.title, '/resume'); // the command that spawned it, not its own uuid
  assert.equal(await store.summary('nope-9999'), null);
});

test('only a session someone is working in counts as live', () => {
  const real = { firstPrompt: 'Fix the login bug' };
  const spare = { firstPrompt: null };

  assert.equal(isLiveCliSession({}, real), true);
  assert.equal(isLiveCliSession({ state: 'blocked' }, real), true);
  // A process the CLI itself reports as finished, whatever its transcript says
  assert.equal(isLiveCliSession({ state: 'done' }, real), false);
  // The pre-warmed spare: a session id, a transcript, and nobody in it
  assert.equal(isLiveCliSession({ state: 'blocked' }, spare), false);
  // No transcript yet proves nothing: a session seconds old must not be dropped
  assert.equal(isLiveCliSession({}, null), true);
});
