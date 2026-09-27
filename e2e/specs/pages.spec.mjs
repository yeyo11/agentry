import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Every page renders in both themes and at phone width without console errors.
const PAGES = [
  '/',
  '/chats',
  '/chats/new',
  '/projects',
  '/projects/new',
  '/tasks',
  '/tasks?view=list',
  '/tasks/milestones',
  '/orchestration',
  '/accounts',
  '/connectors',
  '/settings',
  '/settings?tab=settings',
  '/settings?tab=mcp',
  '/settings?tab=files',
  '/settings?tab=memory',
  '/settings?tab=plugins',
];
// The project page is a dashboard, with a full view for each of its own things. Board and Memory
// exist only while their modules are on, so the project is imported with every module on
const PROJECT_TABS = ['', '?view=board', '?view=settings', '?view=memory', '?view=resources', '?view=worktrees'];

export default async ({ page, api, check, dirs }) => {
  // A project to open: pages under it need one imported
  const dir = join(dirs.workspaceDir, 'e2e-pages');
  mkdirSync(dir, { recursive: true });
  const imported = await api.post('/projects/import', { path: dir, name: 'e2e-pages', template: 'software' });
  check(imported.status === 201, `the project was imported (${imported.status})`);
  const projectPages = PROJECT_TABS.map((tab) => `/${tab || '?'}${tab ? '&' : ''}project=${imported.body.id}`);

  for (const theme of ['dark', 'light']) {
    await page.goto('/');
    await page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(theme)}); return true`);
    for (const path of [...PAGES, ...projectPages]) {
      await page.goto(path, 900);
      const main = await page.waitFor(`return document.querySelector('main')?.innerText.trim().length > 20`, { label: `${path} content` });
      check(main, `${path} rendered (${theme})`);
      // A tab its modules hide would land on the dashboard and pass for rendered
      const view = new URLSearchParams(path.split('?')[1] ?? '').get('view');
      if (view) check(await page.eval(`return new URLSearchParams(location.search).get('view') === ${JSON.stringify(view)}`), `${path} stayed on its tab`);
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
  for (const path of ['/', '/settings?tab=settings', '/settings?tab=plugins', projectPages[0]]) {
    await page.goto(path, 900);
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 2, `${path} overflows horizontally by ${overflow}px at 420px`);
  }
  await page.viewport(1440, 900);
  await page.eval(`localStorage.removeItem('agentry-theme'); localStorage.removeItem('agentry:project'); return true`);
  await api.del(`/projects/${imported.body.id}`);
};
