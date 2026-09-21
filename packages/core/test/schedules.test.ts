import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentryEvent, NewChatRequest, OrchestrationSpec, ScheduleChangedEvent, ScheduleFiredEvent, ScheduleTarget } from '@agentry/shared';
import { EventBus } from '../src/events.ts';
import { previewCron, Scheduler, type ScheduleLauncher } from '../src/schedules.ts';
import { tempConfig } from './helpers.ts';

const at = (iso: string) => Date.parse(iso);
const chatTarget: ScheduleTarget = { kind: 'chat', chat: { prompt: 'summarise the night' } };

/** A scheduler on a clock the test moves, with launchers that record what they were asked to start. */
function rig(config = tempConfig(), start = '2026-09-20T08:00:00Z') {
  const state = {
    now: at(start),
    chats: [] as NewChatRequest[],
    orchestrations: [] as OrchestrationSpec[],
    failWith: null as string | null,
    /** Chats and orchestrations still going, by id: what an overlap policy asks about */
    live: new Set<string>(),
  };
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
    running: ({ chatId, orchestrationId }) => state.live.has(chatId ?? orchestrationId ?? ''),
  };
  const bus = new EventBus();
  const events: AgentryEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const open = () => {
    const scheduler = new Scheduler(config, launcher, () => state.now);
    scheduler.bus = bus;
    return scheduler;
  };
  return { config, state, bus, events, scheduler: open(), open };
}

const changes = (events: AgentryEvent[]) => events.filter((e): e is ScheduleChangedEvent => e.type === 'schedule.changed');
const fires = (events: AgentryEvent[]) => events.filter((e): e is ScheduleFiredEvent => e.type === 'schedule.fired');

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

// ---------- overlap ----------

const everyTen = { ...daily, cron: '*/10 * * * *' };

test('parallel, the default, starts a slot while the last run is still going', async () => {
  const { scheduler, state } = rig();
  const created = await scheduler.create(everyTen);
  assert.equal(created.overlap, 'parallel');
  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick();
  state.live.add('chat-1');
  state.now = at('2026-09-20T08:20:02Z');
  await scheduler.tick();
  assert.equal(state.chats.length, 2);
  assert.deepEqual(scheduler.history(created.id).map((r) => r.status), ['started', 'started']);
  scheduler.close();
});

test('skip writes an overlapped run and starts nothing while the last run is going, then fires again once it ended', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create({ ...everyTen, overlap: 'skip' });
  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick();
  state.live.add('chat-1');

  state.now = at('2026-09-20T08:20:02Z');
  await scheduler.tick();
  assert.equal(state.chats.length, 1, 'nothing started');
  const [overlapped, first] = scheduler.history(id);
  assert.equal(overlapped?.status, 'overlapped');
  assert.equal(overlapped?.slot, '2026-09-20T08:20:00.000Z');
  assert.match(overlapped?.error ?? '', /still going/);
  assert.equal(scheduler.get(id).lastRunAt, first?.at, 'a slot set aside is not a run');

  state.live.delete('chat-1');
  state.now = at('2026-09-20T08:30:02Z');
  await scheduler.tick();
  assert.equal(state.chats.length, 2);
  assert.equal(scheduler.history(id)[0]?.status, 'started');
  scheduler.close();
});

test('an orchestration still running counts as the last run going', async () => {
  const { scheduler, state } = rig();
  const spec: OrchestrationSpec = { name: 'nightly', tasks: [{ id: 'a', name: 'check', prompt: 'check' }] };
  const { id } = await scheduler.create({ ...everyTen, overlap: 'skip', target: { kind: 'orchestration', spec } });
  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick();
  state.live.add('orch-1');
  state.now = at('2026-09-20T08:20:02Z');
  await scheduler.tick();
  assert.equal(state.orchestrations.length, 1);
  assert.equal(scheduler.history(id)[0]?.status, 'overlapped');
  scheduler.close();
});

test('queue holds one slot until the last run ends, a newer slot replaces it, and the run says which slot it answers', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create({ ...everyTen, overlap: 'queue' });
  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick();
  state.live.add('chat-1');

  state.now = at('2026-09-20T08:20:02Z');
  await scheduler.tick();
  assert.equal(state.chats.length, 1);
  assert.equal(scheduler.history(id)[0]?.status, 'queued');

  state.now = at('2026-09-20T08:30:02Z');
  await scheduler.tick();
  const [newest, replaced] = scheduler.history(id);
  assert.equal(newest?.status, 'queued');
  assert.equal(newest?.slot, '2026-09-20T08:30:00.000Z');
  assert.equal(replaced?.status, 'overlapped');
  assert.equal(replaced?.slot, '2026-09-20T08:20:00.000Z');
  assert.match(replaced?.error ?? '', /Replaced by the 2026-09-20T08:30:00.000Z slot/);

  // Still going: a drain changes nothing
  await scheduler.drain();
  assert.equal(state.chats.length, 1);

  state.live.delete('chat-1');
  state.now = at('2026-09-20T08:34:00Z');
  await scheduler.drain();
  assert.equal(state.chats.length, 2, 'it starts when the previous run ends, not at the next slot');
  const [started] = scheduler.history(id);
  assert.equal(started?.status, 'started');
  assert.equal(started?.chatId, 'chat-2');
  assert.equal(started?.slot, '2026-09-20T08:30:00.000Z');
  assert.equal(started?.at, '2026-09-20T08:34:00.000Z');
  assert.equal(scheduler.get(id).lastRunAt, started?.at);

  await scheduler.drain();
  assert.equal(state.chats.length, 2, 'a queued run starts once');
  scheduler.close();
});

test('a queued run is started by the tick when nothing told the scheduler the run ended', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create({ ...everyTen, overlap: 'queue' });
  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick();
  state.live.add('chat-1');
  state.now = at('2026-09-20T08:20:02Z');
  await scheduler.tick();
  state.live.delete('chat-1');
  state.now = at('2026-09-20T08:21:00Z');
  await scheduler.tick();
  assert.equal(state.chats.length, 2);
  assert.equal(scheduler.history(id)[0]?.slot, '2026-09-20T08:20:00.000Z');
  scheduler.close();
});

test('a queued run is set aside when its schedule is switched off or stops queueing', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create({ ...everyTen, overlap: 'queue' });
  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick();
  state.live.add('chat-1');
  state.now = at('2026-09-20T08:20:02Z');
  await scheduler.tick();
  await scheduler.update(id, { enabled: false });
  state.live.delete('chat-1');
  await scheduler.drain();
  assert.equal(state.chats.length, 1);
  assert.equal(scheduler.history(id)[0]?.status, 'overlapped');
  assert.match(scheduler.history(id)[0]?.error ?? '', /switched off/);

  const other = await scheduler.create({ ...everyTen, name: 'other', overlap: 'queue' });
  state.now = at('2026-09-20T08:30:02Z');
  await scheduler.tick(); // chat-2
  state.live.add('chat-2');
  state.now = at('2026-09-20T08:40:02Z');
  await scheduler.tick();
  assert.equal(scheduler.history(other.id)[0]?.status, 'queued');
  await scheduler.update(other.id, { overlap: 'skip' });
  state.live.delete('chat-2');
  await scheduler.drain();
  assert.equal(state.chats.length, 2);
  assert.match(scheduler.history(other.id)[0]?.error ?? '', /stopped queueing/);
  scheduler.close();
});

test('run now ignores the overlap policy: a person asked for it', async () => {
  const { scheduler, state } = rig();
  const { id } = await scheduler.create({ ...everyTen, overlap: 'skip' });
  await scheduler.runNow(id);
  state.live.add('chat-1');
  const run = await scheduler.runNow(id);
  assert.equal(run.status, 'started');
  assert.equal(state.chats.length, 2);
  scheduler.close();
});

test('the overlap policy is stored in the file, validated, and absent means parallel', async () => {
  const { scheduler, config } = rig();
  await assert.rejects(scheduler.create({ ...daily, overlap: 'later' as never }), /overlap must be "parallel", "skip" or "queue"/);
  const { id } = await scheduler.create({ ...daily, overlap: 'queue' });
  assert.equal(scheduler.get(id).overlap, 'queue');
  assert.equal((await scheduler.update(id, { overlap: 'skip' })).overlap, 'skip');
  await assert.rejects(scheduler.update(id, { overlap: 'never' as never }), /overlap must be/);
  const file = join(config.dataDir, 'schedules.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { schedules: Array<Record<string, unknown>> };
  assert.equal(doc.schedules[0]?.overlap, 'skip');

  // A file from before there was a choice
  delete doc.schedules[0]?.overlap;
  writeFileSync(file, JSON.stringify(doc));
  assert.equal(scheduler.get(id).overlap, 'parallel');
  scheduler.close();
});

// ---------- events ----------

test('schedule.changed announces create, edit, switch, reschedule and delete', async () => {
  const { scheduler, state, events } = rig();
  const { id } = await scheduler.create(daily);
  await scheduler.update(id, { name: 'morning' });
  await scheduler.update(id, { enabled: false });
  await scheduler.update(id, { enabled: true, cron: '0 10 * * *' });
  state.now = at('2026-09-20T10:00:05Z');
  await scheduler.tick();
  await scheduler.tick(); // nothing due: nothing was recomputed
  await scheduler.remove(id);

  const seen = changes(events);
  assert.deepEqual(seen.map((e) => e.action), ['created', 'updated', 'disabled', 'enabled', 'rescheduled', 'deleted']);
  assert.ok(seen.every((e) => e.scheduleId === id));
  assert.equal(seen[0]?.scheduleName, 'daily');
  assert.equal(seen[0]?.nextRunAt, '2026-09-20T09:00:00.000Z');
  assert.equal(seen[1]?.scheduleName, 'morning');
  assert.equal(seen[2]?.nextRunAt, null);
  assert.equal(seen[4]?.nextRunAt, '2026-09-21T10:00:00.000Z', 'the next fire, computed after this one');
  assert.equal(seen[5]?.nextRunAt, null);
  assert.ok(seen.every((e) => e.title.length > 0));
  scheduler.close();
});

test('starting the scheduler announces every enabled schedule as rescheduled', async () => {
  const { scheduler, events } = rig();
  const on = await scheduler.create(daily);
  await scheduler.create({ ...daily, name: 'off', enabled: false });
  events.length = 0;
  scheduler.start();
  assert.deepEqual(
    changes(events).map((e) => [e.scheduleId, e.action]),
    [[on.id, 'rescheduled']],
  );
  scheduler.close();
});

test('schedule.fired follows every run row: started, failed, skipped, overlapped and queued', async () => {
  const { scheduler, state, events, open } = rig();
  const { id } = await scheduler.create({ ...everyTen, overlap: 'queue' });

  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick(); // started chat-1
  state.live.add('chat-1');
  state.now = at('2026-09-20T08:20:02Z');
  await scheduler.tick(); // queued
  state.now = at('2026-09-20T08:30:02Z');
  await scheduler.tick(); // queued, the 08:20 one overlapped
  state.live.delete('chat-1');
  await scheduler.drain(); // the 08:30 one started
  state.failWith = 'no workspace';
  await scheduler.runNow(id); // failed
  scheduler.close();

  state.failWith = null;
  state.now = at('2026-09-20T09:35:00Z'); // 08:40 to 09:30 went by while it was down
  const second = open();
  await second.tick();

  const seen = fires(events);
  assert.deepEqual(
    seen.map((e) => e.status),
    ['started', 'queued', 'overlapped', 'queued', 'started', 'failed', 'skipped'],
  );
  assert.ok(seen.every((e) => e.scheduleId === id && e.scheduleName === 'daily'));
  assert.equal(seen[0]?.chatId, 'chat-1');
  assert.equal(seen[1]?.runId, seen[2]?.runId, 'the replaced run is the one that was queued');
  assert.equal(seen[3]?.runId, seen[4]?.runId, 'the queued run is the one that started');
  assert.equal(seen[4]?.chatId, 'chat-2');
  assert.equal(seen[5]?.chatId, null);
  assert.match(seen[5]?.title ?? '', /no workspace/);
  const history = new Set(second.history(id).map((r) => r.id));
  assert.ok(seen.every((e) => history.has(e.runId)), 'every event names a row the history has');
  second.close();
});

test('a client that reconnects with the last id it saw gets the schedule events it missed', async () => {
  const { scheduler, state, bus } = rig();
  const { id } = await scheduler.create(everyTen);
  const cursor = bus.lastEventId;
  state.now = at('2026-09-20T08:10:02Z');
  await scheduler.tick();
  await scheduler.update(id, { enabled: false });
  const replay = bus.since(cursor);
  assert.ok('events' in replay);
  assert.deepEqual(
    replay.events.map((e) => (e.type === 'schedule.changed' ? `${e.type}:${e.action}` : e.type)),
    ['schedule.fired', 'schedule.changed:rescheduled', 'schedule.changed:disabled'],
  );
  scheduler.close();
});
