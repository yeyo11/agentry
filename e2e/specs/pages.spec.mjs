// Every page renders in both themes and at phone width without console errors.
const PAGES = ['/', '/chats', '/tasks', '/projects', '/runs/new', '/orchestration', '/memory', '/plugins', '/accounts', '/config', '/config?tab=settings', '/config?tab=mcp', '/config?tab=files'];

export default async ({ page, check }) => {
  for (const theme of ['dark', 'light']) {
    await page.goto('/');
    await page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(theme)}); return true`);
    for (const path of PAGES) {
      await page.goto(path, 900);
      const main = await page.waitFor(`return document.querySelector('main')?.innerText.trim().length > 20`, { label: `${path} content` });
      check(main, `${path} rendered (${theme})`);
      check((await page.eval('return document.documentElement.dataset.theme')) === theme, `${theme} theme applied on ${path}`);
    }
    const bg = await page.eval('return getComputedStyle(document.body).backgroundColor');
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    check(theme === 'dark' ? r + g + b < 200 : r + g + b > 600, `${theme} theme background is ${bg}`);
    await page.shot(`pages-${theme}`);
  }
  // Multi-account support is optional: without claude-swap the page must say so instead of breaking
  await page.goto('/accounts', 900);
  const accounts = await page.eval(`return document.querySelector('main')?.innerText ?? ''`);
  check(/claude-swap is not installed/i.test(accounts), 'accounts page degrades without claude-swap');

  await page.viewport(420, 900);
  for (const path of ['/', '/config?tab=settings', '/plugins']) {
    await page.goto(path, 900);
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 2, `${path} overflows horizontally by ${overflow}px at 420px`);
  }
  await page.viewport(1440, 900);
  await page.eval(`localStorage.removeItem('agentry-theme'); return true`);
};
