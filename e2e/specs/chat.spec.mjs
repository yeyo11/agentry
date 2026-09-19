// Live conversation with Claude: start, stream, follow-up turn, stop. Needs E2E_LIVE=1.
export const live = true;

export default async ({ page, check }) => {
  await page.goto('/runs/new', 1200);
  await page.fill('textarea', 'Reply with exactly: PONG-1. Do not use tools.');
  await page.fill('main input[role=combobox][aria-label="Model"]', 'haiku');
  await page.click('main button', 'Start run', 1500);
  check(/^\/runs\/[\w-]+$/.test(await page.eval('return location.pathname')), 'redirected to the run view');
  await page.waitFor(`return document.querySelector('main').innerText.split('PONG-1').length >= 3`, { timeout: 60000, label: 'first reply streamed' });
  await page.shot('chat-run');

  await page.fill('main textarea', 'Now reply with exactly: PONG-2');
  await page.click('main button', 'Send');
  await page.waitFor(`return document.querySelector('main').innerText.split('PONG-2').length >= 3`, { timeout: 60000, label: 'follow-up reply' });
  await page.click('main button', 'Stop', 1500).catch(() => {});
};
