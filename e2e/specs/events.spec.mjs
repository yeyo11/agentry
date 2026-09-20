// The UI follows the server through one event stream instead of polling: a run created behind the
// page's back shows up without a reload, well inside the 30 s the fallback poll would take.

export default async ({ page, api, check }) => {
  // The feed itself: an event stream that opens with its hello, and is dropped once we are done
  const controller = new AbortController();
  const res = await fetch(`${api.baseUrl}/api/events`, { signal: controller.signal });
  check(res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('text/event-stream'), `GET /api/events is an event stream (${res.status})`);
  const first = new TextDecoder().decode((await res.body.getReader().read()).value);
  check(first.includes('event: stream.hello'), 'the feed opens with stream.hello');
  controller.abort();

  await page.goto('/', 1000);
  await page.waitFor(`return document.querySelector('main')?.innerText.trim().length > 10`, { label: 'home page' });
  const footer = await page.eval(`return document.querySelector('.sidebar-foot')?.innerText ?? ''`);
  check(!/paused/i.test(footer), `the sidebar footer says live updates are paused: ${footer}`);

  // The sandbox has no login, so the chat goes nowhere; its creation is what has to reach the open
  // page by itself, as working now or as one to pick up again.
  const created = await api.post('/chats', { prompt: 'e2e-live-feed hello' });
  check(created.status === 201, `the chat was created (${created.status})`);
  const appeared = await page.waitFor(`return document.querySelector('main').innerText.includes('e2e-live-feed')`, {
    label: 'the new chat to appear without a reload',
  });
  check(appeared, 'the chat appears on the open Home page');

  // Housekeeping so the next spec starts from the same state
  await api.post(`/chats/${created.body.id}/stop`);
  for (let i = 0; i < 40; i++) {
    if ((await api.del(`/chats/${created.body.id}`)).status === 200) break;
    await new Promise((r) => setTimeout(r, 250));
  }
};
