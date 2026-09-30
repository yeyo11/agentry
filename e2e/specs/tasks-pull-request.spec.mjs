// A work item's pull request on the board and on its page (CW-22): every PR state the watcher can
// leave a card in, worded with its colour and its word, the CI badge still (no loop, no --live),
// the link to GitHub, and axe over both screens in both themes and at phone width. With E2E_SHOTS
// set it also saves the screens, for comparing them with DesktopTableroEquipo, MobileTablero,
// DesktopTarea and MobileTarea.
//
// The rows are written straight into the database, as the watcher would leave them: nothing here
// reaches git, gh or GitHub. The project is no git repository, so its approval keeps "Move to Done"
// and says why no PR is offered.

import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const card = (id) => `[data-item-id="${id}"] .workitem-strip`;

export default async ({ page, api, check, dirs }) => {
  const dir = join(dirs.workspaceDir, 'e2e-pull-requests');
  mkdirSync(dir, { recursive: true });
  const imported = await api.post('/projects/import', { path: dir, name: 'e2e-pull-requests', template: 'software' });
  check(imported.status === 201, `a project was imported (${imported.status})`);
  const project = imported.body;
  try {
    const add = async (title, status = 'in_review') => {
      const made = await api.post(`/projects/${project.id}/work-items`, { title, acceptanceCriteria: [{ text: 'It works' }] });
      await api.post(`/work-items/${made.body.id}/move`, { status });
      return made.body;
    };
    const passing = await add('PR with green checks');
    const pending = await add('PR with checks running');
    const failing = await add('PR with red checks');
    const conflict = await add('PR that conflicted', 'in_progress');
    const closed = await add('PR closed unmerged');
    const failed = await add('PR that failed to open');
    const approval = await add('Passed by QA');

    const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    db.exec('PRAGMA busy_timeout = 15000');
    const now = new Date().toISOString();
    const row = (item, fields) => {
      const r = { phase: 'open', number: null, url: null, ci: null, conflicts: '[]', error_code: null, error_detail: null, opened_at: null, closed_at: null, checked_at: null, ...fields };
      db.prepare(
        `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, url, branch, base, ci, conflicts, error_code, error_detail, approved_at, opened_at, closed_at, checked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), item.id, project.id, r.phase, r.number, r.url, `task/${item.key.toLowerCase()}`, r.ci, r.conflicts, r.error_code, r.error_detail, now, r.opened_at, r.closed_at, r.checked_at, now, now);
    };
    const open = (item, number, ci) => {
      row(item, { number, url: `https://github.com/acme/shop/pull/${number}`, ci, opened_at: now, checked_at: now });
      db.prepare("UPDATE work_items SET waiting = 'merge' WHERE id = ?").run(item.id);
    };
    open(passing, 101, 'passing');
    open(pending, 102, 'pending');
    open(failing, 103, 'failing');
    row(conflict, { phase: 'conflict', conflicts: JSON.stringify(['src/cart.ts', 'docs/cart.md']) });
    row(closed, { phase: 'closed', number: 104, url: 'https://github.com/acme/shop/pull/104', closed_at: now });
    row(failed, { phase: 'failed', error_code: 'push', error_detail: 'remote: Permission to acme/shop.git denied' });
    for (const item of [closed, failed, approval]) db.prepare("UPDATE work_items SET waiting = 'approval' WHERE id = ?").run(item.id);
    db.close();

    // ---- the board, desktop, both themes ----
    // Storage belongs to the app's origin: a blank page before the first visit has none
    await page.goto(`/tasks?project=${project.id}`, 1500);
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
      await page.goto(`/tasks?project=${project.id}`, 1500);
      await page.waitFor(`return !!document.querySelector('${card(passing.id)}')`, { label: `[${theme}] the open PR's strip` });
      const strip = (item) => page.eval(`const s = document.querySelector('${card(item.id)}'); return s ? { text: s.textContent, cls: s.className, ci: s.querySelector('.pr-ci')?.dataset.ci ?? null, ciCls: s.querySelector('.pr-ci')?.className ?? '', link: s.querySelector('a[href^="https://github.com"]')?.getAttribute('href') ?? null, target: s.querySelector('a[href^="https://github.com"]')?.getAttribute('target') ?? null, num: s.querySelector('.workitem-strip-num') ? getComputedStyle(s.querySelector('.workitem-strip-num')).fontVariantNumeric : null } : null`);

      const green = await strip(passing);
      check(green?.text.includes('#101') && green.ci === 'passing' && green.ciCls.includes('badge-ok'), `[${theme}] an open PR says its number and a passing CI in ok (${JSON.stringify(green)})`);
      check(green?.link === 'https://github.com/acme/shop/pull/101' && green.target === '_blank', `[${theme}] the strip links to the PR in a new tab (${green?.link})`);
      check(green?.num?.includes('tabular-nums'), `[${theme}] the PR number has tabular figures (${green?.num})`);
      const running = await strip(pending);
      check(running?.ci === 'pending' && !/badge-(ok|bad|warn|live)/.test(running.ciCls) && !running.cls.includes('is-live'), `[${theme}] pending CI is neutral and not live (${running?.ciCls} / ${running?.cls})`);
      const moving = await page.eval(`const b = document.querySelector('${card(pending.id)} .pr-ci'); const s = getComputedStyle(b); return s.animationName + '|' + (document.querySelector('${card(pending.id)} .spinner, ${card(pending.id)} [class*="spin"]') ? 'spinner' : '')`);
      check(moving === 'none|', `[${theme}] pending CI does not move (${moving})`);
      const red = await strip(failing);
      check(red?.ci === 'failing' && red.ciCls.includes('badge-bad') && red.text.trim().length > 8, `[${theme}] failing CI is bad, with a word (${red?.text})`);
      const clash = await strip(conflict);
      check(clash?.cls.includes('is-warn') || !!(await page.eval(`return !!document.querySelector('${card(conflict.id)} .workitem-strip-warn-mark')`)), `[${theme}] a conflict is warn (${clash?.cls})`);
      check(clash?.text.includes('main') && clash.text.includes('2'), `[${theme}] a conflict names the base and the files (${clash?.text})`);
      check((await strip(closed))?.text.includes('#104'), `[${theme}] a closed PR names its number`);
      const broke = await strip(failed);
      check(broke?.cls.includes('is-fail') && !!(await page.eval(`return !!document.querySelector('${card(failed.id)} .workitem-approve')`)), `[${theme}] a PR that failed to open is bad and offers the approval again (${broke?.cls})`);
      const approve = await page.eval(`const s = document.querySelector('${card(approval.id)}'); return { note: s?.querySelector('.pr-not-ready')?.textContent ?? '', button: s?.querySelector('.workitem-approve')?.textContent ?? '' }`);
      check(approve.note.length > 0 && !approve.button.includes('PR'), `[${theme}] a project that cannot open PRs says why and keeps "Move to Done" (${JSON.stringify(approve)})`);

      const board = await page.axe();
      check(board.length === 0, `[${theme}] axe finds nothing on the board with PR states: ${JSON.stringify(board)}`);
      await page.shot(`cw22-board-${theme}`);

      // ---- the item page ----
      await page.goto(`/tasks/${passing.key}`, 1500);
      await page.waitFor(`return !!document.querySelector('.item-pr')`, { label: `[${theme}] the PR row under Changes` });
      const prRow = await page.eval(`const r = document.querySelector('.item-pr'); return { href: r.getAttribute('href'), target: r.getAttribute('target'), rel: r.getAttribute('rel'), text: r.textContent }`);
      check(prRow.href === 'https://github.com/acme/shop/pull/101' && prRow.target === '_blank' && prRow.rel === 'noreferrer', `[${theme}] the PR row is an external link (${JSON.stringify(prRow)})`);
      check(prRow.text.includes('task/') && prRow.text.includes('main'), `[${theme}] the PR row names branch and base (${prRow.text})`);
      const item = await page.axe();
      check(item.length === 0, `[${theme}] axe finds nothing on the item with an open PR: ${JSON.stringify(item)}`);
      await page.shot(`cw22-item-open-${theme}`);
      await page.goto(`/tasks/${conflict.key}`, 1500);
      await page.waitFor(`return !!document.querySelector('.item-pr-wait')`, { label: `[${theme}] the conflict panel` });
      const files = await page.eval(`return document.querySelector('.item-pr-wait')?.textContent ?? ''`);
      check(files.includes('src/cart.ts') && files.includes('docs/cart.md'), `[${theme}] the conflict panel lists the files (${files})`);
      const conflictAxe = await page.axe();
      check(conflictAxe.length === 0, `[${theme}] axe finds nothing on the item with a conflict: ${JSON.stringify(conflictAxe)}`);
      await page.shot(`cw22-item-conflict-${theme}`);
    }

    // ---- a phone ----
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    await page.viewport(390, 844);
    await page.goto(`/tasks/${passing.key}`, 1500);
    // The PR panel leads the detail, as the waiting panel does
    await page.waitFor(`return !!document.querySelector('.item-pr-wait')`, { label: 'the PR panel on a phone' });
    await page.shot('cw22-item-phone');
    // The PR row sits under Changes, a section of its own on a phone
    await page.click('.workitem-layout .segment', 'Changes', 400);
    await page.waitFor(`return !!document.querySelector('.item-pr')`, { label: 'the PR row on a phone' });
    const tall = await page.eval(`return document.querySelector('.item-pr').getBoundingClientRect().height`);
    check(tall >= 44, `the PR row is a 44 px target on a phone (${tall})`);
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 1, `the item does not scroll sideways on a phone (${overflow})`);
    const phoneItem = await page.axe();
    check(phoneItem.length === 0, `axe finds nothing on the item on a phone: ${JSON.stringify(phoneItem)}`);
    await page.shot('cw22-item-phone-changes');
    await page.goto(`/tasks?project=${project.id}`, 1500);
    await page.waitFor(`return !!document.querySelector('[data-item-id]')`, { label: 'the phone board' });
    const phoneBoard = await page.axe();
    check(phoneBoard.length === 0, `axe finds nothing on the phone board: ${JSON.stringify(phoneBoard)}`);
    await page.shot('cw22-board-phone');
  } finally {
    await page.viewport(1440, 900);
    await api.del(`/projects/${project.id}`).catch(() => {});
  }
};
