import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Core } from '@agentry/core';
import { buildApp } from './app.ts';

export interface StartServerOptions {
  port?: number;
  host?: string;
  /** Built UI to serve; defaults to AGENTRY_WEB_DIST or the monorepo's apps/web/dist */
  webDist?: string;
}

export interface RunningServer {
  /** Base URL with the real bound port (useful when listening on port 0) */
  url: string;
  port: number;
  /** Stops the runs and closes the HTTP server */
  close(): Promise<void>;
}

/**
 * Listens on `port`, and on whatever the operating system hands out when that one is taken.
 *
 * A port asked for by number is a preference and not a promise — the desktop shell remembers the
 * one it used last so the URL stays put between launches, and something else on the machine may
 * hold it today. Refusing to start over that would trade a moving address for no address at all,
 * which is the worse of the two. Port 0 already means "whatever is free", so it has nothing to
 * fall back to, and an error that is not a taken port is a real failure either way.
 */
export async function listenOn(app: FastifyInstance, port: number, host: string): Promise<void> {
  try {
    await app.listen({ port, host });
  } catch (err) {
    if (port === 0 || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    app.log.warn(`port ${String(port)} is taken; listening on one the operating system picks instead`);
    await app.listen({ port: 0, host });
  }
}

/** Creates the core, builds the app and listens. Shared by the CLI entrypoint and the desktop bundle. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const core = new Core();
  const app = await buildApp(core, { webDist: opts.webDist });
  for (const stray of core.runtime.strays()) {
    app.log.warn(
      `chat ${stray.chatId}: CLI process ${stray.pid} from a previous wrapper is still working on it; ` +
        'it will not be resumed beside that process until it exits or the chat is stopped',
    );
  }

  core.cliVersion.startDaily();
  core.release.startDaily();

  const system = await core.system();
  if (!system.cli.installed) app.log.error(`Claude Code CLI not detected: ${system.cli.error}`);
  else if (!system.auth.loggedIn) app.log.warn('Claude Code CLI detected but not logged in. Set CLAUDE_CODE_OAUTH_TOKEN (see `claude setup-token`) or configure it in the UI.');
  else app.log.info(`Claude Code ${system.cli.version} ready (auth: ${system.auth.tokenSource}, plan: ${system.auth.subscriptionType ?? 'n/a'})`);

  try {
    await listenOn(app, opts.port ?? 8787, host);
  } catch (err) {
    core.shutdown();
    await app.close();
    throw err;
  }

  // Someone who opens the port is told what they just published: this API runs arbitrary commands
  if ((host === '0.0.0.0' || host === '::') && core.security.mode === 'none') {
    app.log.warn(
      `bound to ${host}: this API runs commands on the machine it is on, and nothing is asking for a credential. ` +
        'Whoever reaches the port owns the machine. Set a token (AGENTRY_AUTH_TOKEN, or the security panel), or bind HOST=127.0.0.1.',
    );
  }

  const { port } = app.server.address() as AddressInfo;
  // A wildcard bind is reachable through loopback; advertise that instead of 0.0.0.0 / ::
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost}:${port}`,
    port,
    close() {
      closing ??= (async () => {
        core.shutdown();
        await app.close();
      })();
      return closing;
    },
  };
}
