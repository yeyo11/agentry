// Home is the selected project's page: the top bar's selector decides what it is about, a deep link
// overrides the remembered choice, and with All projects only Activity is left.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const tabsText = `return [...(document.querySelector('main [role=tablist]')?.querySelectorAll('[role=tab]') ?? [])].map((t) => t.textContent.trim()).join(',')`;

export default async ({ page, api, check, dirs }) => {
  const dir = join(dirs.workspaceDir, 'e2e-home');
  mkdirSync(dir, { recursive: true });
  const imported = await api.post('/projects/import', { path: dir, name: 'e2e-home' });
  check(imported.status === 201, `the project was imported (${imported.status})`);
  const id = imported.body.id;

  try {
    // With no project selected the page is only the inbox
    await page.goto('/?project=all', 1200);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'Home'`, { label: 'Home with All projects' });
    check((await page.eval(tabsText)) === '', 'All projects has no tabs but Activity, which is the page itself');

    // A deep link selects the project and the selector says so
    await page.goto(`/?project=${encodeURIComponent(id)}`, 1200);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'e2e-home'`, { label: 'the project page' });
    check((await page.eval(`return document.querySelector('.project-selector')?.textContent ?? ''`)).includes('e2e-home'), 'the top bar selector shows the project');
    check((await page.eval(tabsText)) === 'Activity,Settings,Memory,Resources,Worktrees', 'the project page has its tabs');

    // Tabs live in the address, and the choice outlives the deep link
    await page.click('main [role=tab]', 'Memory', 600);
    check((await page.eval('return location.search')).includes('tab=memory'), 'the tab is in the address');
    await page.goto('/', 1200);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'e2e-home'`, { label: 'the project is still selected' });

    // Notifications and the rest of the shell do not depend on the selection
    check(await page.eval(`return !!document.querySelector('.bell')`), 'the bell is there whatever is selected');

    // Back to everything through the selector
    await page.click('.project-selector', undefined, 400);
    await page.click('[role=option]', 'All projects', 800);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'Home'`, { label: 'All projects again' });
  } finally {
    await page.eval(`localStorage.removeItem('agentry:project'); return true`);
    await api.del(`/projects/${id}`);
  }
};
