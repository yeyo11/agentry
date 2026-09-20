import { rmSync, writeFileSync } from 'node:fs';
import { startServer } from './server.ts';

const server = await startServer({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '0.0.0.0' });

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
