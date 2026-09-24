// Live conversation with Claude: start, stream, follow-up turn, stop. Needs E2E_LIVE=1.
export const live = true;

export default async ({ page, check }) => {
  await page.goto('/chats/new', 1200);
  await page.fill('textarea', 'Reply with exactly: PONG-1. Do not use tools.');
  // The model is behind the line under the box, where a chat keeps the same settings
  await page.click('.composer-status', undefined, 400);
  await page.fill('input[role=combobox][aria-label="Model"]', 'haiku');
  await page.key('Escape');
  await page.click('main button[aria-label="Start chat"]', undefined, 1500);
  check(/^\/chats\/[\w-]+$/.test(await page.eval('return location.pathname')), 'redirected to the chat');
  await page.waitFor(`return document.querySelector('main').innerText.split('PONG-1').length >= 3`, { timeout: 60000, label: 'first reply streamed' });
  await page.shot('chat-live');

  await page.fill('main textarea', 'Now reply with exactly: PONG-2');
  await page.click('main button[aria-label="Send"]');
  await page.waitFor(`return document.querySelector('main').innerText.split('PONG-2').length >= 3`, { timeout: 60000, label: 'follow-up reply' });
  await page.click('main button[aria-label="Interrupt"]', undefined, 1500).catch(() => {});
};
