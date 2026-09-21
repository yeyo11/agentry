// The shell: a one-row top bar whose "New chat ▾" also starts a workflow or an orchestration,
// Settings → Appearance as the one place for theme, language and motion (they left the top bar),
// the palette reaching the same preferences, and a phone's bottom tab bar instead of a slide-over.

const openNewMenu = async (page) => {
  await page.focus('.topbar-new .split-btn-more');
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the New chat menu opens' });
};

export default async ({ page, check }) => {
  try {
    await page.viewport(1440, 900);
    await page.goto('/', 1500);

    // ---- the top bar: one row, no preferences in it ----
    const bar = await page.eval(`const b = document.querySelector('.topbar'); return { text: b.innerText, height: b.getBoundingClientRect().height, selects: b.querySelectorAll('.select-trigger').length }`);
    check(bar.selects === 1, `the top bar has one select, the project (got ${bar.selects})`);
    check(!/theme/i.test(await page.eval(`return [...document.querySelectorAll('.topbar [aria-label]')].map((e) => e.getAttribute('aria-label')).join('|')`)), 'the theme toggle left the top bar');
    check(bar.height <= 60, `the top bar is one row (${bar.height}px)`);
    check((await page.text('.topbar-new .split-btn-main')).trim() === 'New chat', 'the primary action is New chat');

    await openNewMenu(page);
    const items = await page.eval(`return [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((i) => i.textContent.trim())`);
    for (const item of ['Run workflow', 'New orchestration']) check(items.includes(item), `"${item}" is behind New chat ▾ (${items.join(', ')})`);
    await page.click('[role=menu] [role=menuitem]', 'New orchestration', 900);
    check((await page.eval(`return location.pathname + location.search`)) === '/orchestration?new=1', 'New orchestration opens the Orchestrations page with its form');

    // ---- Settings → Appearance: the first tab, and what /settings opens on ----
    await page.goto('/settings', 1200);
    const selected = await page.eval(`return document.querySelector('main [role=tab][aria-selected=true]')?.textContent.trim()`);
    check(selected === 'Appearance', `Settings opens on Appearance (got ${selected})`);
    const panel = await page.text('[role=tabpanel]');
    for (const heading of ['Theme', 'Language', 'Motion']) check(panel.includes(heading), `Appearance has ${heading}`);

    await page.click('[role=tabpanel] [role=radio]', 'Light');
    await page.waitFor(`return document.documentElement.dataset.theme === 'light'`, { label: 'Light applies the light theme' });
    await page.click('[role=tabpanel] [role=radio]', 'Subtle');
    await page.waitFor(`return document.documentElement.dataset.motion === 'subtle' && localStorage.getItem('agentry-motion') === 'subtle'`, { label: 'Subtle is applied and stored' });
    check((await page.text('[role=tabpanel]')).includes('spinners hold still'), 'the chosen level says what it does');

    // The operating system's reduced motion wins, and the page says so instead of silently ignoring the choice
    await page.reduceMotion(true);
    await page.waitFor(`return document.documentElement.dataset.motion === 'off'`, { label: 'reduced motion forces off' });
    await page.waitFor(`return !!document.querySelector('[role=tabpanel] [role=note]')`, { label: 'the override is explained' });
    await page.reduceMotion(false);
    await page.waitFor(`return document.documentElement.dataset.motion === 'subtle'`, { label: 'the stored choice is back once the system stops asking' });

    await page.select('[role=tabpanel] .select-trigger', 'Español');
    await page.waitFor(`return document.documentElement.lang === 'es'`, { label: 'the language changes from Appearance' });
    await page.select('[role=tabpanel] .select-trigger', 'English');
    await page.waitFor(`return document.documentElement.lang === 'en'`, { label: 'and changes back' });

    // ---- the palette reaches the same preferences ----
    await page.key('k', 2);
    await page.waitFor(`return !!document.querySelector('[role=dialog][aria-label="Command palette"]')`, { label: 'palette open' });
    await page.type('motion full');
    await page.sleep(300);
    await page.key('Enter');
    await page.waitFor(`return document.documentElement.dataset.motion === 'full'`, { label: 'the palette sets the motion level' });
    await page.waitFor(`return !document.querySelector('.palette')`, { label: 'palette closed' });

    // ---- a phone: the tab bar, nothing sideways, fingers get room ----
    await page.viewport(390, 844);
    for (const path of ['/', '/chats', '/orchestration', '/settings']) {
      await page.goto(path, 900);
      const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
      check(overflow <= 1, `[390px ${path}] nothing scrolls sideways (${overflow}px)`);
      const tabbar = await page.eval(`const t = document.querySelector('.tabbar'); if (!t) return null; const r = t.getBoundingClientRect(); return { bottom: r.bottom, tabs: [...t.querySelectorAll('.tabbar-tab')].map((e) => e.getBoundingClientRect().height) }`);
      check(tabbar !== null && Math.abs(tabbar.bottom - 844) <= 1, `[390px ${path}] the tab bar sits on the bottom edge`);
      check(tabbar !== null && tabbar.tabs.length === 5 && tabbar.tabs.every((h) => h >= 44), `[390px ${path}] five tabs, each at least 44px tall (${tabbar?.tabs.join(', ')})`);
      check(!(await page.eval(`return !!document.querySelector('.topbar-new')?.getClientRects().length`)), `[390px ${path}] New chat moved from the top bar to the tab bar`);
    }
    await page.goto('/orchestration', 900);
    check((await page.eval(`return document.querySelector('.tabbar a[href="/orchestration"]')?.classList.contains('is-active')`)) === true, 'the current tab is marked');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); localStorage.removeItem('agentry-motion'); localStorage.removeItem('agentry-language'); localStorage.removeItem('agentry-palette-recent'); return true`).catch(() => {});
  }
};
