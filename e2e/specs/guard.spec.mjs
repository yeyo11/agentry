// Unsaved changes block sidebar navigation until the user decides.
export default async ({ page, api, check }) => {
  await api.put('/config/files/content', { root: 'user', path: 'notes/guard.md', content: 'x\n' });
  await page.goto('/settings?tab=files', 1500);
  await page.click('[role=treeitem]', 'notes').catch(() => {});
  await page.click('[role=treeitem]', 'guard.md', 1200);
  await page.focus('.cm-content');
  await page.type('unsaved ');

  await page.click('a[href="/"]');
  await page.waitFor(`return !!document.querySelector('[role=dialog],[role=alertdialog]')`, { label: 'discard dialog' });
  await page.click('[role=dialog] button, [role=alertdialog] button', 'Keep editing');
  check((await page.eval('return location.pathname')) === '/settings', '"Keep editing" stays on the page');

  await page.click('a[href="/"]');
  await page.click('[role=dialog] button, [role=alertdialog] button', 'Discard changes', 900);
  check((await page.eval('return location.pathname')) === '/', '"Discard changes" navigates away');

  await page.goto('/settings?tab=instructions', 1200);
  await page.click('a[href="/projects"]', null, 900);
  check((await page.eval('return location.pathname')) === '/projects', 'clean navigation is not blocked');
  await api.del('/config/files/content?root=user&path=notes');
};
