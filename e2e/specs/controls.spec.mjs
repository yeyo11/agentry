// Themed controls from the keyboard: a Select inside a dialog owns Escape, the Combobox and the
// scope picker are driven with arrows and Enter, and the number stepper clamps to its range.
const openListbox = `return !!document.querySelector('[role=listbox]')`;

export default async ({ page, api, check }) => {
  // Escape closes the open menu first, and only then the dialog around it
  await page.goto('/config?tab=files', 1500);
  await page.click('button', 'New file', 800);
  await page.click('[role=dialog] .select-trigger', undefined, 500);
  await page.waitFor(openListbox, { label: 'template menu open inside the dialog' });
  await page.key('Escape');
  await page.sleep(300);
  check(!(await page.eval(openListbox)), 'Escape closes the select menu');
  check(await page.eval(`return !!document.querySelector('[role=dialog]')`), 'the dialog stays open behind it');
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'second Escape closes the dialog' });

  // Combobox: arrows walk the suggestions, Enter picks, typing filters, Escape closes
  await page.goto('/runs/new', 1200);
  await page.focus('input[aria-label="Model"]');
  await page.key('ArrowDown');
  await page.waitFor(openListbox, { label: 'model suggestions open' });
  await page.key('ArrowDown');
  await page.key('ArrowDown');
  await page.key('Enter');
  check((await page.eval(`return document.querySelector('input[aria-label="Model"]').value`)) === 'opus', 'arrows + Enter pick the second suggestion');
  check(!(await page.eval(openListbox)), 'picking closes the list');
  await page.eval(`const i=document.querySelector('input[aria-label="Model"]');i.select();return true`);
  await page.type('son');
  await page.sleep(200);
  const options = await page.eval(`return [...document.querySelectorAll('[role=listbox] [role=option]')].map(o=>o.textContent).join(',')`);
  check(options === 'sonnet', `typing filters the suggestions (got ${options})`);
  await page.key('Escape');
  await page.sleep(200);
  check(!(await page.eval(openListbox)), 'Escape closes the suggestions');
  check((await page.eval(`return document.querySelector('input[aria-label="Model"]').value`)) === 'son', 'free text is kept');

  // Scope picker: search, Enter selects the first match, Escape closes
  const project = (await api.post('/projects', { name: 'scope-target' })).body;
  await page.goto('/config', 1500);
  await page.click('.scope-picker-button', undefined, 400);
  await page.waitFor(`return document.activeElement?.getAttribute('aria-label') === 'Search projects'`, { label: 'search focused on open' });
  // The sandbox workspace lives under the OS temp dir, so its projects count as temporary
  await page.click('.popover [role=checkbox]', undefined, 300);
  await page.focus('input[aria-label="Search projects"]');
  await page.type('scope-target');
  await page.sleep(200);
  await page.key('Enter');
  await page.waitFor(`return new URLSearchParams(location.search).get('project') === ${JSON.stringify(project.id)}`, { label: 'Enter picked the project' });
  check(!(await page.eval(openListbox)), 'picking closes the picker');
  await page.click('.scope-picker-button', undefined, 400);
  await page.key('ArrowDown', 0);
  await page.key('ArrowUp', 0);
  await page.key('Enter');
  await page.waitFor(`return !new URLSearchParams(location.search).get('project')`, { label: 'arrows back to the user scope' });

  // Number stepper clamps to its max
  await page.goto('/orchestration', 1200);
  await page.click('button', 'New orchestration', 600);
  const maxTasks = `return [...document.querySelectorAll('.field')].find(f=>f.textContent.startsWith('Max tasks')).querySelector('input').value`;
  const before = Number(await page.eval(maxTasks));
  await page.eval(`[...document.querySelectorAll('.field')].find(f=>f.textContent.startsWith('Max tasks')).querySelector('[aria-label=Increase]').click();return true`);
  await page.sleep(150);
  check(Number(await page.eval(maxTasks)) === Math.min(before + 1, 12), 'the + stepper increments');
  for (let i = 0; i < 15; i++) await page.eval(`[...document.querySelectorAll('.field')].find(f=>f.textContent.startsWith('Max tasks')).querySelector('[aria-label=Increase]').click();return true`);
  await page.sleep(150);
  check(Number(await page.eval(maxTasks)) === 12, 'the stepper stops at the maximum');
};
