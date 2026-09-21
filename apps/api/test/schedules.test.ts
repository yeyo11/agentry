import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { Schedule, ScheduleChangedEvent, SchedulePreview, ScheduleRun } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;
let core: Core;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const body = { name: 'nightly', cron: '0 3 * * *', timezone: 'UTC', target: { kind: 'chat', chat: { prompt: 'tidy up' } } };

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-schedules-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  core.shutdown();
});

test('a schedule is created, listed, edited, switched off and deleted over the API', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/schedules', ...json(body) });
  assert.equal(created.statusCode, 201);
  const schedule = created.json<Schedule>();
  assert.equal(schedule.enabled, true);
  assert.ok(schedule.nextRunAt);
  assert.equal(schedule.lastRunAt, null);

  assert.equal((await app.inject('/api/schedules')).json<Schedule[]>().length, 1);
  assert.equal((await app.inject(`/api/schedules/${schedule.id}`)).json<Schedule>().name, 'nightly');

  const patched = await app.inject({ method: 'PATCH', url: `/api/schedules/${schedule.id}`, ...json({ name: 'weekly', cron: '0 3 * * 1' }) });
  assert.equal(patched.json<Schedule>().cron, '0 3 * * 1');

  const off = await app.inject({ method: 'POST', url: `/api/schedules/${schedule.id}/disable` });
  assert.equal(off.json<Schedule>().enabled, false);
  assert.equal(off.json<Schedule>().nextRunAt, null);
  const on = await app.inject({ method: 'POST', url: `/api/schedules/${schedule.id}/enable` });
  assert.ok(on.json<Schedule>().nextRunAt);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/schedules/${schedule.id}` })).statusCode, 200);
  assert.equal((await app.inject(`/api/schedules/${schedule.id}`)).statusCode, 404);
});

test('the overlap policy goes through the API, and a wrong one is a 400', async () => {
  const created = (await app.inject({ method: 'POST', url: '/api/schedules', ...json({ ...body, overlap: 'queue' }) })).json<Schedule>();
  assert.equal(created.overlap, 'queue');
  const patched = await app.inject({ method: 'PATCH', url: `/api/schedules/${created.id}`, ...json({ overlap: 'skip' }) });
  assert.equal(patched.json<Schedule>().overlap, 'skip');
  const bad = await app.inject({ method: 'POST', url: '/api/schedules', ...json({ ...body, overlap: 'sometimes' }) });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json<{ error: string }>().error, /overlap must be/);
  await app.inject({ method: 'DELETE', url: `/api/schedules/${created.id}` });
});

test('schedule events reach the global feed, and a client that reconnects with Last-Event-ID is sent what it missed', async () => {
  const cursor = core.events.lastEventId;
  const { id } = (await app.inject({ method: 'POST', url: '/api/schedules', ...json({ ...body, enabled: false }) })).json<Schedule>();
  await app.inject({ method: 'POST', url: `/api/schedules/${id}/enable` });
  const run = (await app.inject({ method: 'POST', url: `/api/schedules/${id}/run` })).json<ScheduleRun>();
  await app.inject({ method: 'DELETE', url: `/api/schedules/${id}` });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  let text = '';
  const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { 'last-event-id': String(cursor) } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => (text += chunk));
  });
  req.end();
  try {
    const deadline = Date.now() + 3000;
    while (!/"action":"deleted"/.test(text)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the replay; got:\n${text}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    req.destroy();
  }
  const replayed = [...text.matchAll(/event: (schedule\.\w+)\ndata: (.*)\n/g)].map(([, type, data]) => ({ type, ...(JSON.parse(data ?? '{}') as Partial<ScheduleChangedEvent> & { runId?: string }) }));
  assert.deepEqual(
    replayed.filter((e) => e.scheduleId === id).map((e) => (e.type === 'schedule.changed' ? e.action : e.type)),
    ['created', 'enabled', 'schedule.fired', 'deleted'],
  );
  assert.equal(replayed.find((e) => e.type === 'schedule.fired')?.runId, run.id);
});

test('a wrong expression or a missing schedule is a 4xx that says why', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/schedules', ...json({ ...body, cron: '99 * * * *' }) });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json<{ error: string }>().error, /minute: 99 is outside 0-59/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/schedules/nope/run' })).statusCode, 404);
  assert.equal((await app.inject('/api/schedules/nope/runs')).statusCode, 404);
});

test('run now records what happened, and a target that cannot start is a failed run, not an error', async () => {
  const { id } = (await app.inject({ method: 'POST', url: '/api/schedules', ...json({ ...body, enabled: false }) })).json<Schedule>();
  // The CLI is missing in this environment: starting the chat cannot succeed, and the history says so
  const run = await app.inject({ method: 'POST', url: `/api/schedules/${id}/run` });
  assert.equal(run.statusCode, 201);
  const history = (await app.inject(`/api/schedules/${id}/runs`)).json<ScheduleRun[]>();
  assert.equal(history.length, 1);
  assert.equal(history[0]?.id, run.json<ScheduleRun>().id);
  assert.ok(history[0]?.status === 'failed' ? history[0].error : history[0]?.chatId, 'a run says what it produced or why it did not');
  assert.equal(history[0]?.slot, undefined);
});

test('the preview is reachable before "/schedules/:id" and explains an expression without saving it', async () => {
  const ok = (await app.inject('/api/schedules/preview?cron=*/15+9-17+*+*+mon-fri&timezone=Europe/Madrid&count=2')).json<SchedulePreview>();
  assert.equal(ok.valid, true);
  assert.equal(ok.description, 'Every 15 minutes of the hours 9 to 17, on Monday to Friday');
  assert.equal(ok.next.length, 2);
  const bad = (await app.inject('/api/schedules/preview?cron=nope')).json<SchedulePreview>();
  assert.equal(bad.valid, false);
  assert.match(bad.error ?? '', /five fields/);
});
