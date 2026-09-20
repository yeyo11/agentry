import type { AddressInfo } from 'node:net';
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

/** Creates the core, builds the app and listens. Shared by the CLI entrypoint and the desktop bundle. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '0.0.0.0';
  const core = new Core();
  const app = await buildApp(core, { webDist: opts.webDist });
  for (const stray of core.runtime.strays()) {
    app.log.warn(
      `chat ${stray.chatId}: CLI process ${stray.pid} from a previous wrapper is still working on it; ` +
        'it will not be resumed beside that process until it exits or the chat is stopped',
    );
  }

  const system = await core.system();
  if (!system.cli.installed) app.log.error(`Claude Code CLI not detected: ${system.cli.error}`);
  else if (!system.auth.loggedIn) app.log.warn('Claude Code CLI detected but not logged in. Set CLAUDE_CODE_OAUTH_TOKEN (see `claude setup-token`) or configure it in the UI.');
  else app.log.info(`Claude Code ${system.cli.version} ready (auth: ${system.auth.tokenSource}, plan: ${system.auth.subscriptionType ?? 'n/a'})`);

  try {
    await app.listen({ port: opts.port ?? 8787, host });
  } catch (err) {
    core.shutdown();
    await app.close();
    throw err;
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
