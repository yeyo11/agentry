// Notification center: the bell shows what is unread, the panel lists it, a click goes to the
// link, and the state and preferences persist per browser. The list is seeded into localStorage
// because the sandbox has no login, so no run can reach a state that needs the person.

const KEY = 'agentry-notifications:v1';
const item = (id, patch) => ({
  id,
  key: id,
  at: new Date().toISOString(),
  kind: 'run',
  priority: 'normal',
  tone: 'ok',
  title: `title ${id}`,
  body: '',
  href: '/chats',
  runId: null,
  orchestrationId: null,
  read: false,
  resolved: false,
  ...patch,
});
const seed = (items) =>
  `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify({ version: 1, items, prefs: { level: 'all', browser: false, kinds: {} } }))}); return true`;

export default async ({ page, check }) => {
  await page.goto('/', 1000);
  await page.waitFor(`return !!document.querySelector('.bell')`, { label: 'the bell' });
  const label = await page.eval(`return document.querySelector('.bell').getAttribute('aria-label')`);
  check(label === 'Notifications', `the bell has no count when nothing is unread (its label is "${label}", the store holds ${await page.eval(`return localStorage.getItem(${JSON.stringify(KEY)})`)})`);
  check(!(await page.eval(`return !!document.querySelector('.bell-badge')`)), 'no badge without unread notifications');

  // A stored `waiting` notification is settled on load when no chat is holding that prompt any more,
  // and the sandbox has no live process to hold one. This one is dated after the load, which is the
  // case the reconciliation leaves alone: a question that arrived while the page was still coming up.
  const waiting = item('a', {
    kind: 'waiting',
    priority: 'high',
    tone: 'warn',
    at: new Date(Date.now() + 60_000).toISOString(),
    title: 'fix the build needs your approval to use Bash',
  });
  await page.eval(seed([waiting, item('b', { read: true })]));
  await page.goto('/', 1000);
  await page.waitFor(`return document.querySelector('.bell-badge')?.textContent === '1'`, { label: 'one unread in the badge' });
  check(await page.eval(`return document.querySelector('.bell').classList.contains('bell-urgent')`), 'a waiting question makes the bell urgent');
  check((await page.eval(`return document.querySelector('.bell').getAttribute('aria-label')`)) === 'Notifications, 1 unread, some need you', 'the unread count, and that some of it is urgent, is in the accessible name');

  await page.click('.bell');
  await page.waitFor(`return !!document.querySelector('.notif-panel')`, { label: 'the panel opens' });
  check(await page.eval(`return document.querySelector('.bell').getAttribute('aria-expanded') === 'true'`), 'the bell says it is expanded');
  check((await page.eval(`return document.querySelectorAll('.notif-item').length`)) === 2, 'both notifications are listed');
  check(await page.eval(`return document.querySelector('.notif-item').classList.contains('notif-high')`), 'the waiting one is first and styled as high priority');

  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('.notif-panel')`, { label: 'Escape closes the panel' });
  check(await page.eval(`return document.querySelector('.bell').getAttribute('aria-expanded') === 'false'`), 'the bell says it is collapsed again');

  await page.click('.bell');
  await page.waitFor(`return !!document.querySelector('.notif-panel')`, { label: 'the panel reopens' });
  await page.click('.notif-panel .btn', 'Mark all read');
  await page.waitFor(`return !document.querySelector('.bell-badge')`, { label: 'the badge clears after mark all read' });
  const stored = await page.eval(`return JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})).items.every((n) => n.read)`);
  check(stored, 'read state is persisted');

  // Preferences use the themed controls and are persisted too
  await page.click('.notif-prefs .collapsible-trigger');
  await page.select('.notif-prefs .select-trigger', 'Silent');
  await page.waitFor(`return JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})).prefs.level === 'silent'`, { label: 'the interruption level is saved' });

  await page.click('.notif-panel .btn', 'Clear');
  await page.waitFor(`return !document.querySelector('.notif-item') && !!document.querySelector('.notif-empty')`, { label: 'clear empties the list' });

  // Clicking a notification marks it read, closes the panel and goes to its link
  await page.eval(seed([item('c', { href: '/projects' })]));
  await page.goto('/', 1000);
  await page.click('.bell');
  await page.click('.notif-item');
  await page.waitFor(`return location.pathname === '/projects'`, { label: 'the notification navigates to its link' });
  check(!(await page.eval(`return !!document.querySelector('.notif-panel')`)), 'the panel closes on navigation');
  check(await page.eval(`return JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})).items[0].read`), 'the clicked notification is read');

  // A tool permission is answered from the list; a question keeps only its link. The sandbox has no
  // live process holding a prompt, so the answer route is stubbed in the page and the spec checks
  // what the panel sends and what it does with the reply.
  const later = new Date(Date.now() + 60_000).toISOString();
  const bash = item('perm', { kind: 'waiting', priority: 'high', tone: 'warn', at: later, runId: 'chat-e2e', permissionId: 'req-1', title: 'e2e chat needs your approval to use Bash', href: '/chats/chat-e2e?prompt=req-1' });
  const question = item('ask', { kind: 'waiting', priority: 'high', tone: 'warn', at: later, runId: 'chat-e2e', permissionId: null, title: 'e2e chat is asking you a question', href: '/chats/chat-e2e?prompt=req-2' });
  await page.eval(seed([bash, question]));
  await page.goto('/', 1000);
  await page.eval(`
    window.__answers = [];
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method === 'POST' && /\\/permissions\\/[^/?]+$/.test(url)) {
        window.__answers.push({ url, body: JSON.parse(init.body) });
        return Promise.resolve(new Response(JSON.stringify({ id: 'req-1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return real(input, init);
    };
    return true`);
  await page.click('.bell');
  await page.waitFor(`return document.querySelectorAll('.notif-item').length === 2`, { label: 'the two waiting notifications' });
  const rowsWithActions = await page.eval(`return [...document.querySelectorAll('.notif-list > li')].map(li => [li.querySelector('.notif-title').textContent, !!li.querySelector('.notif-actions')])`);
  check(rowsWithActions.find(([title]) => title.includes('approval'))?.[1] === true, 'a tool permission has Allow and Deny in the list');
  check(rowsWithActions.find(([title]) => title.includes('question'))?.[1] === false, 'a question has no Allow or Deny: it keeps the link that opens it');
  const describedBy = await page.eval(`const b=[...document.querySelectorAll('.notif-actions button')].find(b=>b.textContent.trim()==='Allow');const id=b?.getAttribute('aria-describedby');return id?document.getElementById(id)?.textContent:null`);
  check(describedBy === bash.title, `Allow is tied to the notification it answers for a screen reader (got ${describedBy})`);

  await page.click('.notif-actions button', 'Allow', 600);
  await page.waitFor(`return document.querySelectorAll('.notif-item').length === 1`, { label: 'the answered permission leaves the list' });
  const answers = await page.eval(`return window.__answers`);
  check(answers.length === 1 && answers[0].url.endsWith('/api/chats/chat-e2e/permissions/req-1') && answers[0].body.behavior === 'allow', `Allow posts the decision for that request (got ${JSON.stringify(answers)})`);
  check(await page.eval(`return location.pathname === '/'`), 'answering does not open the chat');
  check(!(await page.eval(`return JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})).items.some(n => n.id === 'perm')`)), 'the answered permission is gone from storage too');
  check((await page.text('.notif-panel')).includes(question.title), 'the question is still there to be opened');
  await page.key('Escape');

  // A corrupt entry must not take the app down
  await page.eval(`localStorage.setItem(${JSON.stringify(KEY)}, '{not json'); return true`);
  await page.goto('/', 1000);
  await page.waitFor(`return !!document.querySelector('.bell') && !document.querySelector('.bell-badge')`, { label: 'the app starts with corrupt notification storage' });

  await page.eval(`localStorage.removeItem(${JSON.stringify(KEY)}); return true`);
};
