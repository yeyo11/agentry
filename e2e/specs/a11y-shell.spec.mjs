// Accessibility of the shell around the pages (see a11y-shared.mjs): the app's pages at phone and
// tablet width, the phone's tab bar and More sheet, what opens over the pages (palette, menus,
// dialogs, panels), status that is never colour alone, and the keyboard: reachable, named, ringed, in order.
import { AGENT, a11ySpec, checkStatusWords, checkTablet, focusInfo, OVERLAY_RULES, scanNarrow, SESSION, settle } from './a11y-shared.mjs';

export const timeout = 300_000;

export default a11ySpec(async ({ page, problems, scan, fx }) => {
  const { orchestrationId } = fx;
  // ---------- axe: phone width ----------
  await scanNarrow(
    page,
    ['/', '/chats', '/chats/new', `/chats/${SESSION}`, `/orchestration/${orchestrationId}`, '/accounts', '/projects', '/schedules', '/schedules/new', '/usage', '/connectors', '/settings', '/settings?tab=settings', '/settings?tab=install', '/settings?tab=notifications', '/settings?tab=remote'],
    scan,
    problems,
  );
  // The screens that head themselves on a phone (CW-8), in the light theme too: their own headers
  // replace the top bar there, so their contrast and names are checked in both
  await scanNarrow(
    page,
    ['/chats/new', `/chats/${SESSION}`, `/orchestration/${orchestrationId}`, '/accounts', '/projects', '/schedules', '/schedules/new', '/usage', '/connectors', '/settings', '/settings?tab=install'],
    scan,
    problems,
    'light',
  );
  await checkTablet(page, ['/chats', `/chats/${SESSION}`, `/orchestration/${orchestrationId}`, '/'], problems);

  // The phone's navigation is the tab bar: the sidebar is out of the tab order, "More" is a sheet
  // that takes focus when open and gives it back to its button on Escape
  await page.viewport(420, 900);
  // All projects, where the seeded chat is: the project visited above holds none, and an empty
  // chat list offers New chat itself, so it has no FAB (FabStandIn)
  await settle(page, '/chats?project=all');
  const sidebarShown = await page.eval(`return document.querySelector('#sidebar').getClientRects().length > 0`);
  if (sidebarShown) problems.push('[420px] the sidebar is still shown next to the tab bar');
  const tabs = await page.eval(`return [...document.querySelectorAll('.tabbar a')].map((a) => a.getAttribute('href'))`);
  for (const href of ['/', '/chats', '/orchestration']) if (!tabs.includes(href)) problems.push(`[420px] the tab bar has no ${href} tab`);
  // The project scope lives in the top bar on every page and screen: one selector, never two
  const scopes = await page.eval(`return [...document.querySelectorAll('.project-selector')].map((s) => s.closest('.topbar') ? 'topbar' : s.closest('main .page-header') ? 'header' : 'elsewhere')`);
  if (scopes.join() !== 'topbar') problems.push(`[420px] /chats should have one project selector, in the top bar (found: ${scopes.join(', ') || 'none'})`);
  // New chat is the FAB on a phone: an icon on the list, so its name has to be said, and a real button
  const fab = await page.eval(`const f = document.querySelector('.fab'); return f ? { tag: f.tagName, name: f.getAttribute('aria-label'), size: Math.min(f.offsetWidth, f.offsetHeight) } : null`);
  if (!fab) problems.push('[420px] there is no New chat FAB on the chat list');
  else {
    if (fab.tag !== 'BUTTON') problems.push(`[420px] the FAB is a ${fab.tag}, not a button`);
    if (fab.name !== 'New chat') problems.push(`[420px] the icon-only FAB is named "${fab.name}", not "New chat"`);
    if (fab.size < 44) problems.push(`[420px] the FAB is ${fab.size}px, under a 44px target`);
  }
  // "Run workflow" and "New orchestration" left the tab bar for the More sheet's Start group
  await page.focus('.tabbar-more');
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('.more-sheet')`, { label: 'the More sheet opens' });
  const start = await page.eval(`return [...document.querySelectorAll('.more-sheet button.more-cell')].map((b) => b.textContent.trim())`);
  for (const item of ['Run workflow', 'New orchestration']) if (!start.includes(item)) problems.push(`[420px] More has no "${item}" (${start.join(', ')})`);
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('.more-sheet')`, { label: 'More closes' });
  await page.focus('.tabbar-more');
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('.more-sheet')`, { label: 'the More sheet opens from the keyboard' });
  await page.sleep(300);
  if (!(await page.eval(`return document.querySelector('.more-sheet').contains(document.activeElement)`))) problems.push('[420px] opening More does not move focus into it');
  if ((await page.eval(`return document.querySelector('.tabbar-more').getAttribute('aria-expanded')`)) !== 'true') problems.push('[420px] the More button does not say its sheet is open');
  const rest = await page.eval(`return [...document.querySelectorAll('.more-sheet a')].map((a) => a.getAttribute('href'))`);
  for (const href of ['/projects', '/schedules', '/usage', '/connectors', '/settings', '/docs', '/settings?tab=account']) if (!rest.includes(href)) problems.push(`[420px] More does not offer ${href}`);
  // Its sections say their figures, as the reference does: at least the project imported above is counted
  await page.waitFor(`return !!document.querySelector('.more-sheet a[href="/projects"] .more-cell-note')`, { label: 'the Projects cell has its count' });
  const projectCount = await page.text('.more-sheet a[href="/projects"] .more-cell-note');
  if (!/^[1-9]\d*$/.test(projectCount.trim())) problems.push(`[420px] the Projects cell in More should count the projects, and says "${projectCount}"`);
  await scan(page, '420px more sheet', { rules: OVERLAY_RULES });
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('.more-sheet')`, { label: 'Escape closes More' });
  await page.sleep(200);
  if (!(await page.eval(`return document.activeElement === document.querySelector('.tabbar-more')`))) problems.push('[420px] closing More with Escape does not return focus to its button');
  // A chat brings its own back button and composer: the tab bar steps aside there
  await settle(page, `/chats/${SESSION}`);
  if (await page.eval(`return !!document.querySelector('.tabbar')`)) problems.push('[420px] the tab bar covers a chat, which has its own footer');
  await page.viewport(1440, 900);
  // A desktop keeps the scope in the top bar, on Chats too
  await settle(page, '/chats');
  const desktopScopes = await page.eval(`return [...document.querySelectorAll('.project-selector')].map((s) => s.closest('.topbar') ? 'topbar' : 'page')`);
  if (desktopScopes.join() !== 'topbar') problems.push(`[1440px] /chats should have one project selector, in the top bar (found: ${desktopScopes.join(', ') || 'none'})`);

  // ---------- axe: what opens over the pages ----------
  await page.eval(`localStorage.removeItem('agentry:project'); return true`);
  await settle(page, '/');
  await page.key('k', 2);
  await page.waitFor(`return !!document.querySelector('[role=dialog][aria-label="Command palette"]')`, { label: 'palette open' });
  await scan(page, 'command palette', { rules: OVERLAY_RULES });
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('.palette')`, { label: 'palette closed' });

  await page.click('.project-selector', undefined, 400);
  await page.waitFor(`return !!document.querySelector('[role=listbox]')`, { label: 'project menu open' });
  // An open Select hides the whole page from assistive technology, so the page-level rules have nothing to find
  await scan(page, 'project selector', { rules: { ...OVERLAY_RULES, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } } });
  await page.key('Escape');

  await page.click('.bell', undefined, 500);
  await page.waitFor(`return !!document.querySelector('.notif-panel')`, { label: 'notification panel open' });
  await scan(page, 'notification panel', { rules: OVERLAY_RULES });
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('.notif-panel')`, { label: 'notification panel closed' });

  // "Run workflow" lives behind "New chat ▾" now: the menu, then the dialog it opens
  await page.focus('.topbar-new .split-btn-more');
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'New chat menu open' });
  await scan(page, 'new chat menu', { rules: { ...OVERLAY_RULES, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } } });
  await page.click('[role=menu] [role=menuitem]', 'Run workflow', 600);
  await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'workflow dialog open' });
  await scan(page, 'run workflow dialog', { rules: OVERLAY_RULES });
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'workflow dialog closed' });

  for (const [what, ref] of [['task panel', `task:${SESSION}:bg-sub-1`], ['subagent panel', `subagent:${SESSION}:${AGENT}`]]) {
    await page.goto(`/chats/${SESSION}?detail=${encodeURIComponent(ref)}`, 800);
    await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.trim().length > 20`, { label: `the ${what}` });
    await scan(page, what, { rules: OVERLAY_RULES });
    await page.key('Escape');
    await page.waitFor(`return document.querySelector('[role=dialog]') === null`, { label: `the ${what} closed` });
  }
  // A worker's chat opened beside its orchestration, the panel a task's name opens
  await page.goto(`/orchestration/${orchestrationId}?detail=${encodeURIComponent(`chat:${SESSION}`)}`, 800);
  await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.trim().length > 20`, { label: 'the chat panel' });
  await scan(page, 'chat panel', { rules: OVERLAY_RULES });
  await page.key('Escape');
  await page.waitFor(`return document.querySelector('[role=dialog]') === null`, { label: 'the chat panel closed' });

  await settle(page, '/orchestration');
  await page.click('button', 'New orchestration', 700);
  await page.sleep(400);
  await scan(page, 'new orchestration form');

  // ---------- status is never colour alone ----------
  await checkStatusWords(page, ['/', '/chats', `/chats/${SESSION}`, `/orchestration/${orchestrationId}`, '/orchestration', '/connectors'], problems);

  // ---------- the keyboard: reachable, named, ringed, in order ----------
  await page.eval(`localStorage.removeItem('agentry:project'); return true`);
  await settle(page, '/');
  await page.press('Tab');
  const first = await page.eval(focusInfo);
  if (first?.cls?.includes('skip-link')) {
    await page.press('Enter');
    if (!(await page.eval(`return document.activeElement?.id === 'main'`))) problems.push('[keyboard] the skip link does not move focus to the page');
  } else {
    problems.push(`[keyboard] the first Tab stop is not the skip link (got ${JSON.stringify(first)})`);
  }

  // From the top of a fresh load again: focus moved to the page, and Tab goes on from where it is
  await settle(page, '/');
  const stops = [];
  for (let i = 0; i < 32; i++) {
    await page.press('Tab');
    const stop = await page.eval(focusInfo);
    if (stop) stops.push(stop);
  }
  for (const stop of stops) {
    const label = `${stop.tag}${stop.role ? `[${stop.role}]` : ''} "${stop.name}"`;
    if (!stop.visible) problems.push(`[keyboard] focus lands on something not shown: ${label}`);
    if (!stop.name) problems.push(`[keyboard] a Tab stop has no name: <${stop.tag} class="${stop.cls}">`);
    if (!stop.ring) problems.push(`[keyboard] no visible focus indicator on ${label}`);
  }
  const reached = new Set(stops.map((s) => s.href).filter(Boolean));
  for (const href of ['/', '/chats', '/orchestration', '/projects', '/settings']) {
    if (!reached.has(href)) problems.push(`[keyboard] the navigation link ${href} is not reachable with Tab`);
  }
  // "Run workflow" and "New orchestration" sit in the menu behind "New chat ▾", whose arrow is its own stop
  for (const button of ['New chat', 'More options for New chat']) {
    if (!stops.some((s) => s.name === button)) problems.push(`[keyboard] "${button}" is not reachable with Tab: it would exist only in the command palette`);
  }
  if (!stops.some((s) => s.cls?.includes('project-selector'))) problems.push('[keyboard] the project selector is not reachable with Tab');

  // Enter on a focused link follows it, and the page is where focus ends up
  await page.focus('#sidebar a[href="/chats"]');
  await page.press('Enter');
  await page.waitFor(`return location.pathname === '/chats'`, { label: 'Enter follows the Chats link' });
  await page.sleep(300);
  if (!(await page.eval(`return document.querySelector('main').contains(document.activeElement)`))) problems.push('[keyboard] after following a link focus is not on the new page');
  await page.focus('.topbar-new .split-btn-main');
  await page.press('Enter');
  await page.waitFor(`return location.pathname === '/chats/new'`, { label: 'Enter presses New chat' });

  // Tabs are one Tab stop and the arrow keys move along them
  await settle(page, '/settings');
  const roving = await page.eval(`return [...document.querySelectorAll('main [role=tab]')].filter((t) => t.tabIndex === 0).length`);
  if (roving !== 1) problems.push(`[keyboard] the Settings tabs have ${roving} Tab stops (the ARIA pattern has one)`);
  const before = await page.eval(`return document.querySelector('main [role=tab][aria-selected=true]')?.textContent`);
  await page.focus('main [role=tab][aria-selected=true]');
  await page.press('ArrowRight');
  await page.waitFor(`return document.querySelector('main [role=tab][aria-selected=true]')?.textContent !== ${JSON.stringify(before)}`, { label: 'ArrowRight selects the next tab' });
  if (!(await page.eval(`return document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-selected') === 'true'`))) problems.push('[keyboard] ArrowRight on a tab does not move focus to the tab it selects');
  if (!(await page.eval(`const p = document.querySelector('main [role=tabpanel]'); const t = p && document.getElementById(p.getAttribute('aria-labelledby') ?? ''); return t?.getAttribute('aria-selected') === 'true'`))) problems.push('[keyboard] the tab panel is not named by the selected tab');

  // The command palette is a shortcut: what it offers as pages is also in the navigation
  const navigation = await page.eval(`return [...document.querySelectorAll('#sidebar nav a')].map((a) => a.getAttribute('href'))`);
  for (const href of ['/', '/chats', '/orchestration', '/projects', '/settings']) {
    if (!navigation.includes(href)) problems.push(`[keyboard] ${href} is in the palette but not in the navigation`);
  }
});
