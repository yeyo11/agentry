// Home is the selected project's dashboard: the top bar's selector decides what it is about, a deep link
// overrides the remembered choice, and with All projects it is the dashboard of every project. The
// project's settings, memory, resources and worktrees are full views; its Export widget and the Usage
// page offer the project's export as a download.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const tabsText = `return [...(document.querySelector('main [role=tablist]')?.querySelectorAll('[role=tab]') ?? [])].map((t) => t.textContent.trim()).join(',')`;
// The widgets drawn, in order: the page renders the layout it is given, so this is the layout
const widgetTypes = `return [...document.querySelectorAll('main .dashboard-grid > .widget-slot')].map((s) => s.dataset.widget).join(',')`;

export default async ({ page, api, check, dirs }) => {
  const dir = join(dirs.workspaceDir, 'e2e-home');
  mkdirSync(dir, { recursive: true });
  const imported = await api.post('/projects/import', { path: dir, name: 'e2e-home' });
  check(imported.status === 201, `the project was imported (${imported.status})`);
  const id = imported.body.id;

  try {
    // With no project selected the page is the dashboard of every project, and nothing else
    await page.goto('/?project=all', 1200);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'Home'`, { label: 'Home with All projects' });
    check((await page.eval(tabsText)) === '', 'All projects has no tabs: the dashboard is the page');
    await page.waitFor(`return document.querySelectorAll('main .dashboard-grid .widget').length >= 5`, { label: 'the All projects widgets' });
    check(
      (await page.eval(widgetTypes)) === 'now,orchestrations,limits,pickUp,today,schedules,projects',
      `All projects draws its default layout (${await page.eval(widgetTypes)})`,
    );
    check(await page.eval(`return [...document.querySelectorAll('main .widget h2')].some((h) => h.textContent === 'Now')`), 'every widget names itself with a heading');
    check((await page.text('main [data-widget=projects]')).includes('e2e-home'), 'the Projects widget lists the imported project');

    // A deep link selects the project and the selector says so
    await page.goto(`/?project=${encodeURIComponent(id)}`, 1200);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'e2e-home'`, { label: 'the project page' });
    check((await page.eval(`return document.querySelector('.project-selector')?.textContent ?? ''`)).includes('e2e-home'), 'the top bar selector shows the project');
    check((await page.eval(tabsText)) === '', 'the project page is a dashboard, not a tab strip');
    await page.waitFor(`return !!document.querySelector('main [data-widget=quickStart] textarea')`, { label: 'the quick start widget' });
    check(
      (await page.eval(widgetTypes)) === 'now,quickStart,limits,orchestrations,schedules,pickUp,today,memory,worktrees,resources,export',
      `the project draws its default layout (${await page.eval(widgetTypes)})`,
    );
    check((await page.text('main [data-widget=quickStart]')).includes('MCP: CLI default'), 'the quick start options are one status line, closed');

    // The project's own screens are full views, reached from the ⚙ and from their widgets
    await page.click('main a[aria-label="Settings of e2e-home"]', undefined, 800);
    await page.waitFor(`return location.search.includes('view=settings')`, { label: 'the ⚙ opens the settings view' });
    await page.waitFor(`return !!document.querySelector('main [role=tablist]')`, { label: 'the views of the project' });
    check((await page.eval(tabsText)) === 'Settings,Memory,Resources,Worktrees', `the full views are tabs of their own (${await page.eval(tabsText)})`);
    await page.click('main [role=tab]', 'Memory', 600);
    check((await page.eval('return location.search')).includes('view=memory'), 'the view is in the address');
    await page.click('main .page-header button', 'Dashboard', 800);
    await page.waitFor(`return !location.search.includes('view=') && !!document.querySelector('main .dashboard-grid')`, { label: 'back on the dashboard' });
    await page.click('main [data-widget=resources] a', 'Skills', 800);
    await page.waitFor(`return location.search.includes('view=resources') && location.search.includes('section=skills')`, { label: 'a widget opens its section of the full view' });

    // The address the page had before it was a dashboard still leads to the same screen
    await page.goto(`/?project=${encodeURIComponent(id)}&tab=worktrees`, 1200);
    await page.waitFor(`return location.search.includes('view=worktrees') && !location.search.includes('tab=')`, { label: '?tab=worktrees redirects to ?view=worktrees' });
    await page.goto(`/?tab=activity`, 1200);
    await page.waitFor(`return !location.search.includes('tab=') && !!document.querySelector('main .dashboard-grid')`, { label: '?tab=activity is the dashboard' });

    // The choice outlives the deep link
    await page.goto('/', 1200);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'e2e-home'`, { label: 'the project is still selected' });

    // Notifications and the rest of the shell do not depend on the selection
    check(await page.eval(`return !!document.querySelector('.bell')`), 'the bell is there whatever is selected');

    // The project's export: plain download links, streamed by the server with a file name
    await page.waitFor(`return !!document.querySelector('main .project-export a[data-format=markdown]')`, { label: 'the export widget on the dashboard' });
    check((await page.text('main .project-export')).includes('Export e2e-home'), 'the export names the project');
    const md = await page.eval(
      `const r = await fetch(document.querySelector('main .project-export a[data-format=markdown]').href); return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), body: await r.text() }`,
    );
    check(md.status === 200 && /attachment/.test(md.disposition ?? '') && /\.md"/.test(md.disposition ?? ''), `the Markdown export downloads as a .md file (${md.status}, ${md.disposition})`);
    check(/markdown/.test(md.type ?? '') && md.body.includes('e2e-home'), 'the Markdown export is about the project');
    const json = await page.eval(
      `const r = await fetch(document.querySelector('main .project-export a[data-format=json]').href); return { status: r.status, disposition: r.headers.get('content-disposition'), body: await r.json() }`,
    );
    check(json.status === 200 && /\.json"/.test(json.disposition ?? ''), `the JSON export downloads as a .json file (${json.status}, ${json.disposition})`);
    check(json.body.project?.id === id && Array.isArray(json.body.chats), 'the JSON export is a ProjectExport of this project');
    check(await page.eval(`return !!document.querySelector('main .project-export a[download][href*="/api/projects/"]')`), 'the export is a download link, not a button that fetches');

    // The Usage page offers the same file for the selected project, and says it ignores the range
    await page.goto('/usage', 1200);
    await page.waitFor(`return !!document.querySelector('main .project-export a[data-format=json]')`, { label: 'the export on the Usage page' });
    check(/whole project/.test(await page.text('main .project-export')), 'the Usage page says the export covers the whole project, not the range');
    await page.goto('/', 1200);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'e2e-home'`, { label: 'back on the project page' });

    // Back to everything through the selector
    await page.click('.project-selector', undefined, 400);
    await page.click('[role=option]', 'All projects', 800);
    await page.waitFor(`return document.querySelector('main h1')?.textContent === 'Home'`, { label: 'All projects again' });
  } finally {
    await page.eval(`localStorage.removeItem('agentry:project'); return true`);
    await api.del(`/projects/${id}`);
  }
};
