import { startServer } from './server.ts';

const server = await startServer({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
