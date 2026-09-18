// Config: file explorer round trip (create, type, Ctrl+S, delete with confirmation) and guided settings.
export default async ({ page, api, check }) => {
  await page.goto('/config?tab=files', 1500);
  await page.click('button', 'New file');
  await page.fill('input[placeholder="hooks/my-hook.sh"]', 'hooks/e2e.sh');
  await page.click('[role=dialog] button', 'Create in editor', 1200);
  await page.waitFor(`return !!document.querySelector('.cm-content')`, { label: 'code editor' });
  await page.focus('.cm-content');
  await page.type('#!/bin/bash\necho e2e\n');
  await page.click('button', 'Create file', 1200);
  let file = await api.get('/config/files/content?root=user&path=hooks/e2e.sh');
  check(file.status === 200 && file.body.content.includes('echo e2e'), 'file created from the editor');

  await page.focus('.cm-content');
  await page.type('# edited ');
  check(await page.eval(`return !!document.querySelector('.tab-dirty')`), 'dirty marker shown on the tab');
  await page.key('s', 2);
  await page.waitFor(`return !document.querySelector('.tab-dirty')`, { label: 'saved with Ctrl+S' });
  file = await api.get('/config/files/content?root=user&path=hooks/e2e.sh');
  check(file.body.content.includes('# edited'), 'Ctrl+S persisted the edit');

  await page.click('button', 'Delete');
  await page.waitFor(`return !!document.querySelector('[role=dialog],[role=alertdialog]')`, { label: 'confirm dialog' });
  await page.eval(`const d=document.querySelector('[role=dialog],[role=alertdialog]');[...d.querySelectorAll('button')].find(b=>/delete/i.test(b.textContent)).click();return true`);
  await page.sleep(1000);
  check((await api.get('/config/files/content?root=user&path=hooks/e2e.sh')).status === 404, 'file deleted after confirmation');

  // Guided settings write the same JSON the raw editor shows
  await page.goto('/config?tab=settings', 1500);
  await page.fill('[role=tabpanel] input[placeholder="default"]', 'sonnet');
  await page.click('button', 'Save settings', 1200);
  check((await api.get('/config/settings')).body.settings.model === 'sonnet', 'guided settings saved the model');
  await page.click('button', 'Raw JSON', 800);
  check((await page.text('.cm-content')).includes('sonnet'), 'raw JSON reflects the guided edit');

  // Project scope: inherited user servers are listed next to the project ones
  const project = (await api.post('/projects', { name: 'e2e-project' })).body;
  await api.put(`/config/instructions?project=${encodeURIComponent(project.id)}`, { content: '# E2E project rules\n' });
  await page.goto(`/config?project=${encodeURIComponent(project.id)}&tab=instructions`, 1800);
  check((await page.text('[role=tabpanel]')).includes('E2E project rules'), 'project-scope instructions shown');
  check(!(await page.text('[role=tablist]')).includes('Account'), 'Account tab is user-scope only');
};
