import { rmSync, writeFileSync } from 'node:fs';
import { resolveUserPath } from '@agentry/core';
import { startServer } from './server.ts';

// The terminal's PATH, also when this was started from a service or a desktop session
process.env.PATH = await resolveUserPath();

const port = Number(process.env.PORT ?? 8787);
// Loopback by default: the API runs commands on this machine and starts with no credential, so
// publishing it on every interface has to be something someone asked for. HOST is how they ask;
// the image sets HOST=0.0.0.0 because compose publishes the container on 127.0.0.1.
const host = process.env.HOST ?? '127.0.0.1';
// The address in front of this process is fixed: the Vite proxy of `pnpm dev`, a container's
// published port. Moving to a free port would leave it pointing at whatever holds this one, which
// once was an older Agentry from another worktree, silently answering a newer UI.
const server = await startServer({ port, host, portFallback: false }).catch((err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(
    `port ${String(port)} on ${host} is taken. Stop what holds it (ss -ltnp 'sport = :${String(port)}'), ` +
      'or run with PORT=<free port> and, for the web dev server, VITE_API_TARGET=http://127.0.0.1:<that port>.',
  );
  process.exit(1);
});

// The container healthcheck cannot restart an unhealthy container by itself: it finds this
// process through the file, because PID 1 is an init or a package manager, not the server
const pidFile = process.env.AGENTRY_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
  process.on('exit', () => rmSync(pidFile, { force: true }));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
