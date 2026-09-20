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
  `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify({ version: 1, items, prefs: { toasts: true, browser: false, kinds: {} } }))}); return true`;

export default async ({ page, check }) => {
  await page.goto('/', 1000);
  await page.waitFor(`return !!document.querySelector('.bell')`, { label: 'the bell' });
  check((await page.eval(`return document.querySelector('.bell').getAttribute('aria-label')`)) === 'Notifications', 'the bell has no count when nothing is unread');
  check(!(await page.eval(`return !!document.querySelector('.bell-badge')`)), 'no badge without unread notifications');

  await page.eval(seed([item('a', { kind: 'waiting', priority: 'high', tone: 'warn', title: 'fix the build needs your approval to use Bash' }), item('b', { read: true })]));
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

  // Preferences use the themed switch and are persisted too
  await page.click('.notif-prefs .collapsible-trigger');
  await page.click('.notif-prefs [role=switch]');
  await page.waitFor(`return JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})).prefs.toasts === false`, { label: 'the toasts preference is saved' });

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

  // A corrupt entry must not take the app down
  await page.eval(`localStorage.setItem(${JSON.stringify(KEY)}, '{not json'); return true`);
  await page.goto('/', 1000);
  await page.waitFor(`return !!document.querySelector('.bell') && !document.querySelector('.bell-badge')`, { label: 'the app starts with corrupt notification storage' });

  await page.eval(`localStorage.removeItem(${JSON.stringify(KEY)}); return true`);
};
