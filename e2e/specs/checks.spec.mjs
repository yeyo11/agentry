// A change request's checks, end to end through the fake gh (e2e/fake-hosts): the list and the log
// tail on the item page, the board's fixing states, the orchestration's checks and "Push the fix".
//
// Reference screens: DesktopTareaChecks, MobileTareaChecks, DesktopOrquestacionChecks,
// MobileOrquestacionChecks and DSChecks.
//
// 1. A repository whose `origin` is a GitHub project, an item in review with an open PR, and the
//    fake gh reporting a mixed list (a failed, a running, a passed, a skipped and another app's
//    check): the item page groups them, words every state, moves only the running row, and offers
//    "Fix failing checks" as the zone's one gradient action while "Work on it" turns neutral.
// 2. A failed row opens its log tail: ANSI and the runner's markers are gone, the error line is
//    drawn, the annotations sit above it. Fix failing checks lists what it will send.
// 3. "Re-run failed" asks gh for `run rerun --failed`, and the list then shows the checks running.
//    "Check again" reads the fixed scenario: nothing failed, no fix action.
// 4. A fix waiting for the person's push: the item page's panel and the board's strip say so, and
//    Push the fix is offered without being pressed.
// 5. A phone: the log tail is a Sheet, the "⋯" menu is a Sheet, rows are 44 px targets, no sideways
//    scroll.
// 6. An orchestration on the same repository, integrated and pushed through the fake gh: its card
//    lists the checks, offers "Fix failing checks" as its gradient action, and a fix awaiting the
//    push shows the panel with "Push the fix" (the confirmation is opened and dismissed).
//
// What is not covered: starting a fix (it starts a chat of the project's flow) and pressing Push
// the fix; the core suite covers both against the same fake. Axe runs on every screen above.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const fakeCli = true;
export const timeout = 300_000;

const ORIGIN = 'https://github.com/acme/shop.git';
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MARKER = 'e2e-checks-survey-task';
const card = (id) => `[data-item-id="${id}"] .workitem-strip`;

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

async function scan(page, check, label) {
  await page.reduceMotion(true);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })))}`);
}

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const root = join(dirs.workspaceDir, 'e2e-checks');
  const bare = join(dirs.workspaceDir, 'e2e-checks-origin.git');
  const stateDir = join(dirs.dataDir, 'fake-hosts');
  const scenario = (checks) => {
    writeFileSync(join(stateDir, 'gh.json'), JSON.stringify({ checks, headSha: HEAD }));
    rmSync(join(stateDir, 'gh.checks'), { force: true });
  };
  const calls = () => {
    try {
      return readFileSync(join(stateDir, 'gh.calls'), 'utf8');
    } catch {
      return '';
    }
  };
  const db = () => {
    const d = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    d.exec('PRAGMA busy_timeout = 15000');
    return d;
  };
  let projectId = null;
  let orchestrationId = null;
  const chats = [];
  try {
    // ---- The repository: origin is a GitHub project, and pushes go to a local bare one ----
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(bare, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    git(bare, 'init', '-q', '--bare');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'e2e@example.com');
    git(root, 'config', 'user.name', 'e2e');
    writeFileSync(join(root, 'README.md'), '# shop\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'first commit');
    git(root, 'remote', 'add', 'origin', ORIGIN);
    git(root, 'config', `url.${bare}.pushInsteadOf`, ORIGIN);
    git(root, 'push', '-q', bare, 'main');
    scenario('mixed');
    await api.post('/hosts/refresh');

    const imported = await api.post('/projects/import', { path: root, name: 'e2e-checks', template: 'software' });
    check(imported.status === 201, `a project was imported (${imported.status})`);
    projectId = imported.body.id;

    const add = async (title, status = 'in_review') => {
      const made = await api.post(`/projects/${projectId}/work-items`, { title, acceptanceCriteria: [{ text: 'It works' }] });
      await api.post(`/work-items/${made.body.id}/move`, { status });
      return made.body;
    };
    const item = await add('Round the cart total');
    const waiting = await add('Fix waiting for its push');
    {
      const writer = db();
      const now = new Date().toISOString();
      const open = (it, number) => {
        writer
          .prepare(
            `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, url, branch, base, ci, conflicts, approved_at, opened_at, checked_at, created_at, updated_at)
             VALUES (?, ?, ?, 'open', ?, ?, ?, 'main', 'failing', '[]', ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), it.id, projectId, number, `https://github.com/acme/shop/pull/${number}`, `task/${it.key.toLowerCase()}`, now, now, now, now, now);
        writer.prepare("UPDATE work_items SET waiting = 'merge' WHERE id = ?").run(it.id);
      };
      open(item, 7);
      open(waiting, 8);
      writer.close();
    }

    // ---- The item page, desktop, both themes ----
    for (const theme of ['dark', 'light']) {
      await page.goto(`/tasks/${item.key}`, 1500);
      await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
      await page.goto(`/tasks/${item.key}`, 1500);
      await page.waitFor(`return document.querySelectorAll('.checks .check-row').length >= 2`, { timeout: 30_000, label: `[${theme}] the checks list` });
      const rows = await page.eval(
        `return [...document.querySelectorAll('.checks .check-row')].map((r) => ({ name: r.querySelector('.check-name')?.textContent ?? '', text: r.textContent, bad: !!r.querySelector('.badge-bad'), ring: !!r.querySelector('.spinner, .spinner-ring, [class*="spinner"]'), live: /live/.test(r.className) }))`,
      );
      const failed = rows.find((r) => r.name === 'unit');
      const running = rows.find((r) => r.name === 'e2e');
      check(failed?.bad && failed.text.includes('failed') && !failed.ring && !failed.live, `[${theme}] a failed check is bad, with its word, and does not move (${JSON.stringify(failed)})`);
      check(running?.text.includes('running') && running.ring, `[${theme}] the running check carries the ring (${JSON.stringify(running)})`);
      check(rows.filter((r) => r.ring).length === 1, `[${theme}] only the running row moves (${rows.filter((r) => r.ring).length})`);
      const heads = await page.eval(`return [...document.querySelectorAll('.checks .check-group-head')].map((h) => ({ text: h.textContent, open: h.getAttribute('aria-expanded') }))`);
      check(heads.some((h) => h.text.includes('Failed') && h.open === 'true') && heads.some((h) => h.text.includes('Passed') && h.open === 'false'), `[${theme}] failed is open and passed starts folded (${JSON.stringify(heads)})`);
      const summary = await page.text('.checks .checks-sum');
      check(summary.includes('1 failed') && summary.includes('1 running'), `[${theme}] the summary counts them (${summary})`);

      // The zone's one gradient action; the header's action is neutral meanwhile. A split button
      // (the top bar's New chat and its chevron) is one surface drawn as two buttons, so it counts once
      const buttons = await page.eval(
        `return { fix: document.querySelector('.workitem-fix-checks')?.className ?? null, primaries: [...new Set([...document.querySelectorAll('.btn-primary')].map((b) => b.closest('.split-btn') ?? b))].map((b) => b.textContent.trim()), work: [...document.querySelectorAll('button, a.btn')].filter((b) => /Work on it/.test(b.textContent)).map((b) => b.className) }`,
      );
      check(buttons.fix?.includes('btn-primary'), `[${theme}] Fix failing checks is the gradient action (${buttons.fix})`);
      check(buttons.work.length > 0 && buttons.work.every((c) => !c.includes('btn-primary')), `[${theme}] "Work on it" is neutral meanwhile (${JSON.stringify(buttons.work)})`);
      check(buttons.primaries.length <= 2, `[${theme}] at most two gradient surfaces (${JSON.stringify(buttons.primaries)})`);

      // The log tail of the failed check
      await page.click('.checks .check-row .check-main', 'unit', 400).catch(() => {});
      await page.waitFor(`return !!document.querySelector('.check-log .check-line')`, { timeout: 30_000, label: `[${theme}] the log tail` });
      const log = await page.eval(
        `const l = document.querySelector('.check-log'); return { text: l.textContent, hits: l.querySelectorAll('.check-line.hit').length, notes: l.querySelector('.check-notes')?.textContent ?? '', esc: l.textContent.includes('\\u001b') || l.textContent.includes('^['), group: l.textContent.includes('##[group]') }`,
      );
      check(log.text.includes('cart rounds half up') && log.hits >= 1, `[${theme}] the tail draws the error line (${log.hits})`);
      check(!log.esc && !log.group, `[${theme}] no escape code and no runner marker reaches the screen`);
      check(log.notes.includes('src/cart.ts') && log.notes.includes('failure'), `[${theme}] the annotations sit above the tail with their file and level (${log.notes})`);
      check(calls().includes('--allow-escape-sequences') || calls().includes('/actions/jobs/1002/logs'), 'gh was asked for the job log');
      await page.shot(`checks-item-${theme}`);
      await scan(page, check, `the item with its checks and a log, ${theme}`);
      await page.reduceMotion(false);
    }

    // ---- Fix failing checks: the dialog lists what it sends, and is dismissed ----
    await page.click('.workitem-fix-checks', 'Fix failing checks', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the fix dialog' });
    const dialog = await page.text('[role=dialog]');
    check(dialog.includes('unit') && !dialog.includes('lint'), `the dialog lists the failing check only (${dialog})`);
    await page.click('[role=dialog] .btn:not(.btn-primary)', 'Cancel', 400);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the dialog closes' });
    check(!/checks\/fix/.test(calls()), 'nothing was started by dismissing it');

    // ---- Re-run failed: gh is asked, and the list moves to running ----
    await page.click('.checks .checks-actions .btn', 'Re-run failed', 800);
    await page.waitFor(`return ![...document.querySelectorAll('.checks .check-row .badge-bad')].length`, { timeout: 30_000, label: 'no failed row after the re-run' });
    check(/run rerun 900 .*--failed/.test(calls()), `gh was asked to re-run the failed jobs (${calls().split('\n').filter((l) => l.startsWith('run')).join(' | ')})`);
    check(await page.eval(`return !document.querySelector('.workitem-fix-checks')`), 'with nothing failing there is no fix action');

    // ---- Check again reads the fixed scenario ----
    scenario('fixed');
    // The menu sits in the head beside the actions, not among them: on a phone the actions stack
    // under the title and the menu stays next to it. A synthetic click does not open a Radix menu
    // (it opens on pointerdown), so it is opened from the keyboard, as the other specs do
    await page.focus('.checks .checks-head [aria-label="More check actions"]');
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the checks menu' });
    await page.click('[role=menu] [role=menuitem]', 'Check again', 800);
    await page.waitFor(`return (document.querySelector('.checks .checks-sum')?.textContent ?? '').includes('3 passed')`, { timeout: 30_000, label: 'the fixed list' });
    check(await page.eval(`return !document.querySelector('.checks .badge-bad') && !document.querySelector('.workitem-fix-checks')`), 'a fixed head shows nothing failing and no fix action');
    await page.shot('checks-item-fixed');
    scenario('mixed');

    // ---- A fix waiting for its push, on the item page and on the board ----
    {
      const writer = db();
      writer.prepare("UPDATE work_item_pull_requests SET fix_state = 'awaiting-push', fix_origin = 'decision', fix_attempts = 1, fix_head = ? WHERE item_id = ?").run(HEAD, waiting.id);
      writer.close();
    }
    await page.goto(`/tasks/${waiting.key}`, 1500);
    await page.waitFor(`return !!document.querySelector('.check-fix')`, { timeout: 30_000, label: 'the fix panel' });
    const fix = await page.eval(
      `const f = document.querySelector('.check-fix'); const b = f.querySelector('.workitem-push-fix'); return { text: f.textContent, live: f.className.includes('live-rail'), push: b?.textContent ?? null, ring: !!f.querySelector('.spinner, [class*="spinner"]') }`,
    );
    check(fix.text.includes('waiting for you') && fix.push?.includes('Push the fix'), `the panel waits for the person and offers the push (${JSON.stringify(fix)})`);
    check(!fix.live && !fix.ring, 'a fix waiting for the person does not move');
    await page.shot('checks-item-fix-waiting');
    await scan(page, check, 'the item with a fix waiting for its push');
    await page.goto(`/tasks?project=${projectId}`, 1500);
    await page.waitFor(`return !!document.querySelector('${card(waiting.id)}')`, { label: 'the board strip' });
    const strip = await page.eval(`const s = document.querySelector('${card(waiting.id)}'); return { text: s.textContent, cls: s.className }`);
    check(strip.text.includes('#8') && strip.text.includes('waiting to be pushed') && strip.text.includes('decided by checks.fix'), `the board strip says the fix waits for its push (${strip.text})`);
    check(!strip.cls.includes('is-live'), 'and is not live');
    await page.shot('checks-board-fix-waiting');
    await scan(page, check, 'the board with a fixing state');

    // ---- A phone: the log is a Sheet, the menu is a Sheet, the targets are 44 px ----
    await page.viewport(390, 844);
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    await page.goto(`/tasks/${item.key}`, 1500);
    await page.waitFor(`return !!document.querySelector('.checks .check-row')`, { timeout: 30_000, label: 'the checks on a phone' });
    const heights = await page.eval(`return [...document.querySelectorAll('.checks .check-main, .checks .check-more, .checks .checks-actions .btn')].map((e) => Math.round(e.getBoundingClientRect().height))`);
    check(heights.length > 0 && heights.every((h) => h >= 44), `rows and actions are 44 px targets (${heights})`);
    check((await page.eval(`return document.documentElement.scrollWidth - innerWidth`)) <= 1, 'the phone page does not scroll sideways');
    await page.click('.checks .check-row .check-main', 'unit', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .check-log.is-sheet .check-line')`, { timeout: 30_000, label: 'the log in a sheet' });
    check(await page.eval(`return !document.querySelector('.check-log:not(.is-sheet)')`), 'there is no panel beside the list on a phone');
    await page.shot('checks-item-phone-log');
    await scan(page, check, 'the log sheet on a phone');
    await page.eval(`document.querySelector('[role=dialog] [aria-label="Close the log"]')?.click(); return true`);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the sheet closes' });
    await page.reduceMotion(false);
    await page.click('.checks .check-row .check-more', '', 400);
    await page.waitFor(`return !!document.querySelector('[role=dialog], [role=menu]')`, { label: 'the row menu' });
    check(await page.eval(`return !!document.querySelector('[role=dialog]')`), 'the row menu is a sheet on a phone');
    await page.shot('checks-item-phone-menu');
    await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`);
    await page.viewport(1440, 900);

    // ---- An orchestration: integrate, push through the fake gh, then its checks ----
    writeFileSync(fake.scripts, JSON.stringify({ [MARKER]: `say: Writing the survey\nrun: echo survey > survey.txt` }));
    const created = await api.post('/orchestrations', {
      name: 'e2e-checks',
      objective: 'a graph whose branch becomes a pull request with failing checks',
      cwd: root,
      worktree: true,
      maxAttempts: 1,
      tasks: [{ id: 'survey', name: 'Survey', prompt: `Write the survey file (${MARKER})` }],
    });
    check(created.status === 201, `the orchestration was created (${created.status} ${JSON.stringify(created.body).slice(0, 200)})`);
    orchestrationId = created.body.id;
    let state = null;
    for (let i = 0; i < 120; i++) {
      state = (await api.get(`/orchestrations/${orchestrationId}`)).body;
      for (const task of state?.tasks ?? []) if (task.sessionId && !chats.includes(task.sessionId)) chats.push(task.sessionId);
      if (state?.integration?.status === 'merged' || state?.integration?.status === 'conflicted') break;
      await page.sleep(500);
    }
    check(state?.integration?.status === 'merged', `the branch was integrated (${state?.status} / ${state?.integration?.status})`);
    // The PR is #9 or later: the item rows above never asked gh to create one
    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    await page.waitFor(`return [...document.querySelectorAll('.card .btn.btn-primary')].some((b) => b.textContent.includes('Push & open PR'))`, { label: 'the push button' });
    await page.click('.card .btn.btn-primary', 'Push & open PR', 400);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the confirmation' });
    await page.click('[role=dialog] .btn-primary', 'Push and open', 600);
    await page.waitFor(`return !!document.querySelector('.ochk-list, .ochk-row')`, { timeout: 60_000, label: 'the orchestration checks' });
    const ochk = await page.eval(
      `const rows = [...document.querySelectorAll('.ochk-row')]; return { names: rows.map((r) => r.querySelector('.ochk-name')?.textContent ?? ''), failing: rows.filter((r) => r.querySelector('.ochk-state')?.textContent.includes('failed')).length, rings: document.querySelectorAll('.ochk-row .spinner-ring, .ochk-row .spinner').length, fix: document.querySelector('.ochk-actions .btn-primary')?.textContent ?? null, rerun: [...document.querySelectorAll('.ochk-actions .btn')].map((b) => b.textContent.trim()) }`,
    );
    check(ochk.names.includes('unit') && ochk.failing === 1, `the card lists the failing check with its word (${JSON.stringify(ochk)})`);
    check(ochk.rings === 1, `only the running row moves (${ochk.rings})`);
    check(ochk.fix?.includes('Fix failing checks') && ochk.rerun.some((t) => t.includes('Re-run failed')), `the card offers Re-run failed and Fix failing checks as its gradient action (${JSON.stringify(ochk.rerun)})`);
    await page.shot('checks-orchestration');
    await scan(page, check, 'the orchestration with its checks');

    // A failed row opens its log beside the list
    await page.click('.ochk-row .ochk-main', 'unit', 500);
    await page.waitFor(`return !!document.querySelector('.ochk-log .ochk-tail')`, { timeout: 30_000, label: 'the log panel' });
    const olog = await page.eval(`const l = document.querySelector('.ochk-log'); return { text: l.textContent, esc: l.textContent.includes('\\u001b'), hits: l.querySelectorAll('.hit, [data-error]').length }`);
    check(olog.text.includes('cart rounds half up') && !olog.esc, `the orchestration's log tail is clean (${olog.text.slice(0, 120)})`);
    await page.shot('checks-orchestration-log');

    // A fix awaiting its push replaces Fix failing checks
    {
      const writer = db();
      writer.prepare("UPDATE orchestration_pull_requests SET fix_state = 'awaiting-push', fix_origin = 'person', fix_attempts = 1, fix_head = ? WHERE orchestration_id = ?").run(HEAD, orchestrationId);
      writer.close();
    }
    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.ochk-fix')`, { timeout: 30_000, label: 'the Push the fix panel' });
    const panel = await page.eval(
      `const p = document.querySelector('.ochk-fix'); return { text: p.textContent, border: p.className.includes('grad-border'), button: [...p.querySelectorAll('button')].map((b) => b.textContent.trim()), fixAction: !!document.querySelector('.ochk-actions .btn-primary') }`,
    );
    check(panel.text.includes('waits for you') && panel.button.some((b) => b.includes('Push the fix')), `the panel waits for the person (${JSON.stringify(panel)})`);
    check(panel.border && !panel.fixAction, 'the panel is the screen’s gradient surface, and Fix failing checks is gone');
    await page.click('.ochk-fix .btn', 'Push the fix', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the push confirmation' });
    check((await page.text('[role=dialog]')).includes('Push the fix'), 'pressing it asks first');
    check(!/push-fix/.test(calls()), 'nothing was pushed');
    await page.shot('checks-orchestration-push-fix');
    await page.click('[role=dialog] .btn:not(.btn-primary)', 'Cancel', 400).catch(() => {});

    // The phone's orchestration: the log is a Sheet
    await page.viewport(390, 844);
    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.ochk-row')`, { timeout: 30_000, label: 'the checks on a phone' });
    const oheights = await page.eval(`return [...document.querySelectorAll('.ochk-row .ochk-main')].map((e) => Math.round(e.getBoundingClientRect().height))`);
    check(oheights.length > 0 && oheights.every((h) => h >= 44), `the rows are 44 px targets (${oheights})`);
    check((await page.eval(`return document.documentElement.scrollWidth - innerWidth`)) <= 1, 'the phone orchestration does not scroll sideways');
    await page.click('.ochk-row .ochk-main', 'unit', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .ochk-tail, [role=dialog] .ochk-log')`, { timeout: 30_000, label: 'the log in a sheet' });
    await page.shot('checks-orchestration-phone');
    await scan(page, check, 'the orchestration log sheet on a phone');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    writeFileSync(fake.scripts, '{}');
    for (const file of ['gh.json', 'gh.checks', 'gh.created', 'gh.next']) rmSync(join(stateDir, file), { force: true });
    await api.post('/hosts/refresh').catch(() => {});
    if (orchestrationId) await api.del(`/orchestrations/${orchestrationId}`).catch(() => {});
    for (const id of chats) await api.del(`/chats/${id}`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
    rmSync(bare, { recursive: true, force: true });
  }
};
