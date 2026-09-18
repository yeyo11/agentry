import { startServer } from './server.ts';

/**
 * Entrypoint bundled into dist/server.mjs for the desktop app, which runs it as a child process.
 * Binds to loopback by default and to a free port when PORT is unset, then announces the real
 * address on stdout with a single `AGENTRY_READY {json}` line the parent waits for.
 */
const server = await startServer({
  port: Number(process.env.PORT ?? 0),
  host: process.env.HOST ?? '127.0.0.1',
  webDist: process.env.AGENTRY_WEB_DIST,
});

process.stdout.write(`AGENTRY_READY ${JSON.stringify({ url: server.url, port: server.port })}\n`);

function stop(): void {
  void server.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
// Spawned with an IPC channel: exit with the parent instead of lingering as an orphan
if (process.connected) process.on('disconnect', stop);
