import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { LiveSnapshot } from '../src/live.ts';
import { LiveMonitor } from '../src/live-monitor.ts';

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
