import assert from 'node:assert/strict';
import test from 'node:test';
import { isAppPath } from '../src/ipc.ts';
import { parseTitleBarTheme, SPLASH_TITLE_BAR, TITLE_BAR_HEIGHT, titleBarOptions } from '../src/title-bar.ts';

test('Linux and Windows get a controls overlay as tall as the top bar; macOS keeps its traffic lights', () => {
  assert.deepEqual(titleBarOptions('linux', SPLASH_TITLE_BAR), {
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...SPLASH_TITLE_BAR, height: TITLE_BAR_HEIGHT },
  });
  assert.equal(titleBarOptions('win32', SPLASH_TITLE_BAR).titleBarOverlay?.height, 54);
  const mac = titleBarOptions('darwin', SPLASH_TITLE_BAR);
  assert.equal(mac.titleBarOverlay, undefined);
  assert.deepEqual(mac.trafficLightPosition, { x: 18, y: 19 });
});

test('only plain hex colours from the page reach the title bar', () => {
  assert.deepEqual(parseTitleBarTheme({ color: '#FAF9F7', symbolColor: '#1c1b19' }), { color: '#faf9f7', symbolColor: '#1c1b19' });
  assert.deepEqual(parseTitleBarTheme({ color: '#fff', symbolColor: '#000' }), { color: '#fff', symbolColor: '#000' });
  assert.equal(parseTitleBarTheme({ color: 'red', symbolColor: '#000' }), null);
  assert.equal(parseTitleBarTheme({ color: '#fff; x', symbolColor: '#000' }), null);
  assert.equal(parseTitleBarTheme({ color: '#fff' }), null);
  assert.equal(parseTitleBarTheme('#fff'), null);
  assert.equal(parseTitleBarTheme(null), null);
});

test('the tray only opens paths inside the app', () => {
  assert.ok(isAppPath('/chats/new'));
  assert.ok(isAppPath('/orchestration/abc?view=graph'));
  assert.ok(!isAppPath('//evil.example/x'));
  assert.ok(!isAppPath('https://evil.example'));
  assert.ok(!isAppPath('/\\evil.example'));
  assert.ok(!isAppPath('chats'));
});
