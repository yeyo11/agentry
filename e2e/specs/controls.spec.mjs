// Themed controls from the keyboard: a Select inside a dialog owns Escape, the Combobox is driven
// with arrows and Enter, and the number stepper clamps to its range.
const openListbox = `return !!document.querySelector('[role=listbox]')`;

export default async ({ page, api, check }) => {
  // Escape closes the open menu first, and only then the dialog around it
  await page.goto('/settings?tab=files', 1500);
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
  await page.goto('/chats/new', 1200);
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
