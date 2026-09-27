// Motion is a preference, and the whole point of it is that it is in force before anything has had
// a chance to move: the level is stamped on <html> at import time, the way the theme is. The
// control that changes it lives in Settings → Appearance; what is checked here is the mechanism
// under it, and that the stylesheet — not each component — is what stops the loops.
//
// The second half does it on a real live surface: a work item whose "Work on it" chat is running,
// on the board, the list, its own page and a phone's board. The fake CLI runs the `run:` line of
// the item's description, which is what keeps the chat working while the pages are read.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 180_000;

/** Every loop under `root` that is still running: an element or its ::before/::after, shown, repeating. */
const loops = (root = 'body') => `
  const found = [];
  for (const el of document.querySelectorAll('${root} *')) {
    if (el.getClientRects().length === 0) continue;
    for (const pseudo of [null, '::before', '::after']) {
      const s = getComputedStyle(el, pseudo);
      if (s.animationName === 'none') continue;
      const repeats = s.animationIterationCount.split(',').some((c) => c.trim() === 'infinite');
      const running = s.animationPlayState.split(',').some((p) => p.trim() === 'running');
      if (repeats && running) found.push(((el.className && el.className.toString()) || el.tagName).slice(0, 60) + (pseudo ?? ''));
    }
  }
  return found;`;

export default async ({ page, api, check, dirs }) => {
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'full', 'everything moves by default');
  check((await page.eval(`return document.documentElement.dataset.hidden`)) === 'false', 'a tab being looked at is marked as such');

  // What is stored is in force from the first paint, not after a flash of movement
  await page.eval(`localStorage.setItem('agentry-motion', 'subtle');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'subtle', 'the stored level is in force');

  // At `subtle` nothing repeats, and it holds for anything the page adds later
  const looping = await page.eval(`
    const el = document.createElement('div');
    el.className = 'live-rail';
    document.body.append(el);
    const before = getComputedStyle(el, '::before');
    const value = { name: before.animationName, count: before.animationIterationCount };
    el.remove();
    return value;
  `);
  check(looping.name === 'none' || looping.count === '1', `a live rail does not loop at subtle (${looping.name}, ${looping.count})`);

  await page.eval(`localStorage.setItem('agentry-motion', 'off');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'off', 'nothing moves at off');

  // A value nobody wrote is not obeyed
  await page.eval(`localStorage.setItem('agentry-motion', 'sparkly');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'full', 'a stored level that is not one falls back to full');

  // ---- the ecosystem's live surfaces: a card, a row and a work item whose chat is running ----
  let projectId = null;
  let chatId = null;
  try {
    const dir = join(dirs.workspaceDir, 'e2e-motion');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-motion', template: 'software' });
    check(imported.status === 201, `a project with its board (${imported.status})`);
    projectId = imported.body.id;
    const made = await api.post(`/projects/${projectId}/work-items`, { title: 'Keep a chat working', description: 'run: sleep 120' });
    check(made.status === 201, `the item was created (${made.status})`);
    const item = made.body;
    const work = await api.post(`/work-items/${item.id}/work`, {});
    check(work.status === 201 || work.status === 200, `Work on it started a chat (${work.status} ${JSON.stringify(work.body)})`);
    chatId = work.body.chat.id;

    const board = `/tasks?project=${projectId}`;
    const pages = [board, `${board}&view=list`, `/tasks/${item.key}?project=${projectId}`];
    const open = async (path) => {
      await page.goto(path, 1200);
      await page.waitFor(`return !!document.querySelector('main .live-rail')`, { label: `${path} shows the item as live` });
      await page.sleep(300);
    };

    // Full: the live things are what moves
    await page.eval(`localStorage.setItem('agentry-motion', 'full');`);
    for (const path of pages) {
      await open(path);
      const moving = await page.eval(loops('main'));
      check(moving.length > 0, `${path}: a running chat's item moves at full`);
      // Nobody is looking: a hidden tab pauses every one of them
      await page.eval(`document.documentElement.dataset.hidden = 'true';`);
      const hidden = await page.eval(loops());
      check(hidden.length === 0, `${path}: a hidden tab runs no loop (${hidden.join(', ')})`);
    }

    for (const level of ['subtle', 'off']) {
      await page.eval(`localStorage.setItem('agentry-motion', '${level}');`);
      for (const path of pages) {
        await open(path);
        const still = await page.eval(loops());
        check(still.length === 0, `${path}: nothing repeats at ${level} (${still.join(', ')})`);
      }
    }

    // The system setting stops them too, with the stored level back at full
    await page.eval(`localStorage.setItem('agentry-motion', 'full');`);
    await page.reduceMotion();
    for (const path of pages) {
      await open(path);
      const still = await page.eval(loops());
      check(still.length === 0, `${path}: nothing repeats under prefers-reduced-motion (${still.join(', ')})`);
    }
    await page.reduceMotion(false);

    // A phone's board is a list, and its live row stops the same way
    await page.viewport(390, 844);
    await page.eval(`localStorage.setItem('agentry-motion', 'subtle');`);
    await open(board);
    const phone = await page.eval(loops());
    check(phone.length === 0, `the phone's board: nothing repeats at subtle (${phone.join(', ')})`);
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-motion');`).catch(() => {});
    if (chatId) {
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await page.sleep(250);
      }
    }
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
