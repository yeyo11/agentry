import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { NewChatRequest, OrchestrationSpec, ScheduleTarget } from '@agentry/shared';
import { previewCron, Scheduler, type ScheduleLauncher } from '../src/schedules.ts';
import { tempConfig } from './helpers.ts';

const at = (iso: string) => Date.parse(iso);
const chatTarget: ScheduleTarget = { kind: 'chat', chat: { prompt: 'summarise the night' } };

/** A scheduler on a clock the test moves, with launchers that record what they were asked to start. */
function rig(config = tempConfig(), start = '2026-09-20T08:00:00Z') {
  const state = { now: at(start), chats: [] as NewChatRequest[], orchestrations: [] as OrchestrationSpec[], failWith: null as string | null };
  const launcher: ScheduleLauncher = {
    chat: async (request) => {
      if (state.failWith) throw new Error(state.failWith);
      state.chats.push(request);
      return { id: `chat-${state.chats.length}` };
    },
    orchestration: (spec) => {
      state.orchestrations.push(spec);
      return { id: `orch-${state.orchestrations.length}` };
    },
  };
  const open = () => new Scheduler(config, launcher, () => state.now);
  return { config, state, scheduler: open(), open };
}

const daily = { name: 'daily', cron: '0 9 * * *', timezone: 'UTC', target: chatTarget };

test('a slot fires once when its time comes and not again on the next tick', async () => {
  const { scheduler, state } = rig();
  const created = await scheduler.create(daily);
  assert.equal(created.nextRunAt, '2026-09-20T09:00:00.000Z');

  state.now = at('2026-09-20T08:59:50Z');
  await scheduler.tick();
  assert.equal(state.chats.length, 0);

  state.now = at('2026-09-20T09:00:10Z');
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(state.chats.length, 1);
  assert.deepEqual(state.chats[0], { prompt: 'summarise the night' });

  const [run] = scheduler.history(created.id);
  assert.equal(run?.status, 'started');
  assert.equal(run?.chatId, 'chat-1');
  assert.equal(run?.slot, '2026-09-20T09:00:00.000Z');
  assert.equal(scheduler.get(created.id).lastRunAt, run?.at);
  assert.equal(scheduler.get(created.id).nextRunAt, '2026-09-21T09:00:00.000Z');
});

test('a restart does not fire the slot it already fired', async () => {
  const first = rig();
  const { id } = await first.scheduler.create(daily);
  first.state.now = at('2026-09-20T09:00:05Z');
  await first.scheduler.tick();
  first.scheduler.close();

  // The same data directory, a new process, the clock a few seconds on
  const second = first.open();
  first.state.now = at('2026-09-20T09:00:40Z');
  await second.tick();
  assert.equal(first.state.chats.length, 1);
  assert.equal(second.history(id).length, 1);
  second.close();
});

test('two processes sharing a data dir launch a slot once between them', async () => {
  const a = rig();
  const b = a.open();
  const { id } = await a.scheduler.create(daily);
  a.state.now = at('2026-09-20T09:00:05Z');
  await Promise.all([a.scheduler.tick(), b.tick()]);
  assert.equal(a.state.chats.length, 1);
  assert.equal(b.history(id).length, 1);
  a.scheduler.close();
  b.close();
});

test('a window missed while the wrapper was down is skipped, once, and not run late', async () => {
  const first = rig();
  const { id } = await first.scheduler.create({ ...daily, cron: '0 * * * *' }); // hourly
  first.state.now = at('2026-09-20T09:00:05Z');
  await first.scheduler.tick();
  first.scheduler.close();
  assert.equal(first.state.chats.length, 1);

  // Down until 13:30: the 10:00, 11:00, 12:00 and 13:00 slots went by
  first.state.now = at('2026-09-20T13:30:00Z');
  const second = first.open();
  await second.tick();
  assert.equal(first.state.chats.length, 1, 'nothing is replayed');

  const runs = second.history(id);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.status, 'skipped');
  assert.match(runs[0]?.error ?? '', /4 slots between 2026-09-20T10:00:00.000Z and 2026-09-20T13:00:00.000Z/);
  assert.equal(second.get(id).lastRunAt, runs[1]?.at, 'a skipped slot is not a run');

  // The next slot after the outage fires as usual, and the outage is not skipped a second time
  first.state.now = at('2026-09-20T14:00:03Z');
  await second.tick();
  assert.equal(first.state.chats.length, 2);
  assert.equal(second.history(id).length, 3);
  second.close();
});

test('a slot that came due a moment ago, at boot, still fires: the outage is not what was missed', async () => {
  const first = rig();
  await first.scheduler.create(daily);
  first.scheduler.close();
  first.state.now = at('2026-09-20T09:00:30Z');
  const second = first.open();
  await second.tick();
  assert.equal(first.state.chats.length, 1);
  second.close();
});

test('the time a schedule was disabled is not a missed window, and re-enabling starts its clock afresh', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create(daily);
  const off = await scheduler.update(id, { enabled: false });
  assert.equal(off.nextRunAt, null);

  state.now = at('2026-09-23T10:00:00Z');
  await scheduler.tick();
  assert.equal(state.chats.length, 0);
  assert.equal(scheduler.history(id).length, 0);

  const on = await scheduler.update(id, { enabled: true });
  assert.equal(on.nextRunAt, '2026-09-24T09:00:00.000Z');
  await scheduler.tick();
  assert.equal(scheduler.history(id).length, 0, 'the three slots it slept through are nobody\'s to skip');
  scheduler.close();
});

test('run now starts the target outside the timetable, even disabled, and leaves the timetable alone', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create({ ...daily, enabled: false });
  const run = await scheduler.runNow(id);
  assert.equal(run.status, 'started');
  assert.equal(run.chatId, 'chat-1');
  assert.equal(run.slot, undefined);

  await scheduler.runNow(id);
  assert.equal(scheduler.history(id).length, 2, 'two manual runs do not collide: they have no slot');
  assert.equal(state.chats.length, 2);
  scheduler.close();
});

test('an orchestration target records the orchestration it started', async () => {
  const { scheduler, state } = rig();
  const spec: OrchestrationSpec = { name: 'nightly', tasks: [{ id: 'a', name: 'check', prompt: 'check' }] };
  const { id } = await scheduler.create({ name: 'nightly', cron: '@daily', timezone: 'UTC', target: { kind: 'orchestration', spec } });
  const run = await scheduler.runNow(id);
  assert.equal(run.orchestrationId, 'orch-1');
  assert.equal(run.chatId, undefined);
  assert.deepEqual(state.orchestrations, [spec]);
  scheduler.close();
});

test('a target that cannot start is a failed run with its reason, and the next slot still comes', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create({ ...daily, cron: '*/10 * * * *' });
  state.failWith = 'the workspace is gone';
  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick();
  const [failed] = scheduler.history(id);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.error, 'the workspace is gone');

  state.failWith = null;
  state.now = at('2026-09-20T08:20:02Z');
  await scheduler.tick();
  assert.equal(scheduler.history(id)[0]?.status, 'started');
  scheduler.close();
});

test('the definition is JSON on disk and the history is not in it', async () => {
  const { scheduler, config, state } = rig();
  const { id } = await scheduler.create(daily);
  state.now = at('2026-09-20T09:00:05Z');
  await scheduler.tick();
  const file = JSON.parse(readFileSync(join(config.dataDir, 'schedules.json'), 'utf8')) as { schedules: Array<Record<string, unknown>> };
  assert.equal(file.schedules.length, 1);
  assert.equal(file.schedules[0]?.id, id);
  assert.equal('lastRunAt' in (file.schedules[0] ?? {}), false);
  scheduler.close();
});

test('editing changes the expression, the zone and the target; deleting takes the history with it', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create(daily);
  const edited = await scheduler.update(id, { name: 'morning', cron: '30 7 * * *', timezone: 'Europe/Madrid', target: { kind: 'chat', chat: { prompt: 'other' } } });
  assert.equal(edited.name, 'morning');
  assert.equal(edited.nextRunAt, '2026-09-21T05:30:00.000Z'); // 07:30 CEST: today's slot has passed
  assert.deepEqual(edited.target, { kind: 'chat', chat: { prompt: 'other' } });
  assert.equal((await scheduler.update(id, { timezone: null })).timezone, undefined);

  await scheduler.runNow(id);
  await scheduler.remove(id);
  assert.throws(() => scheduler.get(id), /schedule not found/);
  assert.throws(() => scheduler.history(id), /schedule not found/);
  assert.equal(scheduler.list().length, 0);
  assert.equal(state.chats.length, 1);
  scheduler.close();
});

test('nothing is saved that could never run', async () => {
  const { scheduler } = rig();
  await assert.rejects(scheduler.create({ ...daily, cron: '61 * * * *' }), /minute: 61 is outside/);
  await assert.rejects(scheduler.create({ ...daily, timezone: 'Mars/Olympus' }), /not a time zone/);
  await assert.rejects(scheduler.create({ ...daily, name: '  ' }), /name is required/);
  await assert.rejects(scheduler.create({ ...daily, target: { kind: 'chat', chat: { prompt: ' ' } } }), /needs a prompt/);
  await assert.rejects(scheduler.create({ ...daily, target: { kind: 'orchestration', spec: { name: 'empty', tasks: [] } } }), /at least one task/);
  await assert.rejects(scheduler.update('nope', { enabled: true }), /schedule not found/);
  assert.equal(scheduler.list().length, 0);
  scheduler.close();
});

test('the preview says what an expression does, or which field is wrong, and saves nothing', () => {
  const ok = previewCron('30 9 * * mon-fri', 'Europe/Madrid', 3, at('2026-09-20T12:00:00Z'));
  assert.equal(ok.valid, true);
  assert.equal(ok.description, 'At 09:30, on Monday to Friday');
  assert.deepEqual(ok.next, ['2026-09-21T07:30:00.000Z', '2026-09-22T07:30:00.000Z', '2026-09-23T07:30:00.000Z']);

  const bad = previewCron('0 25 * * *', undefined);
  assert.equal(bad.valid, false);
  assert.match(bad.error ?? '', /hour: 25 is outside/);
  assert.deepEqual(bad.next, []);
});
