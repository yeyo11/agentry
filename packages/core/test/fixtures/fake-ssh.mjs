#!/usr/bin/env node
// Stands in for `ssh -R 80:<host>:<port> nokey@localhost.run` in the tunnel tests, which never
// touch the network. It prints a banner shaped like localhost.run's, and forwards HTTP to the port
// it was given through a proxy on loopback, keeping the `Host` the way the provider does.
//
//   FAKE_SSH_LOG=<file>      appends one JSON line per start: { pid, argv }
//   FAKE_SSH_ROUTES=<file>   JSON { "<host>": <proxy port> }, how a test reaches "the public URL"
//   FAKE_SSH_MODE=fail       exits 255 at once, like a network with no route to localhost.run
//   FAKE_SSH_MODE=hang       connects and never prints an address
//   FAKE_SSH_MODE=hostkey    the server offers a key that is not the pinned one
//   SIGUSR1                  a new address on the same connection (the domain changed)
//   SIGUSR2                  the connection drops: exit 255
//
// The host key is checked the way `StrictHostKeyChecking=yes` would: the known_hosts file named
// in the arguments must hold localhost.run's pinned key, or it fails like ssh does.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request, createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PINNED = 'localhost.run ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILVqOuSMnyeGDVO1lG6EaG5In/dXABCchhmHKkuRU2s9';
const argv = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ pid: process.pid, argv })}\n`);

const option = (name) => argv.flatMap((arg, i) => (argv[i - 1] === '-o' && arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []))[0];
const forward = argv[argv.indexOf('-R') + 1] ?? '';
const [, targetHost, targetPort] = /^80:\[?([^\]]+)\]?:(\d+)$/.exec(forward) ?? [];

process.stderr.write('===============================================================================\r\n');
process.stderr.write('Welcome to localhost.run!\r\n');
process.stderr.write('** your connection id is 203.0.113.7:55150, please mention it if you send me a message about an issue. **\r\n');

const knownHosts = option('UserKnownHostsFile');
if (process.env.FAKE_SSH_MODE === 'hostkey' || option('StrictHostKeyChecking') !== 'yes' || !knownHosts || !existsSync(knownHosts) || !readFileSync(knownHosts, 'utf8').includes(PINNED)) {
  process.stderr.write('Host key verification failed.\r\n');
  process.exit(255);
}
if (process.env.FAKE_SSH_MODE === 'fail') {
  process.stderr.write('ssh: connect to host localhost.run port 22: Network is unreachable\r\n');
  process.exit(255);
}
if (!targetHost || !targetPort) {
  process.stderr.write(`Bad remote forwarding specification '${forward}'\r\n`);
  process.exit(255);
}

const hosts = new Set();
const proxy = createServer((req, res) => {
  const upstream = request({ host: targetHost, port: Number(targetPort), method: req.method, path: req.url, headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502);
    res.end('no tunnel here');
  });
  req.pipe(upstream);
});

function route(host) {
  const file = process.env.FAKE_SSH_ROUTES;
  if (!file) return;
  const routes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  routes[host] = proxy.address().port;
  writeFileSync(file, JSON.stringify(routes));
}

function announce() {
  const host = `${randomBytes(7).toString('hex')}.lhr.life`;
  hosts.add(host);
  route(host);
  process.stdout.write(`authn: authenticated as anonymous user\r\r\n`);
  process.stdout.write(`${host} tunneled with tls termination, https://${host}\r\n`);
  process.stdout.write('create an account and add your key for a longer lasting domain name. see https://localhost.run/docs/forever-free/ for more information.\r\n');
}

proxy.listen(0, '127.0.0.1', () => {
  if (process.env.FAKE_SSH_MODE !== 'hang') announce();
});
process.on('SIGUSR1', announce);
process.on('SIGUSR2', () => process.exit(255));
process.on('SIGTERM', () => process.exit(0));
