// Tool presets: the shipped ones are listed, a new one is created and removed from Settings, and the
// New chat form offers them beside the choice of MCP servers. Starting a chat needs a logged-in CLI,
// so what a chat runs with is covered by the core tests, not here.
export default async ({ page, api, check }) => {
  const shipped = (await api.get('/config/tool-presets')).body;
  check(shipped.some((p) => p.id === 'read-only') && shipped.every((p) => p.builtIn), 'the shipped presets are listed');

  await page.goto('/settings?tab=tools', 1500);
  const listed = await page.text('[role=tabpanel]');
  check(listed.includes('Read only') && listed.includes('No network') && listed.includes('Everything'), 'Settings lists the shipped presets');

  await page.click('button', 'New preset', 600);
  await page.fill('[role=tabpanel] input[maxlength="80"]', 'E2E docs');
  await page.click('button', 'Save preset', 1200);
  const stored = (await api.get('/config/tool-presets')).body.find((p) => p.id === 'e2e-docs');
  check(stored?.name === 'E2E docs', 'a new preset is stored under an id made from its name');

  await page.goto('/chats/new', 1200);
  await page.click('[aria-label="Tool preset"]', undefined, 400);
  const options = await page.eval(`return [...document.querySelectorAll('[role=listbox] [role=option]')].map(o => o.textContent)`);
  check(options.some((o) => o.includes('E2E docs')), 'New chat offers the preset');
  await page.key('Escape');

  // Choosing servers shows the configured ones, and leaving them alone shows nothing
  check(!(await page.text('body')).includes('Start with only these servers'), 'the server list stays out of the way by default');
  await page.select('[aria-label="MCP servers"]', 'Only the ones I choose');
  check((await page.text('body')).includes('Start with only these servers'), 'choosing servers reveals the list');

  await page.goto('/settings?tab=tools', 1200);
  await page.click('button[aria-label="Remove E2E docs"]', undefined, 500);
  await page.eval(`const d=document.querySelector('[role=dialog],[role=alertdialog]');[...d.querySelectorAll('button')].find(b=>/remove/i.test(b.textContent)).click();return true`);
  await page.sleep(1000);
  check(!(await api.get('/config/tool-presets')).body.some((p) => p.id === 'e2e-docs'), 'the preset is removed after confirmation');
};
