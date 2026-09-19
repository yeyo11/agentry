// The UI follows the server through one event stream instead of polling: a run created behind the
// page's back shows up without a reload, well inside the 30 s the fallback poll would take.

export default async ({ page, api, check }) => {
  await page.goto('/agents', 1000);
  await page.waitFor(`return document.querySelector('main')?.innerText.trim().length > 10`, { label: 'agents page' });
  const footer = await page.eval(`return document.querySelector('.sidebar-foot')?.innerText ?? ''`);
  check(!/paused/i.test(footer), `the sidebar footer says live updates are paused: ${footer}`);

  // The sandbox has no login, so the run goes nowhere; its creation is what has to reach the open
  // page by itself. `internal` keeps the CLI from writing a transcript, which the sessions spec
  // would then count.
  const created = await api.post('/runs', { prompt: 'hello', name: 'e2e-live-feed', internal: true });
  check(created.status === 201, `the run was created (${created.status})`);
  const appeared = await page.waitFor(`return document.querySelector('main').innerText.includes('e2e-live-feed')`, {
    label: 'the new run to appear without a reload',
  });
  check(appeared, 'the run appears on the open Agents page');

  // Housekeeping so the next spec starts from the same state
  await api.post(`/runs/${created.body.id}/stop`);
  for (let i = 0; i < 40; i++) {
    if ((await api.del(`/runs/${created.body.id}`)).status === 200) break;
    await new Promise((r) => setTimeout(r, 250));
  }
};
