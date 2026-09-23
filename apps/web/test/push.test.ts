// What the page decides about Web Push before it touches a single browser API: whether this
// browser can be pushed to at all, what the device list will call it, and the two encodings the
// API and the `PushManager` disagree about.
//
// The first of these is the one worth a test file. An insecure origin and an iOS tab are states in
// which every push API is simply missing, and the difference between a feature and a bug report is
// whether the UI says so or shows a switch that does nothing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  applicationServerKey,
  deviceLabel,
  isIosDevice,
  pushBlocker,
  subscriptionId,
  type PushEnvironment,
} from '../src/lib/push-model.ts';

/** A browser that can be pushed to: everything below turns one thing off. */
const CAPABLE: PushEnvironment = {
  secure: true,
  serviceWorker: true,
  pushManager: true,
  permission: 'default',
  ios: false,
  standalone: false,
  configured: true,
};

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadOs: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
};

test('a browser with everything in place is not blocked', () => {
  assert.equal(pushBlocker(CAPABLE), null);
  assert.equal(pushBlocker({ ...CAPABLE, permission: 'granted' }), null);
  // The server has not answered yet: the switch is shown, and `ready` is what holds it disabled
  assert.equal(pushBlocker({ ...CAPABLE, configured: null }), null);
});

test('an insecure origin is the first thing said, because it is what makes the rest undecidable', () => {
  const lan: PushEnvironment = { ...CAPABLE, secure: false, serviceWorker: false, pushManager: false, permission: 'unsupported' };
  assert.equal(pushBlocker(lan), 'insecure');
  // Even with everything else apparently fine — http://localhost is secure, http://192.168.1.10 is not
  assert.equal(pushBlocker({ ...CAPABLE, secure: false }), 'insecure');
});

test('an iPhone in a tab is told to install, not that its browser cannot do this', () => {
  assert.equal(pushBlocker({ ...CAPABLE, ios: true, pushManager: false, permission: 'unsupported' }), 'iosTab');
  // The same iPhone, from the Home Screen, is an ordinary capable browser
  assert.equal(pushBlocker({ ...CAPABLE, ios: true, standalone: true }), null);
});

test('a browser with no worker, no PushManager or no Notification cannot be pushed to', () => {
  assert.equal(pushBlocker({ ...CAPABLE, serviceWorker: false }), 'unsupported');
  assert.equal(pushBlocker({ ...CAPABLE, pushManager: false }), 'unsupported');
  assert.equal(pushBlocker({ ...CAPABLE, permission: 'unsupported' }), 'unsupported');
});

test('a server with no keypair, and a permission already refused, each say so', () => {
  assert.equal(pushBlocker({ ...CAPABLE, configured: false }), 'unconfigured');
  assert.equal(pushBlocker({ ...CAPABLE, permission: 'denied' }), 'denied');
  // Nothing to be gained from asking a denied browser again; it is terminal until system settings
  assert.equal(pushBlocker({ ...CAPABLE, permission: 'denied', configured: false }), 'unconfigured');
});

test('an iPad gives itself away by having a touch screen, since it calls itself a Mac', () => {
  assert.equal(isIosDevice(UA.ipadOs, 5), true);
  assert.equal(isIosDevice(UA.ipadOs, 0), false, 'a real Mac is not an iPad');
  assert.equal(isIosDevice(UA.iphoneSafari, 5), true);
  assert.equal(isIosDevice(UA.androidChrome, 5), false);
});

test('the device list names a phone the way its owner would', () => {
  assert.equal(deviceLabel(UA.androidChrome), 'Android · Chrome');
  assert.equal(deviceLabel(UA.iphoneSafari), 'iPhone · Safari');
  assert.equal(deviceLabel(UA.linuxFirefox), 'Linux · Firefox');
  // Every Edge says Chrome, and every Chrome says Safari: the order of the table is the test
  assert.equal(deviceLabel(UA.windowsEdge), 'Windows · Edge');
  assert.equal(deviceLabel(UA.ipadOs, { ios: true }), 'iPad · Safari');
  assert.equal(deviceLabel('something nobody has heard of'), 'Web');
});

test('an installed app and a tab on the same phone are two rows, and say which is which', () => {
  assert.equal(deviceLabel(UA.androidChrome, { standalone: true }), 'Android · Chrome · PWA');
  assert.notEqual(deviceLabel(UA.androidChrome, { standalone: true }), deviceLabel(UA.androidChrome));
});

test('the VAPID key reaches subscribe() as the bytes it was, whatever base64 it came in', () => {
  // `QUJD` is `ABC`; `-` and `_` are the URL-safe alphabet, and the padding is missing on purpose
  assert.deepEqual([...applicationServerKey('QUJD')], [65, 66, 67]);
  assert.deepEqual([...applicationServerKey('-_8')], [...Buffer.from('fbff', 'hex')]);
  assert.equal(applicationServerKey('BEl1O0Zq').length, 6);
});

test('this browser knows which row of the device list is itself', async () => {
  const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/abcdef';
  // The same derivation as `idOfEndpoint` in @agentry/core, which is what filed the row
  assert.equal(await subscriptionId(endpoint), createHash('sha256').update(endpoint).digest('hex').slice(0, 16));
  assert.notEqual(await subscriptionId(endpoint), await subscriptionId(`${endpoint}2`));
});
