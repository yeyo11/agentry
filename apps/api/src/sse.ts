import type { FastifyReply, FastifyRequest } from 'fastify';
import { allowedOrigin } from './origins.ts';

/** Often enough that a proxy with an idle timeout sees traffic, rarely enough to cost nothing. */
const HEARTBEAT_MS = 15_000;
/** Explicit, so the reconnect delay does not depend on what the browser or a proxy defaults to. */
const RETRY_MS = 3000;

export interface SseStream {
  /** One event: `id` is left out for what a client must not resume from, `event` for a plain frame. */
  send(payload: unknown, frame?: { event?: string; id?: number }): void;
  /** Runs when the client hangs up, after the heartbeat is stopped. */
  onClose(cleanup: () => void): void;
}

/**
 * Opens a Server-Sent Events reply and keeps it open.
 *
 * Every stream goes through here so that the next one cannot be written with a header missing: a
 * hijacked reply bypasses the whole Fastify lifecycle, @fastify/cors included, so the cross-origin
 * decision has to be made by hand — and it is made here once, from `allowedOrigin`, instead of
 * being restated per route where it drifted into reflecting whatever origin asked.
 */
export function openStream(req: FastifyRequest, reply: FastifyReply): SseStream {
  const origin = allowedOrigin(req.headers.origin);
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    // The answer depends on who asked, so a cache must not hand one caller's copy to another
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  });
  // Written at once: Node holds the headers until the first write, and a client that asks only for
  // what is new has nothing replayed, so it would not see the stream open until the first heartbeat
  reply.raw.write(`retry: ${RETRY_MS}\n\n`);

  const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
  const cleanups: Array<() => void> = [];
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    // Or every closed tab leaks its subscription for as long as the wrapper runs
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  return {
    send: (payload, frame = {}) => {
      const id = frame.id === undefined ? '' : `id: ${frame.id}\n`;
      const event = frame.event === undefined ? '' : `event: ${frame.event}\n`;
      reply.raw.write(`${id}${event}data: ${JSON.stringify(payload)}\n\n`);
    },
    onClose: (cleanup) => void cleanups.push(cleanup),
  };
}
