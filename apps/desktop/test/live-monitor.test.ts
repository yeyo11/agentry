import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { LiveSnapshot } from '../src/live.ts';
import { LiveMonitor, retryAfterMs } from '../src/live-monitor.ts';

/** A stand-in for the local API: the three list routes and the event feed, and a log of what was asked */
async function fakeServer() {
  const state = {
    counts: { chatsWorking: 0, chatsWaiting: 0, orchestrationsRunning: 0 },
    chats: [] as Array<{ id: string; title: string; state: string; updatedAt: string }>,
    orchestrations: [] as unknown[],
  };
  const requests: string[] = [];
  const feeds: ServerResponse[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(`${url} ${req.headers.authorization ?? ''}`.trim());
    const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url === '/api/overview') return json({ counts: state.counts });
    if (url.startsWith('/api/chats?state=')) {
      const wanted = new URL(url, 'http://x').searchParams.get('state');
      return json(state.chats.filter((c) => c.state === wanted));
    }
    if (url === '/api/orchestrations') return json(state.orchestrations);
    if (url.startsWith('/api/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('retry: 3000\n\nevent: stream.hello\ndata: {}\n\n');
      feeds.push(res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    requests,
    emit: (type: string, id: number) => feeds.forEach((f) => f.write(`id: ${id}\nevent: ${type}\ndata: {}\n\n`)),
    close: () => {
      feeds.forEach((f) => f.end());
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('reads the overview, fetches the lists only when something is live, and follows the feed', async () => {
  const server = await fakeServer();
  const snapshots: LiveSnapshot[] = [];
  const monitor = new LiveMonitor({ origin: server.origin, headers: { Authorization: 'Bearer t' }, onSnapshot: (s) => snapshots.push(s), refreshGapMs: 20 });
  try {
    monitor.start();
    await until(() => snapshots.length > 0, 'the first snapshot');
    assert.deepEqual(snapshots[0], { working: 0, waiting: 0, running: 0, items: [] });
    assert.ok(!server.requests.some((r) => r.startsWith('/api/chats') || r.startsWith('/api/orchestrations')), 'nothing live, no lists');
    assert.ok(server.requests.every((r) => r.endsWith('Bearer t')), 'every request carries the token');

    server.state.counts = { chatsWorking: 1, chatsWaiting: 0, orchestrationsRunning: 0 };
    server.state.chats = [{ id: 'c1', title: 'Busy', state: 'working', updatedAt: '2026-09-21T10:00:00Z' }];
    const before = snapshots.length;
    // Events that cannot change what is live are ignored
    server.emit('changes.updated', 1);
    server.emit('run.updated', 2);
    await until(() => snapshots.length > before && snapshots.at(-1)?.working === 1, 'the snapshot after run.updated');
    assert.deepEqual(snapshots.at(-1)?.items, [{ kind: 'chat', id: 'c1', path: '/chats/c1', title: 'Busy', state: 'working' }]);
    assert.ok(server.requests.some((r) => r.startsWith('/api/chats?state=working')));
    assert.ok(!server.requests.some((r) => r.startsWith('/api/chats?state=waiting')), 'no waiting chats, no waiting list');
  } finally {
    monitor.stop();
    await server.close();
  }
});

test('a burst of events costs one read, and one more for what came during it', async () => {
  const server = await fakeServer();
  let snapshots = 0;
  const monitor = new LiveMonitor({ origin: server.origin, onSnapshot: () => void snapshots++, refreshGapMs: 200 });
  try {
    monitor.start();
    await until(() => snapshots === 1, 'the first snapshot');
    const overviews = () => server.requests.filter((r) => r === '/api/overview').length;
    const start = overviews();
    for (let id = 1; id <= 20; id++) server.emit('run.updated', id);
    await until(() => overviews() > start, 'a refresh');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(overviews() - start <= 2, `a burst of 20 events read the overview ${overviews() - start} times`);
  } finally {
    monitor.stop();
    await server.close();
  }
});

/** A local API that refuses everything with `status`, and says when each request came */
async function refusingServer(status: number, headers: Record<string, string> = {}) {
  const hits: Array<{ path: string; at: number }> = [];
  let answer = status;
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    hits.push({ path, at: Date.now() });
    if (answer !== 200) return void res.writeHead(answer, { 'content-type': 'application/json', ...headers }).end('{}');
    if (path === '/api/overview') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ counts: { chatsWorking: 0, chatsWaiting: 0, orchestrationsRunning: 0 } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hello\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    count: (path: string) => hits.filter((h) => h.path === path).length,
    answer: (next: number) => void (answer = next),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a refused tray stops asking instead of polling, and says so once', async () => {
  const server = await refusingServer(401);
  const lines: string[] = [];
  // A poll this fast would ask dozens of times in the half second below were the refusal ignored
  const monitor = new LiveMonitor({ origin: server.origin, onSnapshot: () => undefined, log: (l) => lines.push(l), pollMs: 20, refreshGapMs: 10, refusedMs: 60_000 });
  try {
    monitor.start();
    await until(() => server.count('/api/overview') >= 1 && server.count('/api/events') >= 1, 'the first attempts');
    await pause(500);
    assert.equal(server.count('/api/overview'), 1);
    assert.equal(server.count('/api/events'), 1);
    assert.equal(lines.filter((l) => l.includes('401')).length, 1, lines.join('\n'));
    assert.match(lines[0] ?? '', /asks again in 60 s/);
  } finally {
    monitor.stop();
    await server.close();
  }
});

test('the wait after a refusal doubles up to its cap, and a success starts it over', async () => {
  const server = await refusingServer(403);
  const lines: string[] = [];
  const monitor = new LiveMonitor({ origin: server.origin, onSnapshot: () => undefined, log: (l) => lines.push(l), pollMs: 10, refreshGapMs: 1, refusedMs: 100, refusedMaxMs: 400 });
  try {
    monitor.start();
    // Quiet spells of 100, 200, 400 and 400 ms: the fifth attempt lands after about 1.1 s
    await until(() => server.count('/api/overview') >= 6, 'six reads of the overview');
    const at = server.hits.filter((h) => h.path === '/api/overview').map((h) => h.at);
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
    const [first = 0, second = 0, third = 0, fourth = 0, fifth = 0] = gaps;
    assert.ok(first >= 90, `gaps ${gaps.join(', ')}`);
    assert.ok(second >= 190 && third >= 380, `the wait doubles: gaps ${gaps.join(', ')}`);
    // Uncapped these would be 800 and 1600. A spell can go to the feed's attempt instead of the
    // overview's when both wake together, so one gap may be two spells long, never more
    assert.ok(Math.max(fourth, fifth) < 1000, `and stops at its cap: gaps ${gaps.join(', ')}`);
    // The feed keeps the same quiet spells: well under what polling every 10 ms would have asked
    assert.ok(server.count('/api/events') <= 4, `${String(server.count('/api/events'))} feed requests`);
    assert.equal(lines.filter((l) => l.includes('403')).length, 1, lines.join('\n'));

    server.answer(200);
    await until(() => lines.some((l) => l.includes('answers the tray again')), 'the recovery');
  } finally {
    monitor.stop();
    await server.close();
  }
});

test('a throttled tray waits as long as Retry-After says', async () => {
  const server = await refusingServer(429, { 'retry-after': '1' });
  const monitor = new LiveMonitor({ origin: server.origin, onSnapshot: () => undefined, pollMs: 20, refreshGapMs: 10, refusedMs: 60_000 });
  try {
    monitor.start();
    await until(() => server.count('/api/overview') >= 1, 'the first attempt');
    const first = server.hits[0]?.at ?? 0;
    await pause(700);
    assert.equal(server.count('/api/overview'), 1, 'nothing asked before the second is up');
    await until(() => server.count('/api/overview') >= 2, 'the retry after the wait');
    const retry = server.hits.filter((h) => h.path === '/api/overview')[1]?.at ?? 0;
    assert.ok(retry - first >= 950, `retried after ${String(retry - first)} ms`);
  } finally {
    monitor.stop();
    await server.close();
  }
});

test('Retry-After is read as seconds or as a date', () => {
  assert.equal(retryAfterMs('7'), 7000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(null), undefined);
});
