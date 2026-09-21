// Tool presets: the shipped ones are listed, a new one is created, made the default and removed from
// Settings, the shipped ones are restored after an edit, and the New chat form offers the presets
// beside the choice of MCP servers and says which one applies when none is picked. Starting a chat needs a logged-in CLI,
// so what a chat runs with is covered by the core tests, not here.
export default async ({ page, api, check }) => {
  const shipped = (await api.get('/config/tool-presets')).body.presets;
  check(shipped.some((p) => p.id === 'read-only') && shipped.every((p) => p.builtIn), 'the shipped presets are listed');

  await page.goto('/settings?tab=tools', 1500);
  const listed = await page.text('[role=tabpanel]');
  check(listed.includes('Read only') && listed.includes('No network') && listed.includes('Everything'), 'Settings lists the shipped presets');

  await page.click('button', 'New preset', 600);
  await page.fill('[role=tabpanel] input[maxlength="80"]', 'E2E docs');
  await page.click('button', 'Save preset', 1200);
  const stored = (await api.get('/config/tool-presets')).body.presets.find((p) => p.id === 'e2e-docs');
  check(stored?.name === 'E2E docs', 'a new preset is stored under an id made from its name');

  // The default is picked in Settings and named by the New chat form
  await page.select('[aria-label="Default preset"]', 'E2E docs');
  await page.sleep(600);
  check((await api.get('/config/tool-presets')).body.defaultPresetId === 'e2e-docs', 'the default preset is stored');
  check((await page.text('[role=tabpanel] tbody')).includes('Default'), 'the default is marked in the list');

  await page.goto('/chats/new', 1200);
  const unpicked = await page.text('[aria-label="Tool preset"]');
  check(unpicked.includes('Default (E2E docs)'), `a new chat that picks no preset says it takes the default (${unpicked})`);
  check((await page.text('main')).includes('the default preset, E2E docs'), 'the hint names the default preset');
  await page.click('[aria-label="Tool preset"]', undefined, 400);
  const options = await page.eval(`return [...document.querySelectorAll('[role=listbox] [role=option]')].map(o => o.textContent)`);
  check(options.some((o) => o.includes('E2E docs')), 'New chat offers the preset');
  check(options.some((o) => o.includes("No preset: the CLI's own tools")), 'New chat can opt out of the default');
  await page.key('Escape');

  // Choosing servers shows the configured ones, and leaving them alone shows nothing
  check(!(await page.text('body')).includes('Start with only these servers'), 'the server list stays out of the way by default');
  await page.select('[aria-label="MCP servers"]', 'Only the ones I choose');
  check((await page.text('body')).includes('Start with only these servers'), 'choosing servers reveals the list');

  // Restore puts back an edited shipped preset and leaves the others and the default alone
  const readOnly = shipped.find((p) => p.id === 'read-only');
  await api.put('/config/tool-presets/read-only', { name: 'Read only (edited)', allowedTools: ['Read'], disallowedTools: [] });
  await page.goto('/settings?tab=tools', 1200);
  await page.click('button', 'Restore shipped presets', 500);
  await page.eval(`const d=document.querySelector('[role=dialog],[role=alertdialog]');[...d.querySelectorAll('button')].find(b=>/restore/i.test(b.textContent)).click();return true`);
  await page.sleep(1000);
  const restored = (await api.get('/config/tool-presets')).body;
  const back = restored.presets.find((p) => p.id === 'read-only');
  check(back?.name === readOnly.name && JSON.stringify(back.allowedTools) === JSON.stringify(readOnly.allowedTools), 'the shipped preset is back as it ships');
  check(restored.presets.some((p) => p.id === 'e2e-docs') && restored.defaultPresetId === 'e2e-docs', 'restoring left our preset and the default alone');

  await page.click('button[aria-label="Remove E2E docs"]', undefined, 500);
  await page.eval(`const d=document.querySelector('[role=dialog],[role=alertdialog]');[...d.querySelectorAll('button')].find(b=>/remove/i.test(b.textContent)).click();return true`);
  await page.sleep(1000);
  const after = (await api.get('/config/tool-presets')).body;
  check(!after.presets.some((p) => p.id === 'e2e-docs'), 'the preset is removed after confirmation');
  check(after.defaultPresetId === null, 'removing the default preset clears the default');
};
