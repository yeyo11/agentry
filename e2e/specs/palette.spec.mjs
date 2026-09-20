// Command palette: keyboard open, fuzzy search, Enter to navigate, theme commands, recents, Esc.
export default async ({ page, check }) => {
  await page.goto('/', 1500);
  await page.key('k', 2);
  await page.waitFor(`return !!document.querySelector('[role=dialog][aria-label="Command palette"]')`, { label: 'palette open' });
  await page.type('mcp');
  await page.sleep(300);
  check((await page.eval(`return document.querySelector('.palette-option-title')?.textContent`)) === 'MCP servers', 'best match first');
  await page.key('Enter');
  await page.waitFor(`return location.pathname + location.search === '/settings?tab=mcp'`, { label: 'navigated to MCP servers' });
  await page.waitFor(`return !document.querySelector('.palette')`, { label: 'palette closes after running a command (exit animation)' });

  await page.key('k', 2);
  await page.type('light theme');
  await page.sleep(300);
  await page.key('Enter');
  await page.waitFor(`return document.documentElement.dataset.theme === 'light'`, { label: 'theme command applied' });
  await page.waitFor(`return !document.querySelector('.palette')`, { label: 'palette closed' });

  await page.key('k', 2);
  await page.sleep(300);
  check((await page.eval(`return document.querySelector('.palette-group')?.textContent`)) === 'Recent', 'recent commands listed first');
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('.palette')`, { label: 'Esc closes the palette' });
  await page.eval(`localStorage.removeItem('agentry-theme'); localStorage.removeItem('agentry-palette-recent'); return true`);
};
