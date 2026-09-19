// Entrypoint of the single-file bundle (`node dist/server.mjs`) that the desktop app runs as a child process.
import { startServer } from './server.ts';

const server = await startServer({
  port: Number(process.env.PORT ?? 0),
  host: process.env.HOST ?? '127.0.0.1',
  webDist: process.env.AGENTRY_WEB_DIST,
});

// The parent parses this single line to learn where the API is listening
console.log(`AGENTRY_READY ${JSON.stringify({ url: server.url, port: server.port })}`);

const shutdown = () => void server.close().then(() => process.exit(0));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
// With an IPC channel, a dead parent must not leave the server orphaned
process.on('disconnect', shutdown);
