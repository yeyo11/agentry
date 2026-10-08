// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { AppSettings, AuthMode, TailscaleReadiness, TunnelState, TunnelStatus } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ToastProvider } from '@agentry/ui/components/Toast';
import i18n from '../src/i18n';
import { patchSettings, targetsFor } from '../src/lib/events';
import { encodeQr, formatBits, reedSolomon } from '../src/lib/qr';
import { AppSettingsCards, changedSettings, parseHosts } from '../src/pages/config/AppSettingsCards';
import { reachedThrough, TAILSCALE_DNS_ADMIN_URL, TAILSCALE_DOWNLOAD_URL, TUNNEL_TONE, TunnelPanel } from '../src/pages/config/RemoteAccessTab';

// Settings → Remote access and the layered settings (docs/plans/tunnel.md, task `web`): the tunnel's
// state in a word and a colour, the address with its QR code only while it answers, Tailscale's
// readiness and the guard standing in for the button when either is missing, and settings the
// environment owns shown but never sent.

const NODE = 'agentry-test.tail0000.ts.net';
const URL_ = `https://${NODE}:8443`;
const READY: TailscaleReadiness = { state: 'ready', version: '1.102.4', host: NODE, reason: null };
const status = (state: TunnelState, extra: Partial<TunnelStatus> = {}): TunnelStatus => ({
  state,
  url: state === 'active' ? URL_ : null,
  since: state === 'active' ? new Date(Date.now() - 60_000).toISOString() : null,
  reason: null,
  enabled: true,
  tailscale: READY,
  port: 8443,
  settings: { startWithAgentry: false },
  ...extra,
});

function wrap(children: ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const panel = (tunnel: TunnelStatus, authMode: AuthMode = 'token') => wrap(<TunnelPanel status={tunnel} authMode={authMode} onStart={() => {}} onStop={() => {}} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.before(async () => {
  await i18n.changeLanguage('en');
});

// ---------- the QR code ----------

test('the error correction matches the standard worked example', () => {
  // "HELLO WORLD" at 1-M, from the standard's own walk-through of the Reed-Solomon step
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('the format information is the table value for level M', () => {
  assert.equal(formatBits(0).toString(2).padStart(15, '0'), '101010000010010');
  assert.equal(formatBits(5).toString(2).padStart(15, '0'), '100000011001110');
});

/** Reads a version 3 code back: unmask, walk the zigzag, parse byte mode. Independent of the encoder's layout code. */
function decodeV3(modules: boolean[][]): string {
  const size = 29;
  const reserved = (x: number, y: number) =>
    (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8) || x === 6 || y === 6 || (Math.abs(x - 22) <= 2 && Math.abs(y - 22) <= 2);
  // The mask is in the format bits beside the top-left finder, (8,0)…(8,5) holding bits 0…5
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= (modules[i]?.[8] ? 1 : 0) << i;
  bits |= (modules[7]?.[8] ? 1 : 0) << 6;
  bits |= (modules[8]?.[8] ? 1 : 0) << 7;
  bits |= (modules[8]?.[7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) bits |= (modules[8]?.[14 - i] ? 1 : 0) << i;
  const mask = ((bits ^ 0x5412) >>> 10) & 7;
  const masks = [
    (x: number, y: number) => (x + y) % 2 === 0,
    (_x: number, y: number) => y % 2 === 0,
    (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const stream: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (reserved(x, y)) continue;
        stream.push((modules[y]?.[x] ? 1 : 0) ^ (masks[mask]?.(x, y) ? 1 : 0));
      }
    }
  }
  const read = (from: number, length: number) => stream.slice(from, from + length).reduce((acc, bit) => (acc << 1) | bit, 0);
  assert.equal(read(0, 4), 0b0100, 'byte mode');
  const count = read(4, 8);
  const bytes = Array.from({ length: count }, (_, i) => read(12 + i * 8, 8));
  // 44 data codewords then 26 of error correction, which must be the data's
  const codewords = Array.from({ length: 70 }, (_, i) => read(i * 8, 8));
  assert.deepEqual(codewords.slice(44), reedSolomon(codewords.slice(0, 44), 26));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

test("a tunnel's address fits a version 3 code that reads back as the address", () => {
  const qr = encodeQr(URL_);
  assert.ok(qr);
  assert.equal(qr.version, 3);
  assert.equal(qr.size, 29);
  assert.equal(decodeV3(qr.modules), URL_);
});

test('the three finders sit in their corners, and the timing lines alternate between them', () => {
  const qr = encodeQr(URL_);
  assert.ok(qr);
  const at = (x: number, y: number) => qr.modules[y]?.[x] === true;
  for (const [ox, oy] of [
    [0, 0],
    [qr.size - 7, 0],
    [0, qr.size - 7],
  ] as const) {
    // Dark ring, light ring, dark 3 × 3 centre
    assert.ok(at(ox, oy) && at(ox + 6, oy + 6) && !at(ox + 1, oy + 1) && at(ox + 3, oy + 3));
  }
  for (let i = 8; i < qr.size - 8; i++) assert.equal(at(i, 6), i % 2 === 0);
});

test('longer text takes a larger version, and text past version 10 draws nothing', () => {
  assert.equal(encodeQr('x'.repeat(100))?.version, 6);
  assert.equal(encodeQr('x'.repeat(213))?.version, 10);
  assert.equal(encodeQr('x'.repeat(214)), null);
});

// ---------- the tunnel card ----------

test('every state is a word beside its colour: ok open, warn on the way, bad failed, idle closed', () => {
  assert.deepEqual(TUNNEL_TONE, { active: 'ok', starting: 'warn', verifying: 'warn', stopping: 'warn', failed: 'bad', stopped: 'idle' });
  for (const state of Object.keys(TUNNEL_TONE) as TunnelState[]) {
    const html = panel(status(state, state === 'failed' ? { reason: { code: 'tunnel.noPort', text: 'x' } } : {}));
    assert.match(html, new RegExp(`class="badge badge-${TUNNEL_TONE[state]}"`), state);
    assert.ok(text(html).includes(i18n.t(`config:remote.states.${state}`)), state);
  }
});

test('an open tunnel shows its address in mono with copy and a QR code, and the stop button', () => {
  const html = panel(status('active'));
  assert.match(html, /class="tunnel-address grad-border"/);
  assert.match(html, new RegExp(`<a class="mono break" href="${URL_}"`));
  assert.match(html, /aria-label="Copy address"/);
  assert.match(html, /<svg class="qr"[^>]*role="img"[^>]*aria-label="QR code of https:\/\/agentry-test\.tail0000\.ts\.net:8443"/);
  assert.match(html, /data-testid="tunnel-stop"/);
  assert.doesNotMatch(html, /tunnel-start|btn-primary/);
});

test('no address or QR code is shown before the address answers', () => {
  for (const state of ['starting', 'verifying', 'stopping', 'stopped', 'failed'] as const) {
    const html = panel(status(state));
    assert.doesNotMatch(html, /tunnel-address|class="qr"/, state);
  }
  assert.ok(text(panel(status('verifying'))).includes('Checking that Tailscale holds the rule'));
});

test('a closed tunnel offers the one primary action, with the node, its port and what Agentry touches', () => {
  const html = panel(status('stopped'));
  assert.match(html, /class="btn btn-primary"[^>]*data-testid="tunnel-start"/);
  assert.equal((html.match(/btn-primary/g) ?? []).length, 1);
  assert.match(html, new RegExp(`<span class="mono">${NODE.replaceAll('.', '\\.')}</span>`));
  assert.ok(text(html).includes('one Serve rule on port 8443'));
  assert.ok(text(html).includes('removes only that rule'));
});

test('while the guard is open, the warning and the way to Security replace the start button', () => {
  const html = panel(status('stopped'), 'none');
  assert.match(html, /data-testid="tunnel-auth-required"/);
  assert.match(html, /href="\/settings\?tab=security"/);
  assert.doesNotMatch(html, /tunnel-start|btn-primary/);
});

test('without Tailscale the card says how to install it, with the one illustration, and offers nothing else', () => {
  const html = panel(status('stopped', { tailscale: { state: 'missing', version: null, host: null, reason: { code: 'tunnel.tailscaleMissing', text: 'x' } } }));
  assert.match(html, /data-testid="tunnel-tailscale-missing"/);
  assert.equal((html.match(/state-illustrated/g) ?? []).length, 1);
  assert.ok(text(html).includes('Tailscale is not installed'));
  assert.match(html, new RegExp(`href="${TAILSCALE_DOWNLOAD_URL}"`));
  assert.match(html, /data-testid="tunnel-recheck"/);
  assert.doesNotMatch(html, /tunnel-start|tunnel-stop|tunnel-auth-required/);
});

test('each way Tailscale is not ready says what is missing and what to do, before anything is offered', () => {
  const cases: [Exclude<TailscaleReadiness['state'], 'ready' | 'missing'>, string, string | null][] = [
    ['unsupported', 'tunnel.tailscaleUnsupported', TAILSCALE_DOWNLOAD_URL],
    ['daemonDown', 'tunnel.tailscaleDaemonDown', null],
    ['loggedOut', 'tunnel.tailscaleLoggedOut', null],
    ['stopped', 'tunnel.tailscaleNotConnected', null],
    ['httpsDisabled', 'tunnel.httpsOff', TAILSCALE_DNS_ADMIN_URL],
  ];
  for (const [state, code, link] of cases) {
    const reason = { code, params: { version: '1.50.1', state: 'Stopped' }, text: 'x' };
    // Even with the guard open, readiness comes first: the auth warning would be advice for later
    const html = panel(status('stopped', { tailscale: { state, version: '1.102.4', host: null, reason } }), 'none');
    assert.match(html, new RegExp(`data-testid="tunnel-tailscale-${state}"`), state);
    assert.ok(text(html).includes(i18n.t(`config:remote.tailscale.titles.${state}`)), state);
    assert.doesNotMatch(html, /state-illustrated|tunnel-start|tunnel-auth-required/, state);
    if (link) assert.match(html, new RegExp(`href="${link}"`), state);
    assert.equal(/<code class="mono">tailscale up<\/code>/.test(html), state === 'loggedOut' || state === 'stopped', state);
  }
});

test('a deploy that turned the tunnel off says who can turn it on, and offers no button', () => {
  const html = panel(status('stopped', { enabled: false }));
  assert.match(html, /tunnel-disabled/);
  assert.ok(text(html).includes('AGENTRY_TUNNEL=on'));
  assert.doesNotMatch(html, /tunnel-start/);
});

test("a failure is said in the reader's language from its code", async () => {
  const reason = { code: 'tunnel.portTaken', params: { port: '8443' }, text: 'English' };
  await i18n.changeLanguage('es');
  try {
    const html = panel(status('failed', { reason }));
    assert.ok(text(html).includes('El puerto 8443 del nombre de esta máquina'));
    assert.match(html, /Reintentar/);
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('every reason the tunnel can give has its sentence in both languages', () => {
  const source = readFileSync(new URL('../../../packages/core/src/tunnel.ts', import.meta.url), 'utf8');
  const codes = [...source.matchAll(/reason\('tunnel\.(\w+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 6);
  for (const code of codes) {
    for (const lang of ['en', 'es']) assert.ok(i18n.exists(`server:tunnel.${code}`, { lng: lang }), `${lang}: tunnel.${code}`);
  }
});

test('closing is only questioned when this page came through the tunnel', () => {
  assert.equal(reachedThrough(URL_, `${NODE}:8443`), true);
  // The same machine on another port is not the tunnel
  assert.equal(reachedThrough(URL_, NODE), false);
  assert.equal(reachedThrough(URL_, 'localhost:8787'), false);
  assert.equal(reachedThrough(null, `${NODE}:8443`), false);
});

// ---------- the event feed ----------

test('a page that closed the tunnel it came through says the address is gone, with no button left to press', () => {
  const html = wrap(<TunnelPanel status={status('active')} authMode="token" closedHere onStart={() => {}} onStop={() => {}} />);
  assert.match(html, /data-testid="tunnel-closed-here"/);
  assert.match(text(html), /Tunnel closed/);
  assert.match(text(html), /its address no longer works/);
  assert.doesNotMatch(html, /tunnel-stop|tunnel-start|tunnel-address/);
});

test('the tunnel and the settings are written whole from their events, and a new default reaches the overview', () => {
  const client = new QueryClient();
  const tunnel = status('active');
  patchSettings(client, { id: 1, at: '', type: 'tunnel.changed', tunnel } as Parameters<typeof patchSettings>[1]);
  assert.deepEqual(client.getQueryData(keys.tunnel), tunnel);

  const settings: AppSettings = {
    allowedHosts: [],
    maxConcurrentRuns: 4,
    defaultPermissionMode: 'plan',
    setupSeen: false,
    sources: { allowedHosts: 'default', maxConcurrentRuns: 'file', defaultPermissionMode: 'file', setupSeen: 'default' },
    allowedHostLayers: { env: [], file: [], runtime: [] },
  };
  const event = { id: 2, at: '', type: 'settings.changed', settings } as Parameters<typeof patchSettings>[1];
  patchSettings(client, event);
  assert.deepEqual(client.getQueryData(keys.appSettings), settings);
  assert.deepEqual(targetsFor(event as Parameters<typeof targetsFor>[0]).map(([key]) => key), [keys.overview]);
});

// ---------- the layered settings ----------

const layered = (sources: Partial<AppSettings['sources']> = {}, hosts: Partial<AppSettings['allowedHostLayers']> = {}): AppSettings => {
  const allowedHostLayers = { env: [], file: ['agentry.example.com'], runtime: [], ...hosts };
  return {
    allowedHosts: [...allowedHostLayers.env, ...allowedHostLayers.file],
    maxConcurrentRuns: 8,
    defaultPermissionMode: 'acceptEdits',
    setupSeen: false,
    sources: { allowedHosts: 'file', maxConcurrentRuns: 'default', defaultPermissionMode: 'default', setupSeen: 'default', ...sources },
    allowedHostLayers,
  };
};

test('a save sends only what moved, and never a key the environment set', () => {
  const saved = layered({ maxConcurrentRuns: 'env' });
  assert.deepEqual(changedSettings(saved, { ...saved }), {});
  assert.deepEqual(changedSettings(saved, { defaultPermissionMode: 'plan' }), { defaultPermissionMode: 'plan' });
  assert.deepEqual(changedSettings(saved, { maxConcurrentRuns: 2 }), {});
  assert.deepEqual(changedSettings(saved, { allowedHosts: ['a.example.com', 'b.example.com'] }), { allowedHosts: ['a.example.com', 'b.example.com'] });
});

test("hosts are compared with the ones added here, so the environment's never count as a change", () => {
  const saved = layered({ allowedHosts: 'env' }, { env: ['*.devtunnels.ms'], file: ['agentry.example.com'] });
  assert.deepEqual(changedSettings(saved, { allowedHosts: ['agentry.example.com'] }), {});
  assert.deepEqual(changedSettings(saved, { allowedHosts: ['agentry.example.com', '192.168.1.184'] }), { allowedHosts: ['agentry.example.com', '192.168.1.184'] });
  // The run defaults' save does not carry the hosts along
  assert.deepEqual(changedSettings(saved, { maxConcurrentRuns: 8, defaultPermissionMode: 'acceptEdits' }), {});
});

test('hosts are read one per line, lower-cased, without the blanks', () => {
  assert.deepEqual(parseHosts(' Agentry.Example.com\n\n*.corp.example.com ,x.example.com\n'), ['agentry.example.com', '*.corp.example.com', 'x.example.com']);
});

test('a setting the environment set is shown read-only, naming its variable', () => {
  const client = new QueryClient();
  client.setQueryData(keys.appSettings, layered({ allowedHosts: 'env', defaultPermissionMode: 'env' }, { env: ['*.devtunnels.ms'], file: ['agentry.example.com'] }));
  const html = wrap(<AppSettingsCards />, client);
  assert.ok(text(html).includes('set by the environment'));
  assert.ok(html.includes('AGENTRY_ALLOWED_HOSTS'));
  assert.ok(html.includes('AGENTRY_DEFAULT_PERMISSION_MODE'));
  // The environment's hosts are a tagged list; the ones added here stay editable beside them
  assert.match(html, /<li class="app-settings-host"><span class="mono">\*\.devtunnels\.ms<\/span><span class="badge badge-muted"><span class="badge-text">set by the environment/);
  assert.match(html, /<textarea[^>]*data-testid="allowed-hosts"[^>]*>agentry\.example\.com<\/textarea>/);
  assert.ok(text(html).includes('beside the ones from the environment'));
  // The mode's picker is disabled; the run limit stays editable
  assert.match(html, /role="combobox"[^>]*disabled=""[^>]*class="select-trigger/);
  assert.doesNotMatch(html, /AGENTRY_MAX_CONCURRENT_RUNS/);
});

test("the tunnel's host is listed read-only while it is lent, and is not in the field", () => {
  const client = new QueryClient();
  client.setQueryData(keys.appSettings, layered({}, { file: [], runtime: ['abc123.lhr.life'] }));
  const html = wrap(<AppSettingsCards />, client);
  assert.match(html, /<span class="mono">abc123\.lhr\.life<\/span><span class="badge badge-muted"><span class="badge-text">tunnel, while it is open/);
  assert.match(html, /<textarea[^>]*data-testid="allowed-hosts"[^>]*><\/textarea>/);
  assert.doesNotMatch(html, /AGENTRY_ALLOWED_HOSTS/);
});

test('settings nobody pinned are editable', () => {
  const client = new QueryClient();
  client.setQueryData(keys.appSettings, layered());
  const html = wrap(<AppSettingsCards />, client);
  assert.doesNotMatch(html, /set by the environment/);
  assert.doesNotMatch(html, /fixed-hosts/);
  assert.match(html, /<textarea[^>]*data-testid="allowed-hosts"[^>]*>agentry\.example\.com<\/textarea>/);
});
