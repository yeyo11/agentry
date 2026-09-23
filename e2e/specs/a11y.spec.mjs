// Accessibility, checked instead of asserted: axe-core over every page in both themes and at phone
// width, the overlays that open over them, the keyboard paths the palette must not be the only way
// around, and the contrast of the theme tokens (which axe cannot judge over gradients and tints).
// Findings are gathered and reported together, so one run says everything that is wrong.
//
// It seeds a chat (with a subagent and a background task), a project and an orchestration whose
// workers fail in the sandbox, so the pages are scanned with content in them, and removes all of it
// afterwards because the chats spec counts what the sandbox holds.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two themes, a phone and a dozen pages, plus the overlays and the keyboard walk
export const timeout = 420_000;

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/core/test/fixtures');
const PROJECT = '-work-e2e-a11y';
const SESSION = 'e2e-a11y-session';
const AGENT = 'a1b2c3d4e5f60718';

const line = (o) => JSON.stringify(o);

// ---------- contrast of the tokens ----------

const luminance = ([r, g, b]) => {
  const channel = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `#rrggbb` or `rgba(r, g, b, a)` as [r, g, b, a] */
function parseColor(text) {
  const hex = /^#([0-9a-f]{6})$/i.exec(text.trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text.trim());
  if (rgba) {
    const [r, g, b, a = '1'] = rgba[1].split(',').map((v) => v.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  return null;
}
const over = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];

const SURFACES = ['--bg', '--bg-elev', '--bg-sunken', '--bg-hover'];
const TEXTS = ['--text', '--text-muted', '--text-faint', '--accent', '--accent-2', '--ok', '--warn', '--bad', '--info', '--idle'];
const SOFT = { '--ok': '--ok-soft', '--warn': '--warn-soft', '--bad': '--bad-soft', '--info': '--info-soft', '--idle': '--idle-soft', '--accent': '--accent-soft', '--accent-2': '--accent-2-soft' };

async function tokenContrast(page, theme, problems) {
  const names = [...SURFACES, ...TEXTS, ...Object.values(SOFT), '--accent-text', '--gradient-accent'];
  const values = await page.eval(
    `const cs = getComputedStyle(document.documentElement); return Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, cs.getPropertyValue(n).trim()]))`,
  );
  const color = (name) => parseColor(values[name] ?? '');
  const fail = (what, got) => problems.push(`[${theme}] token contrast: ${what} is ${got.toFixed(2)}:1, needs 4.5:1`);
  for (const surface of SURFACES) {
    const bg = color(surface);
    if (!bg) continue;
    for (const text of TEXTS) {
      const fg = color(text);
      if (fg && ratio(over(fg, bg), bg) < 4.5) fail(`${text} on ${surface}`, ratio(fg, bg));
      const soft = color(SOFT[text] ?? '');
      if (fg && soft) {
        const tinted = over(soft, bg);
        if (ratio(fg, tinted) < 4.5) fail(`${text} on its tint over ${surface}`, ratio(fg, tinted));
      }
    }
  }
  const stops = [...(values['--gradient-accent'] ?? '').matchAll(/#[0-9a-f]{6}/gi)].map((m) => parseColor(m[0]));
  const onAccent = color('--accent-text');
  for (const stop of stops) {
    if (onAccent && stop && ratio(onAccent, stop) < 4.5) fail('--accent-text on the accent gradient', ratio(onAccent, stop));
  }
  if (stops.length === 0) problems.push(`[${theme}] token contrast: --gradient-accent has no colour stops to check`);
}

// ---------- axe ----------

const seen = new Map();

/** Scans the page as it is and files each new finding once, however many pages repeat it (the shell does). */
async function scan(page, where, { rules } = {}) {
  for (const violation of await page.axe({ rules })) {
    for (const node of violation.nodes) {
      const key = `${violation.id}|${node.target}`;
      const known = seen.get(key);
      if (known) {
        known.also += 1;
        continue;
      }
      seen.set(key, { where, violation, node, also: 0 });
    }
  }
}

function report(problems) {
  for (const { where, violation, node, also } of seen.values()) {
    problems.push(
      `[${where}] ${violation.id} (${violation.impact}): ${violation.help}${also ? ` — also on ${also} more page(s)` : ''}\n      ${node.target}\n      ${node.html}\n      ${node.why}`,
    );
  }
}

// Modal content is outside every landmark by design: the dialog is what names it. Radix hides the page
// behind an open menu from screen readers but leaves its controls focusable, with focus trapped in the menu.
const OVERLAY_RULES = { region: { enabled: false }, 'aria-hidden-focus': { enabled: false } };

const settle = async (page, path) => {
  await page.goto(path, 500);
  await page.waitFor(`const m = document.querySelector('main'); return m && m.innerText.trim().length > 20 && !m.querySelector('[aria-busy=true]')`, { label: `${path} content` });
  await page.sleep(400);
};

// ---------- the keyboard ----------

const focusInfo = `
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const style = getComputedStyle(el);
  const name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || '';
  // A ring is an outline; a text field shows one as a shadow, and a wrapper (the composer) can show it for its field
  const outlined = (node) => { const s = getComputedStyle(node); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0; };
  const shadowed = (node) => getComputedStyle(node).boxShadow !== 'none';
  const field = ['input', 'textarea', 'select'].includes(el.tagName.toLowerCase()) || el.isContentEditable;
  const ring = outlined(el) || (field && shadowed(el)) || [...document.querySelectorAll(':focus-within')].some((node) => node !== el && (outlined(node) || (field && shadowed(node))));
  return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), name: name.trim().replace(/\\s+/g, ' ').slice(0, 60), href: el.getAttribute('href'), cls: el.className?.toString().slice(0, 40), ring, visible: style.visibility !== 'hidden' && el.getClientRects().length > 0 };`;

export default async ({ page, api, check, dirs }) => {
  const problems = [];
  const at = new Date().toISOString();
  const projectDir = join(dirs.configDir, 'projects', PROJECT);
  const sessionDir = join(projectDir, SESSION);
  const tasksRoot = join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, PROJECT);
  const workspace = join(dirs.workspaceDir, 'e2e-a11y');
  let projectId = null;
  let orchestrationId = null;
  const orchestrationChats = [];

  try {
    // ---------- seed ----------
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${SESSION}.jsonl`),
      [
        { type: 'user', uuid: 'd1', timestamp: at, cwd: '/work/e2e-a11y', version: '2.1.0', message: { role: 'user', content: 'survey the build and tell me what to fix' } },
        {
          type: 'assistant',
          uuid: 'd2',
          timestamp: at,
          message: {
            role: 'assistant',
            id: 'msg-a11y',
            model: 'claude-sonnet-5',
            content: [
              { type: 'text', text: '### What to fix\n\n1. The **lint** step is slow\n2. A flaky test\n3. Stale `README` links\n\n| step | time |\n| --- | --- |\n| lint | 41s |\n| test | 12s |\n\n```bash\npnpm lint --fix\n```' },
              { type: 'tool_use', id: 'toolu_explore01', name: 'Task', input: { description: 'Survey the build scripts', prompt: 'List the build scripts' } },
            ],
            usage: { input_tokens: 2400, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        { type: 'user', uuid: 'd3', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_explore01', content: 'ok' }] }, toolUseResult: { agentId: AGENT } },
      ]
        .map(line)
        .join('\n'),
    );
    cpSync(join(FIXTURES, 'agent-session'), sessionDir, { recursive: true });
    mkdirSync(join(tasksRoot, SESSION, 'tasks'), { recursive: true });
    writeFileSync(join(tasksRoot, SESSION, 'tasks', 'bg-sub-1.output'), 'watching the build\nrebuilt in 12ms\n');

    mkdirSync(workspace, { recursive: true });
    const imported = await api.post('/projects/import', { path: workspace, name: 'e2e-a11y' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    projectId = imported.body.id;

    // Nothing is logged in inside the sandbox, so the first task fails, the one behind it is blocked
    // and the graph waits for a decision: the states the board has to show without colour alone
    const created = await api.post('/orchestrations', {
      name: 'e2e-a11y-board',
      objective: 'a graph whose first task fails',
      cwd: workspace,
      maxAttempts: 1,
      tasks: [
        { id: 'survey', name: 'Survey', prompt: 'Survey the code' },
        { id: 'fix', name: 'Fix', prompt: 'Fix what the survey found', dependsOn: ['survey'] },
      ],
    });
    check(created.status === 201, `the orchestration was created (${created.status})`);
    orchestrationId = created.body.id;
    for (let i = 0; i < 80; i++) {
      const state = (await api.get(`/orchestrations/${orchestrationId}`)).body;
      for (const task of state?.tasks ?? []) if (task.sessionId && !orchestrationChats.includes(task.sessionId)) orchestrationChats.push(task.sessionId);
      if (state && state.status !== 'running') break;
      await page.sleep(500);
    }

    await page.reduceMotion();
    await page.goto('/');

    // ---------- axe: every page, both themes ----------
    const pages = [
      '/',
      '/chats',
      '/chats/new',
      `/chats/${SESSION}`,
      '/projects',
      '/orchestration',
      `/orchestration/${orchestrationId}`,
      '/accounts',
      '/connectors',
      ...['account', 'instructions', 'settings', 'mcp', 'agents', 'skills', 'commands', 'output-styles', 'rules', 'files', 'memory', 'plugins', 'supervisor', 'security', 'install', 'notifications'].map((tab) => `/settings?tab=${tab}`),
      `/?project=${projectId}`,
      ...['settings', 'memory', 'resources', 'worktrees'].map((view) => `/?project=${projectId}&view=${view}`),
    ];
    for (const theme of ['dark', 'light']) {
      // Home is the selected project's page: both themes start from All projects
      await page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(theme)}); localStorage.removeItem('agentry:project'); return true`);
      await tokenContrast(page, theme, problems);
      for (const path of pages) {
        await settle(page, path);
        await scan(page, `${theme} ${path}`);
      }
    }

    // ---------- axe: phone width ----------
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    await page.viewport(420, 900);
    const narrow = ['/', '/chats', '/chats/new', `/chats/${SESSION}`, `/orchestration/${orchestrationId}`, '/settings?tab=settings', '/settings?tab=install', '/settings?tab=notifications', `/?project=${projectId}`, `/?project=${projectId}&view=settings`];
    for (const path of narrow) {
      await settle(page, path);
      await scan(page, `420px ${path}`);
      const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
      if (overflow > 1) problems.push(`[420px ${path}] the page scrolls sideways by ${overflow}px`);
    }
    await page.viewport(768, 900);
    for (const path of ['/chats', `/chats/${SESSION}`, `/orchestration/${orchestrationId}`, '/', `/?project=${projectId}`]) {
      await settle(page, path);
      const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
      if (overflow > 1) problems.push(`[768px ${path}] the page scrolls sideways by ${overflow}px`);
    }

    // The phone's navigation is the tab bar: the sidebar is out of the tab order, "More" is a sheet
    // that takes focus when open and gives it back to its button on Escape
    await page.viewport(420, 900);
    await settle(page, '/chats');
    const sidebarShown = await page.eval(`return document.querySelector('#sidebar').getClientRects().length > 0`);
    if (sidebarShown) problems.push('[420px] the sidebar is still shown next to the tab bar');
    const tabs = await page.eval(`return [...document.querySelectorAll('.tabbar a')].map((a) => a.getAttribute('href'))`);
    for (const href of ['/', '/chats', '/orchestration']) if (!tabs.includes(href)) problems.push(`[420px] the tab bar has no ${href} tab`);
    await page.focus('.tabbar-more');
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('.more-sheet')`, { label: 'the More sheet opens from the keyboard' });
    await page.sleep(300);
    if (!(await page.eval(`return document.querySelector('.more-sheet').contains(document.activeElement)`))) problems.push('[420px] opening More does not move focus into it');
    if ((await page.eval(`return document.querySelector('.tabbar-more').getAttribute('aria-expanded')`)) !== 'true') problems.push('[420px] the More button does not say its sheet is open');
    const rest = await page.eval(`return [...document.querySelectorAll('.more-sheet a')].map((a) => a.getAttribute('href'))`);
    for (const href of ['/projects', '/accounts', '/schedules', '/usage', '/connectors', '/settings', '/docs', '/settings?tab=account']) if (!rest.includes(href)) problems.push(`[420px] More does not offer ${href}`);
    await scan(page, '420px more sheet', { rules: OVERLAY_RULES });
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.more-sheet')`, { label: 'Escape closes More' });
    await page.sleep(200);
    if (!(await page.eval(`return document.activeElement === document.querySelector('.tabbar-more')`))) problems.push('[420px] closing More with Escape does not return focus to its button');
    // A chat brings its own back button and composer: the tab bar steps aside there
    await settle(page, `/chats/${SESSION}`);
    if (await page.eval(`return !!document.querySelector('.tabbar')`)) problems.push('[420px] the tab bar covers a chat, which has its own footer');
    await page.viewport(1440, 900);

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
    for (const path of ['/', '/chats', `/chats/${SESSION}`, `/orchestration/${orchestrationId}`, '/orchestration', '/accounts', '/connectors']) {
      await settle(page, path);
      const bare = await page.eval(`
        const bare = [];
        for (const badge of document.querySelectorAll('.badge-ok, .badge-warn, .badge-bad, .badge-idle')) {
          if (!badge.querySelector('svg, .spinner') || !badge.textContent.trim()) bare.push(badge.outerHTML.slice(0, 120));
        }
        for (const dot of document.querySelectorAll('main .status-dot')) {
          if (!dot.getAttribute('aria-label') && !(dot.parentElement?.textContent ?? '').trim()) bare.push(dot.outerHTML.slice(0, 120));
        }
        return bare;`);
      for (const html of bare) problems.push(`[${path}] a status is shown by colour alone (needs its words and an icon): ${html}`);
    }

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
    for (const href of ['/', '/chats', '/orchestration', '/projects', '/accounts', '/settings']) {
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
    for (const href of ['/', '/chats', '/orchestration', '/projects', '/accounts', '/settings']) {
      if (!navigation.includes(href)) problems.push(`[keyboard] ${href} is in the palette but not in the navigation`);
    }

    report(problems);
    check(problems.length === 0, `${problems.length} accessibility finding(s):\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); localStorage.removeItem('agentry:project'); return true`).catch(() => {});
    if (orchestrationId) await api.del(`/orchestrations/${orchestrationId}`).catch(() => {});
    for (const id of orchestrationChats) await api.del(`/chats/${id}`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(tasksRoot, { recursive: true, force: true });
  }
};
