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
    // The palette is the sidebar's search field on a desktop, not a second one in the bar
    check(await page.eval(`return !!document.querySelector('#sidebar .palette-trigger')?.getClientRects().length`), 'the palette trigger is in the sidebar');
    check(!(await page.eval(`return !!document.querySelector('.topbar .palette-trigger')?.getClientRects().length`)), 'and not in the top bar on a desktop');
    // The sidebar's two groups, and the status bar at the bottom of the column
    const groups = await page.eval(`return [...document.querySelectorAll('#sidebar .nav-group')].map((g) => [...g.querySelectorAll('a')].map((a) => a.getAttribute('href').split('?')[0]))`);
    check(JSON.stringify(groups) === JSON.stringify([['/', '/chats', '/orchestration', '/schedules'], ['/projects', '/accounts', '/connectors', '/usage', '/settings']]), `the sidebar has the Work and Space groups (${JSON.stringify(groups)})`);
    const status = await page.eval(`const s = document.querySelector('.statusbar'); if (!s) return null; const r = s.getBoundingClientRect(); return { height: r.height, bottom: r.bottom, text: s.innerText }`);
    check(status !== null && Math.round(status.height) === 30 && Math.abs(status.bottom - 900) <= 1, `the status bar is 30px at the bottom (${JSON.stringify(status)})`);
    check(/Claude Code|CLI not detected|Not logged in|Connecting|unreachable/.test(status?.text ?? ''), `the status bar says the connection or the CLI (${status?.text})`);
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
      check(tabbar !== null && tabbar.tabs.length === 4 && tabbar.tabs.every((h) => h >= 44), `[390px ${path}] four tabs, each at least 44px tall (${tabbar?.tabs.join(', ')})`);
      check(!(await page.eval(`return !!document.querySelector('.topbar-new')?.getClientRects().length`)), `[390px ${path}] New chat moved from the top bar to the FAB`);
      check(!(await page.eval(`return !!document.querySelector('.statusbar')?.getClientRects().length`)), `[390px ${path}] the status bar is desktop only`);
      // Labels are whole words: "Orchestrations" used to be cut to "Orquestaciones" minus its end
      const cut = await page.eval(`return [...document.querySelectorAll('.tabbar-label')].filter((l) => l.scrollWidth > l.clientWidth + 1).map((l) => l.textContent)`);
      check(cut.length === 0, `[390px ${path}] no tab label is truncated (${cut.join(', ')})`);
    }
    // The FAB: New chat in words on Home, an icon on the lists, New orchestration on its page, none on Settings
    const fab = async (path) => {
      await page.goto(path, 900);
      return page.eval(`const f = document.querySelector('.fab'); if (!f || !f.getClientRects().length) return null; const r = f.getBoundingClientRect(), t = document.querySelector('.tabbar').getBoundingClientRect(); return { text: f.innerText.trim(), name: f.getAttribute('aria-label') ?? f.innerText.trim(), above: t.top - r.bottom, height: r.height, width: r.width, right: innerWidth - r.right }`);
    };
    const home = await fab('/');
    check(home?.text === 'New chat', `[390px /] the FAB says New chat (${home?.text})`);
    check(home !== null && home.above >= 8 && home.height >= 44 && home.width >= 44 && home.right >= 8, `[390px /] the FAB sits above the tab bar, inside the screen, 44px or larger (${JSON.stringify(home)})`);
    const list = await fab('/chats');
    check(list?.text === '' && list?.name === 'New chat', `[390px /chats] the FAB is an icon named New chat (${JSON.stringify(list)})`);
    const orchestrations = await fab('/orchestration');
    check(orchestrations?.name === 'New orchestration', `[390px /orchestration] the FAB starts an orchestration (${JSON.stringify(orchestrations)})`);
    await page.click('.fab', undefined, 900);
    check((await page.eval(`return location.pathname + location.search`)) === '/orchestration?new=1', 'the Orchestrations FAB opens the new orchestration form');
    check((await fab('/settings')) === null, '[390px /settings] no FAB where there is nothing to start');
    await fab('/');
    await page.click('.fab', undefined, 900);
    check((await page.eval(`return location.pathname`)) === '/chats/new', 'the Home FAB opens New chat');
    check(!(await page.eval(`return !!document.querySelector('.fab')`)), 'New chat has its own composer, so the FAB steps aside');
    await page.goto('/orchestration', 900);
    check((await page.eval(`return document.querySelector('.tabbar a[href="/orchestration"]')?.classList.contains('is-active')`)) === true, 'the current tab is marked');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); localStorage.removeItem('agentry-motion'); localStorage.removeItem('agentry-language'); localStorage.removeItem('agentry-palette-recent'); return true`).catch(() => {});
  }
};
