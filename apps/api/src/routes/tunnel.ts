import type { FastifyPluginAsync } from 'fastify';
import type { TunnelStatus } from '@agentry/shared';
import type { Core } from '@agentry/core';

/**
 * How long a reply gets to cross ssh before the stop kills it. `finish` only says Node handed the
 * bytes to the socket; ssh still has to read them and localhost.run to deliver them.
 */
const REPLY_GRACE_MS = 1_000;

/** Whether the request arrived through the tunnel it is asking about. */
function throughTunnel(status: TunnelStatus, host: string | undefined): boolean {
  if (!status.url || !host) return false;
  try {
    return new URL(status.url).host === host.toLowerCase();
  } catch {
    return false;
  }
}

/** The tunnel through localhost.run. A refusal (auth off, no port yet) is a `409` from the manager. */
export const tunnelRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/tunnel', () => core.tunnel.status());

  app.put<{ Body: unknown }>('/tunnel/settings', (req) => core.tunnel.updateSettings(req.body));

  app.post('/tunnel/start', () => core.tunnel.start());

  app.post('/tunnel/stop', (req, reply) => {
    const status = core.tunnel.status();
    if (!throughTunnel(status, req.headers.host)) return core.tunnel.stop();
    // Stopping kills the ssh this very reply has to travel back through, so a page that came
    // through the tunnel would only ever see its connection drop. It gets its answer first.
    reply.raw.once('finish', () => {
      setTimeout(() => {
        core.tunnel.stop().catch((err: unknown) => req.log.error({ err }, 'closing the tunnel failed'));
      }, REPLY_GRACE_MS);
    });
    return { ...status, state: 'stopping', url: null } satisfies TunnelStatus;
  });
};
