#!/usr/bin/env node
// Stands in for the `tailscale` CLI in the tunnel tests, which never touch a real tailnet. It
// answers the calls TunnelManager makes, with the output shapes measured on tailscale 1.102.4:
//
//   tailscale version
//   tailscale status --json
//   tailscale serve status --json
//   tailscale serve --bg --yes --https=<port> <target>
//   tailscale serve --yes --https=<port> off
//
// The node's state lives in a JSON file, so a test can change it between calls and read what the
// CLI was asked to do:
//
//   FAKE_TAILSCALE_STATE=<file>  { version, daemon, backendState, dnsName, magicDNS, certDomains,
//                                  operator, serve }; any key left out takes the default below
//   FAKE_TAILSCALE_LOG=<file>    appends one JSON line per call: { argv }
//
// `operator: false` answers a Serve change the way tailscaled does for a user that is not the
// node's operator. `daemon: false` answers every call that needs tailscaled the way the CLI does
// when it cannot reach it.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.FAKE_TAILSCALE_LOG) appendFileSync(process.env.FAKE_TAILSCALE_LOG, `${JSON.stringify({ argv })}\n`);

const file = process.env.FAKE_TAILSCALE_STATE;
const DEFAULTS = {
  version: '1.102.4',
  daemon: true,
  backendState: 'Running',
  dnsName: 'agentry-test.tail0000.ts.net.',
  magicDNS: true,
  certDomains: ['agentry-test.tail0000.ts.net'],
  operator: true,
  serve: {},
};
const state = { ...DEFAULTS, ...(file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) };
const save = () => {
  if (file) writeFileSync(file, JSON.stringify(state));
};
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const noDaemon = (path) =>
  fail(`failed to connect to local tailscaled; it doesn't appear to be running. Got error: Failed to connect to local Tailscale daemon for /localapi/v0/${path}; not running?`);

const [command, ...rest] = argv;

if (command === 'version') {
  process.stdout.write(`${state.version}\n  tailscale commit: 0000000\n  go version: go1.26.6\n`);
  process.exit(0);
}

if (command === 'status' && rest.includes('--json')) {
  if (!state.daemon) noDaemon('status');
  const dns = state.backendState === 'Running' || state.backendState === 'Stopped' ? state.dnsName : '';
  process.stdout.write(
    JSON.stringify(
      {
        Version: `${state.version}-tfake`,
        BackendState: state.backendState,
        AuthURL: '',
        Self: { DNSName: dns, Online: state.backendState === 'Running' },
        MagicDNSSuffix: 'tail0000.ts.net',
        CurrentTailnet: { Name: 'person@example.com', MagicDNSSuffix: 'tail0000.ts.net', MagicDNSEnabled: state.magicDNS },
        CertDomains: state.certDomains,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (command === 'serve') {
  if (!state.daemon) noDaemon('serve-config');
  if (rest[0] === 'status') {
    process.stdout.write(`${JSON.stringify(state.serve, null, 2)}\n`);
    process.exit(0);
  }
  const https = rest.find((arg) => arg.startsWith('--https='));
  const positional = rest.filter((arg) => !arg.startsWith('--'));
  if (!https || positional.length !== 1) fail('error: the fake only knows --https=<port> <target|off>');
  const port = https.slice('--https='.length);
  const host = state.dnsName.replace(/\.$/, '');
  const key = `${host}:${port}`;
  const serve = state.serve;
  if (positional[0] === 'off') {
    const handlers = serve.Web?.[key]?.Handlers;
    if (!handlers?.['/']) fail('error: failed to remove web serve: handler does not exist');
    if (!state.operator) fail("sending serve config: Access denied: serve config denied\n\nUse 'sudo tailscale serve ...'.");
    delete handlers['/'];
    if (Object.keys(handlers).length === 0) {
      delete serve.Web[key];
      delete serve.TCP[port];
      if (Object.keys(serve.Web).length === 0) delete serve.Web;
      if (Object.keys(serve.TCP).length === 0) delete serve.TCP;
    }
    save();
    process.exit(0);
  }
  if (!rest.includes('--bg')) fail('error: the fake only serves in the background (--bg)');
  if (!state.operator) fail("sending serve config: Access denied: serve config denied\n\nUse 'sudo tailscale serve --bg ...'.\nTo not require root, use 'sudo tailscale set --operator=$USER' once.");
  const target = /^\d+$/.test(positional[0]) ? `http://127.0.0.1:${positional[0]}` : positional[0];
  serve.TCP = { ...serve.TCP, [port]: { HTTPS: true } };
  serve.Web = { ...serve.Web, [key]: { Handlers: { '/': { Proxy: target } } } };
  save();
  process.stdout.write(`Available within your tailnet:\n\nhttps://${key}/\n|-- proxy ${target}\n\nServe started and running in the background.\nTo disable the proxy, run: tailscale serve --https=${port} off\n`);
  process.exit(0);
}

fail(`fake tailscale: unknown command ${argv.join(' ')}`);
