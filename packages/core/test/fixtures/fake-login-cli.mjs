// A sign-in CLI for the LoginService tests. It records how it was started (argv, what came on
// stdin, the variables a test asks about), prints a fixture line by line and then exits, fails or
// hangs, as the FAKE_LOGIN_* variables say.
import { readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const record = env.FAKE_LOGIN_RECORD;
const lines = env.FAKE_LOGIN_FIXTURE ? readFileSync(env.FAKE_LOGIN_FIXTURE, 'utf8').split('\n') : [];
const out = env.FAKE_LOGIN_STDERR === '1' ? process.stderr : process.stdout;

let stdin = '';
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  if (record) {
    const watched = (env.FAKE_LOGIN_WATCH ?? '').split(',').filter(Boolean);
    writeFileSync(record, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), stdin, env: Object.fromEntries(watched.map((name) => [name, env[name] ?? null])) }));
  }
  for (const line of lines) out.write(`${line}\n`);
  const exit = env.FAKE_LOGIN_EXIT ?? '0';
  if (exit === 'hang') setInterval(() => {}, 1000);
  else setTimeout(() => process.exit(Number(exit)), Number(env.FAKE_LOGIN_DELAY_MS ?? '0'));
});
