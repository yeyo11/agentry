import { Core } from '@agentry/core';
import { buildApp } from './app.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

const core = new Core();
const app = await buildApp(core);

const system = await core.system();
if (!system.cli.installed) app.log.error(`Claude Code CLI not detected: ${system.cli.error}`);
else if (!system.auth.loggedIn) app.log.warn('Claude Code CLI detected but not logged in. Set CLAUDE_CODE_OAUTH_TOKEN (see `claude setup-token`) or configure it in the UI.');
else app.log.info(`Claude Code ${system.cli.version} ready (auth: ${system.auth.tokenSource}, plan: ${system.auth.subscriptionType ?? 'n/a'})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    core.shutdown();
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: PORT, host: HOST });
