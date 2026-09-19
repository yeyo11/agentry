import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { AgentryEvent, StreamHelloEvent, StreamResyncEvent } from '@agentry/shared';

const HEARTBEAT_MS = 15_000;

export const eventRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // One stream for the whole app, so a UI never has to poll. Like /runs/:id/stream, a client that
  // reconnects with Last-Event-ID is sent what it missed before the live events.
  app.get<{ Querystring: { since?: string } }>('/events', (req, reply) => {
    const lastEventId = Number(req.headers['last-event-id'] ?? req.query.since ?? 0) || 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // hijacked replies bypass @fastify/cors
      ...(process.env.AGENTRY_CORS_ORIGIN && req.headers.origin ? { 'Access-Control-Allow-Origin': req.headers.origin } : {}),
    });
    // Explicit, so the reconnect delay does not depend on what the browser or a proxy defaults to
    reply.raw.write('retry: 3000\n\n');

    const send = (type: string, data: unknown, id?: number) =>
      reply.raw.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const write = (event: AgentryEvent) => send(event.type, event, event.id);

    // Nothing awaits between subscribing and replaying, so no event can slip in between them
    const unsubscribe = core.events.subscribe(write);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    const hello: StreamHelloEvent = {
      type: 'stream.hello',
      lastEventId: core.events.lastEventId,
      bootId: core.events.bootId,
      serverTime: new Date().toISOString(),
    };
    send(hello.type, hello);
    // A first connection has nothing to catch up on; a reconnection asks to continue from an id
    if (lastEventId > 0) {
      const replay = core.events.since(lastEventId);
      if ('resync' in replay) {
        const resync: StreamResyncEvent = { type: 'stream.resync', lastEventId: core.events.lastEventId, reason: replay.resync };
        send(resync.type, resync);
      } else {
        for (const event of replay.events) write(event);
      }
    }
  });
};
