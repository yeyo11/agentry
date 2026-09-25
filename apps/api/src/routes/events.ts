import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { AgentryEvent, StreamHelloEvent, StreamResyncEvent } from '@agentry/shared';
import { openStream } from '../sse.ts';

export const eventRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // One stream for the whole app, so a UI never has to poll. Like /runs/:id/stream, a client that
  // reconnects with Last-Event-ID is sent what it missed before the live events.
  app.get<{ Querystring: { since?: string } }>('/events', (req, reply) => {
    const lastEventId = Number(req.headers['last-event-id'] ?? req.query.since ?? 0) || 0;

    const stream = openStream(req, reply);
    const write = (event: AgentryEvent) => stream.send(event, { event: event.type, id: event.id });

    // Nothing awaits between subscribing and replaying, so no event can slip in between them
    stream.onClose(core.events.subscribe(write));

    const hello: StreamHelloEvent = {
      type: 'stream.hello',
      lastEventId: core.events.lastEventId,
      bootId: core.events.bootId,
      serverTime: new Date().toISOString(),
      version: core.version,
    };
    stream.send(hello, { event: hello.type });
    // A first connection has nothing to catch up on; a reconnection asks to continue from an id
    if (lastEventId > 0) {
      const replay = core.events.since(lastEventId);
      if ('resync' in replay) {
        const resync: StreamResyncEvent = { type: 'stream.resync', lastEventId: core.events.lastEventId, reason: replay.resync };
        stream.send(resync, { event: resync.type });
      } else {
        for (const event of replay.events) write(event);
      }
    }
  });
};
