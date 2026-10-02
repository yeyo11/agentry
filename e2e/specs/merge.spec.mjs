// Merging a change request, end to end through the fake gh and glab (e2e/fake-hosts): the merge block
// on the item page and on the orchestration, every blocked state with its word and its remedy,
// auto-merge on and off, Update from base, the GitLab pipeline wait, the head guard, and the
// board's "auto-merge on" badge.
//
// Reference screens: DesktopTareaFusion, DesktopTareaFusionBorrador, DesktopTareaFusionEstados,
// MobileTareaFusion*, DSFusion, DesktopOrquestacionFusion, MobileOrquestacionFusion,
// DesktopTableroFusion and MobileTableroFusion.
//
// 1. A GitHub repository (the fake gh), an item in review with an open pull request: the merge block
//    in both themes (method, message, branch box, Merge as the zone's one gradient action while
//    "Work on it" turns neutral), a draft review taking the gradient from Merge, and every blocked
//    state the table of docs/plans/code-hosts.md lists that the fake can produce, each with its word,
//    its sentence and one remedy, never a command to copy.
// 2. Auto-merge: arming (through the arming mutation, never `gh pr merge --auto`), the armed row, the
//    board's badge, Turn off.
// 3. The head guard: the fake host's head moves between what the person saw and the click. Nothing is
//    merged, the page says the branch changed, and Read again reads the new head. The API answers the
//    same with `head-moved`, and no `pr merge` ever reached the fake.
// 4. Merge: the method, the message, the branch box and the head reach `gh pr merge`; the item moves
//    to Done.
// 5. A GitLab project (the fake glab, a fast-forward project): waiting for the pipeline is the one live
//    thing (a braille spinner beside the verb that holds still under reduced motion), arming with a
//    pipeline running, "Rebase on GitLab" for Update from base, and Merge now with auto-merge off.
// 6. An orchestration on the GitHub repository, integrated and pushed through the fake gh: its card's
//    merge block, a blocked state, the head guard, and Merge.
// 7. A phone: the block, 44 px targets, no sideways scroll, no gradient outside the block.
//
// Every gradient count here is of every kind of gradient surface (a primary button, a gradient border,
// gradient text, the FAB), on the item page for a mergeable request, a draft review, a push that waits,
// a failing check and arming, and on the orchestration page for a push that waits and a mergeable
// branch. Also covered: two failing required checks, a merged and a closed request, Update from base
// refused while busy, and the orchestration's notices, blocker buttons and re-read after a refusal.
// A waiting publish (a review that stopped half way) is covered by reviews.spec.mjs and the item-lead unit test.
//
// Axe runs on every screen above, at full contrast. The split "New chat" button is one gradient
// surface drawn as two buttons: every count here counts it once.
//
// What is not covered: pressing Update from base on GitHub (it merges in the item's own checkout, which
// a seeded row does not have; the core suite covers it), and the merged record, which the block does
// not draw once the request is no longer open.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const fakeCli = true;
export const timeout = 600_000;

const GH_ORIGIN = 'https://github.com/acme/shop.git';
const GL_ORIGIN = 'https://gitlab.com/acme/shop.git';
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MOVED = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
const MARKER = 'e2e-merge-survey-task';
const card = (id) => `[data-item-id="${id}"] .workitem-strip`;
const WORDS = /^[a-z][a-z ]+$/;

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

async function scan(page, check, label) {
  await page.reduceMotion(true);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })))}`);
  await page.reduceMotion(false);
}

function repository(root, bare, origin) {
  rmSync(root, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'e2e@example.com');
  git(root, 'config', 'user.name', 'e2e');
  writeFileSync(join(root, 'README.md'), '# shop\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first commit');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'config', `url.${bare}.pushInsteadOf`, origin);
  git(root, 'push', '-q', bare, 'main');
}

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const stateDir = join(dirs.dataDir, 'fake-hosts');
  const ghRoot = join(dirs.workspaceDir, 'e2e-merge-gh');
  const ghBare = join(dirs.workspaceDir, 'e2e-merge-gh-origin.git');
  const glRoot = join(dirs.workspaceDir, 'e2e-merge-gl');
  const glBare = join(dirs.workspaceDir, 'e2e-merge-gl-origin.git');
  const projects = [];
  const chats = [];
  let orchestrationId = null;

  // What the fake host answers. The repository's settings are read once a minute, so the ones that
  // change what is offered (methods, auto-merge allowed, the merge strategy) never change here.
  const BASE = { gh: { methods: 'squash merge', next: 20 }, glab: { mergeMethod: 'ff' } };
  const scenario = (host, fields = {}) => {
    const name = host === 'gh' ? 'gh' : 'glab';
    writeFileSync(join(stateDir, `${name}.json`), JSON.stringify({ headSha: HEAD, ...BASE[host], ...fields }));
    for (const file of [`${name}.merged`, `${name}.armed`, `${name}.checks`, `${name}.rebased`]) rmSync(join(stateDir, file), { force: true });
  };
  const calls = (host) => {
    try {
      return readFileSync(join(stateDir, `${host}.calls`), 'utf8');
    } catch {
      return '';
    }
  };
  const lines = (host, pattern) => calls(host).split('\n').filter((l) => pattern.test(l));
  const db = () => {
    const d = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    d.exec('PRAGMA busy_timeout = 15000');
    return d;
  };

  const item = async (projectId, title, description) => {
    const made = await api.post(`/projects/${projectId}/work-items`, { title, ...(description ? { description } : {}), acceptanceCriteria: [{ text: 'It works' }] });
    await api.post(`/work-items/${made.body.id}/move`, { status: 'in_review' });
    return made.body;
  };
  // The open request of an item, as the watcher leaves it; its row id is the change request's id
  const open = (projectId, it, number, host) => {
    const id = randomUUID();
    const writer = db();
    const now = new Date().toISOString();
    const url = host === 'gitlab' ? `https://gitlab.com/acme/shop/-/merge_requests/${number}` : `https://github.com/acme/shop/pull/${number}`;
    writer
      .prepare(
        `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, url, branch, base, ci, conflicts, approved_at, opened_at, checked_at, created_at, updated_at, host, hostname)
         VALUES (?, ?, ?, 'open', ?, ?, ?, 'main', 'passing', '[]', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, it.id, projectId, number, url, `task/${it.key.toLowerCase()}`, now, now, now, now, now, host, host === 'gitlab' ? 'gitlab.com' : 'github.com');
    writer.prepare("UPDATE work_items SET waiting = 'merge' WHERE id = ?").run(it.id);
    writer.close();
    return id;
  };

  // The page of an item, once its merge block has read the host
  const visit = async (it, label, ready = '.mg .mg-foot, .mg .mb-note, .mg .rv-card') => {
    // A scenario changes what the host says between visits, and the repository's rules are cached for a minute:
    // the person's Refresh reads them again, so the page starts from what the scenario says
    const found = (await api.get(`/work-items/${it.id}`)).body;
    if (found?.pullRequest?.id) await api.get(`/change-requests/${found.pullRequest.id}/merge?refresh=1`);
    await page.goto(`/tasks/${it.key}`, 1500);
    await page.waitFor(`return !!document.querySelector('${ready}')`, { timeout: 60_000, label });
  };
  // What carries the gradient: the split New chat button is one surface drawn as two buttons
  const surfaces = () =>
    page.eval(
      `const prim = [...document.querySelectorAll('.btn-primary')];
       const all = [...new Set(prim.map((b) => b.closest('.split-btn') ?? b))];
       return {
         surfaces: all.map((b) => (b.closest('.split-btn') ? '(split) ' : '') + b.textContent.trim()),
         splits: all.filter((b) => b.classList.contains('split-btn')).length,
         fab: document.querySelectorAll('.fab').length,
         inBlock: [...document.querySelectorAll('.mg .btn-primary, .omrg .btn-primary')].map((b) => b.textContent.trim()),
         outside: prim.filter((b) => !b.closest('.mg') && !b.closest('.omrg') && !b.closest('.split-btn')).map((b) => b.textContent.trim()),
         work: [...document.querySelectorAll('.workitem-work')].map((b) => b.className),
       }`,
    );
  // Every gradient surface of the screen, whatever draws it: a primary button, a gradient border, gradient text
  // that is not on a border already counted, the FAB. The split New chat button is one surface drawn as two buttons.
  const gradients = () =>
    page.eval(
      `const seen = new Set();
       const list = [];
       const add = (el, kind) => {
         if (seen.has(el)) return;
         seen.add(el);
         list.push({ kind, split: el.classList.contains('split-btn'), text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 48) });
       };
       for (const b of document.querySelectorAll('.btn-primary')) add(b.closest('.split-btn') ?? b, 'button');
       for (const el of document.querySelectorAll('.grad-border')) add(el, 'border');
       for (const el of document.querySelectorAll('.grad-text')) if (!el.closest('.grad-border')) add(el, 'text');
       for (const el of document.querySelectorAll('.fab')) add(el, 'fab');
       return { all: list, splits: list.filter((x) => x.split).length, zone: list.filter((x) => !x.split) }`,
    );
  const text = (selector) => page.eval(`return document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const buttons = (scope) => page.eval(`return [...document.querySelectorAll(${JSON.stringify(`${scope} button, ${scope} a.btn`)})].map((b) => ({ text: b.textContent.trim(), primary: b.classList.contains('btn-primary'), disabled: b.disabled === true }))`);
  const press = async (scope, label) => {
    await page.eval(`const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) throw new Error('no ${label} button in ${scope}: ' + [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].map((x) => x.textContent.trim() + (x.disabled ? ' (disabled)' : '')).join(', ')); b.click(); return true`);
  };

  try {
    // ================= 1. The GitHub project, item page =================
    repository(ghRoot, ghBare, GH_ORIGIN);
    mkdirSync(stateDir, { recursive: true });
    scenario('gh');
    scenario('glab');
    await api.post('/hosts/refresh');
    const ghProject = (await api.post('/projects/import', { path: ghRoot, name: 'e2e-merge', template: 'software' })).body;
    check(!!ghProject?.id, 'the GitHub project was imported');
    projects.push(ghProject.id);

    const ready = await item(ghProject.id, 'Round the cart total');
    const readyId = open(ghProject.id, ready, 7, 'github');
    const mergeMe = await item(ghProject.id, 'Merge with a message');
    const mergeId = open(ghProject.id, mergeMe, 8, 'github');
    const armMe = await item(ghProject.id, 'Arm auto-merge');
    open(ghProject.id, armMe, 9, 'github');
    const moves = await item(ghProject.id, 'The branch that moves');
    const movesId = open(ghProject.id, moves, 10, 'github');

    await page.goto('/', 300);
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
      scenario('gh');
      await visit(ready, `[${theme}] the merge block of a clean pull request`);
      const block = await page.eval(
        `const b = document.querySelector('.mg'); return { head: b.querySelector('.mg-head')?.textContent ?? '', labels: [...b.querySelectorAll('.rv-label')].map((l) => l.textContent.trim()), methods: [...b.querySelectorAll('.segment')].map((s) => s.textContent.trim()), box: !!b.querySelector('.mg-check'), subject: !!b.querySelector('input[aria-label="Commit subject"]'), badge: b.querySelector('.badge-ok')?.textContent ?? '' }`,
      );
      check(block.head.includes('Merge') && block.head.includes('task/') && block.head.includes(HEAD.slice(0, 7)), `[${theme}] the head names the request, the branches and the commit it will merge (${block.head})`);
      check(block.methods.join('|') === 'Squash|Merge commit', `[${theme}] the repository's allowed methods are the segmented control, squash first (${block.methods})`);
      check(block.labels.includes('Method') && block.labels.includes('Message') && block.labels.includes('Branch') && block.box && block.subject, `[${theme}] the rows are method, message and branch box (${block.labels})`);
      check(block.badge.includes('ready to merge'), `[${theme}] the badge says it with a word (${block.badge})`);
      const gradient = await surfaces();
      check(gradient.inBlock.join() === 'Merge', `[${theme}] Merge is the zone's one gradient action (${JSON.stringify(gradient.inBlock)})`);
      check(gradient.outside.length === 0 && gradient.work.length > 0 && gradient.work.every((c) => !c.includes('btn-primary')), `[${theme}] "Work on it" is neutral meanwhile (${JSON.stringify(gradient)})`);
      const every = await gradients();
      check(every.splits === 1 && every.all.length <= 2 && every.zone.length === 1 && every.zone[0].text.startsWith('Merge'), `[${theme}] the split New chat button counts once, and Merge is the only other gradient surface of any kind (${JSON.stringify(every.all)})`);
      check(!/gh pr merge|--squash|--match-head/.test(await text('.mg')), `[${theme}] no command to copy in the block`);
      check(lines('gh', /^pr merge/).length === 0, 'nothing merged by looking at it');
      await page.shot(`merge-item-ready-${theme}`);
      await scan(page, check, `the item with a ready merge block, ${theme}`);
    }

    // A draft review leads: Submit review takes the gradient and Merge goes plain
    {
      const draft = await api.post(`/change-requests/${readyId}/review-drafts`, { body: 'This rounding looks off' });
      check(draft.status === 201, `a draft review note was saved (${draft.status})`);
      await visit(ready, 'the block with a draft review');
      const gradient = await surfaces();
      check(gradient.inBlock.length === 0 && gradient.surfaces.some((s) => s.includes('Submit review')), `a draft review leads: Submit review has the gradient, Merge is plain (${JSON.stringify(gradient)})`);
      check(gradient.work.every((c) => !c.includes('btn-primary')), 'and "Work on it" is still neutral');
      const every = await gradients();
      check(every.splits === 1 && every.all.length <= 2 && every.zone.length === 1 && every.zone[0].text.includes('Submit review'), `a draft review is the one gradient surface besides the split button (${JSON.stringify(every.all)})`);
      check((await buttons('.mg')).some((b) => b.text === 'Merge' && !b.primary), 'Merge is still there, plain');
      await page.shot('merge-item-draft-review');
      await scan(page, check, 'the item with a draft review leading');
      await api.del(`/change-requests/${readyId}/review-drafts/${draft.body.id}`);
    }

    // A fix waiting to be pushed leads: Push the fix has the gradient, Merge goes plain and "Work on it" stays neutral
    {
      const writer = db();
      writer.prepare("UPDATE work_item_pull_requests SET fix_state = 'awaiting-push', fix_origin = 'person', fix_attempts = 1, fix_head = ? WHERE id = ?").run(HEAD, readyId);
      writer.close();
      scenario('gh');
      await visit(ready, 'a fix waiting to be pushed');
      const gradient = await surfaces();
      const every = await gradients();
      check(every.splits === 1 && every.all.length <= 2 && every.zone.length === 1 && /push/i.test(every.zone[0].text), `a push that waits leads: it is the one gradient surface besides the split button (${JSON.stringify(every.all)})`);
      check(gradient.inBlock.length === 0 && (await buttons('.mg')).some((b) => b.text === 'Merge' && !b.primary), 'and Merge is plain while it waits');
      check(gradient.work.every((c) => !c.includes('btn-primary')), 'and "Work on it" is neutral');
      await scan(page, check, 'the item with a push waiting');
      const reset = db();
      reset.prepare('UPDATE work_item_pull_requests SET fix_state = NULL, fix_origin = NULL, fix_attempts = 0, fix_head = NULL WHERE id = ?').run(readyId);
      reset.close();
    }

    // ---- The blocked states: the word, the sentence and one remedy ----
    const CASES = [
      { name: 'draft', fields: { draft: true }, code: 'draft', word: 'draft', sentence: 'is a draft', remedy: 'Mark as ready' },
      { name: 'conflicts', fields: { mergeStatus: 'DIRTY' }, code: 'conflicts', word: 'conflicting', sentence: 'conflicts with main', remedy: 'Update from main' },
      { name: 'behind', fields: { mergeStatus: 'BEHIND' }, code: 'behind', word: 'out of date', sentence: 'requires', remedy: 'Update from main' },
      { name: 'checks-failing', fields: { mergeStatus: 'BLOCKED', requiredChecks: 'unit', checks: 'failing' }, code: 'checks-failing', word: 'failing', sentence: 'Required check unit failed', remedy: 'Fix failing checks' },
      { name: 'review-required', fields: { mergeStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, code: 'review-required', word: 'not approved', sentence: 'approval', remedy: 'Ask for a review' },
      { name: 'changes-requested', fields: { reviewDecision: 'CHANGES_REQUESTED' }, code: 'changes-requested', word: 'changes asked', sentence: 'asked for changes', remedy: 'Address with an agent' },
      { name: 'blocked-by-policy', fields: { mergeStatus: 'BLOCKED' }, code: 'blocked-by-policy', word: 'blocked', sentence: 'rules for main', remedy: 'Open on GitHub' },
    ];
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    for (const c of CASES) {
      scenario('gh', c.fields);
      await visit(ready, `the blocked state ${c.name}`, `.mg .mb-note[data-reason="${c.code}"]`);
      const note = await page.eval(
        `const n = document.querySelector('.mg .mb-note'); return { reason: n.dataset.reason, tone: n.className, word: n.querySelector('.badge')?.textContent.trim() ?? '', text: n.querySelector('.mb-text')?.textContent ?? '', acts: [...n.querySelectorAll('.mb-acts button, .mb-acts a')].map((b) => b.textContent.trim()), code: !!n.querySelector('pre, code, kbd, samp, [data-copy], .copy') || /\\b(gh|glab|git)\\s+(pr|mr|merge|rebase|push|checkout|fetch|pull)\\b/.test(n.textContent), reasonCode: n.querySelector('.mb-code')?.textContent.trim() ?? '', merge: !![...document.querySelectorAll('.mg .mg-foot button')].find((b) => b.textContent.trim() === 'Merge') }`,
      );
      check(note.word === c.word && WORDS.test(note.word), `[${c.name}] the notice carries its word (${note.word})`);
      check(note.text.includes(c.sentence), `[${c.name}] and its sentence (${note.text})`);
      // One remedy; where the host can wait for what blocks (a review, a running check) the same notice also offers auto-merge
      const waits = c.code === 'review-required' || c.code === 'checks-running';
      const remedies = waits ? note.acts.filter((a) => !/auto-merge/i.test(a)) : note.acts;
      check(remedies.length === 1 && remedies[0].includes(c.remedy) && note.acts.length <= (waits ? 2 : 1), `[${c.name}] and one remedy, ${c.remedy} (${JSON.stringify(note.acts)})`);
      // The span.mb-code is the blocker's identifier in mono, not something to copy: it is the code itself and nothing more
      check(note.reasonCode === c.code, `[${c.name}] the mono code span holds the blocker's own code (${note.reasonCode})`);
      check(/is-(warn|bad|idle|live)/.test(note.tone) && !note.code && !note.merge, `[${c.name}] in a status tone, with no Merge and nothing to copy (${note.tone})`);
      if (c.name === 'checks-failing') {
        // Fix failing checks leads, so the block's own remedy is a plain button: exactly one gradient action in the zone
        const every = await gradients();
        check(every.zone.length === 1 && every.zone[0].text.includes('Fix failing checks') && every.splits === 1 && every.all.length <= 2, `[${c.name}] Fix failing checks is the zone's one gradient action (${JSON.stringify(every.all)})`);
        check(note.acts.length === 1 && !(await buttons('.mg .mb-acts')).some((b) => b.primary), `[${c.name}] and the block's own remedy is plain`);
      }
      await page.shot(`merge-item-blocked-${c.name}`);
      await scan(page, check, `the blocked state ${c.name}`);
    }
    // Two required checks that both failed: both are named, one in the sentence and the other under it
    scenario('gh', { mergeStatus: 'BLOCKED', requiredChecks: 'unit lint', checks: 'both' });
    await visit(ready, 'two failing required checks', '.mg .mb-note[data-reason="checks-failing"]');
    {
      const two = await page.eval(
        `const n = document.querySelector('.mg .mb-note'); return { first: n.querySelector('.mb-text')?.textContent ?? '', others: [...n.querySelectorAll('.mb-others li')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim()) }`,
      );
      check(two.first.includes('Required check unit failed') && two.others.length === 1 && two.others[0].includes('Required check lint failed'), `two failing required checks list both names, each in words (${JSON.stringify(two)})`);
      await scan(page, check, 'two failing required checks');
    }

    // A request the host has merged or closed does not read as open
    {
      const gone = await item(ghProject.id, 'Merged on the host');
      open(ghProject.id, gone, 12, 'github');
      for (const [state, word, sentence] of [
        ['merged', 'merged', 'was merged'],
        ['closed', 'closed', 'was closed without merging'],
      ]) {
        scenario('gh', { state });
        await visit(gone, `a ${state} request`, '.mg .mb-note[data-reason="not-open"]');
        const note = await page.eval(
          `const n = document.querySelector('.mg .mb-note'); return { word: n.querySelector('.badge')?.textContent.trim() ?? '', text: n.querySelector('.mb-text')?.textContent ?? '', merge: [...document.querySelectorAll('.mg button')].some((b) => b.textContent.trim() === 'Merge'), ready: document.querySelector('.mg')?.textContent.includes('ready to merge') }`,
        );
        check(note.word === word && note.text.includes(sentence) && !/\bopen\b/i.test(note.text), `a ${state} request says ${state}, not that it is open (${note.word}: ${note.text})`);
        check(!note.merge && !note.ready, `a ${state} request offers no Merge and is not ready to merge`);
        await scan(page, check, `a ${state} request`);
      }
    }

    // Update from base refused while a chat works in the branch says busy, not conflicts
    {
      const busy = await item(ghProject.id, 'Busy while updating', 'run: sleep 120');
      const started = await api.post(`/work-items/${busy.id}/work`, {});
      check(started.status === 200 || started.status === 201, `Work on it started a chat (${started.status})`);
      if (started.body?.chat?.id) chats.push(started.body.chat.id);
      const busyId = open(ghProject.id, busy, 13, 'github');
      scenario('gh', { mergeStatus: 'BEHIND' });
      let refusal = null;
      for (let tries = 0; tries < 30 && refusal?.body?.code !== 'busy'; tries++) {
        refusal = await api.post(`/change-requests/${busyId}/update-branch`, {});
        if (refusal.body?.code !== 'busy') await page.sleep(500);
      }
      check(refusal?.status === 409 && refusal.body.code === 'busy', `the API refuses Update from base with busy (${refusal?.status} ${refusal?.body?.code})`);
      await visit(busy, 'a behind branch with a chat working', '.mg .mb-note[data-reason="behind"]');
      await press('.mg .mb-note', 'Update from main');
      const toast = await page.waitFor(`const t = [...document.querySelectorAll('.toast')].find((e) => /Nothing was updated/.test(e.innerText)); return t ? t.innerText : null`, { timeout: 30_000, label: 'the toast of the refused update' });
      check(/working in this branch/.test(toast) && !/conflict/i.test(toast), `Update from base refused while busy says busy, not conflicts (${toast})`);
      if (started.body?.chat?.id) await api.del(`/chats/${started.body.chat.id}`).catch(() => {});
    }

    // Not required checks that failed: it can merge, with a warning
    scenario('gh', { mergeStatus: 'UNSTABLE' });
    await visit(ready, 'the warning state', '.mg .mg-foot');
    {
      const warn = await page.eval(`const r = [...document.querySelectorAll('.mg .rv-row')].find((x) => x.querySelector('.rv-label')?.textContent.trim() === 'Warning'); return { text: r?.textContent ?? '', badge: r?.querySelector('.badge-warn')?.textContent ?? '' }`);
      check(warn.badge === 'not required' && warn.text.includes('not required'), `failed checks that are not required warn in words and still allow the merge (${warn.text})`);
      check((await surfaces()).inBlock.join() === 'Merge', 'Merge is still the action');
      await scan(page, check, 'the merge block with a warning');
    }
    // The host is still working it out: the block waits, then says so
    scenario('gh', { mergeStatus: 'UNKNOWN' });
    await visit(ready, 'the computing state', '.mg .mb-note[data-reason="computing"]');
    check((await text('.mg .mb-note')).includes('still working out'), 'a host that is still working it out says so, after Agentry read again');
    await scan(page, check, 'the computing state');

    // ================= 2. Auto-merge =================
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
      scenario('gh', { mergeStatus: 'BLOCKED', requiredChecks: 'e2e', checks: 'running' });
      await visit(armMe, `[${theme}] required checks still running`, '.mg .mb-note[data-reason="checks-running"]');
      const pending = await page.eval(`return { acts: [...document.querySelectorAll('.mg .mb-acts button')].map((b) => ({ text: b.textContent.trim(), primary: b.classList.contains('btn-primary') })), merge: !![...document.querySelectorAll('.mg button')].find((b) => b.textContent.trim() === 'Merge'), text: document.querySelector('.mg .mb-note')?.textContent ?? '' }`);
      check(pending.acts.length === 1 && pending.acts[0].text === 'Turn on auto-merge' && pending.acts[0].primary && !pending.merge, `[${theme}] with checks pending, arming replaces Merge as the gradient action (${JSON.stringify(pending.acts)})`);
      check(pending.text.includes('Required checks have not finished'), `[${theme}] and the notice says why (${pending.text})`);
      const every = await gradients();
      check(every.splits === 1 && every.all.length <= 2 && every.zone.length === 1 && every.zone[0].text.includes('Turn on auto-merge'), `[${theme}] arming is the one gradient surface besides the split button (${JSON.stringify(every.all)})`);
      await page.shot(`merge-item-checks-pending-${theme}`);
      await scan(page, check, `the pending-checks state, ${theme}`);
      if (theme === 'light') break;

      await press('.mg', 'Turn on auto-merge');
      await page.waitFor(`return !!document.querySelector('.mg .badge-idle') && (document.querySelector('.mg')?.textContent ?? '').includes('auto-merge on')`, { timeout: 30_000, label: 'the armed block' });
      const armed = await page.eval(`const b = document.querySelector('.mg'); return { text: b.textContent, spinners: b.querySelectorAll('.spinner-glyph, .spinner-ring, .spinner-dots').length, acts: [...b.querySelectorAll('button')].map((x) => x.textContent.trim()), primary: b.querySelectorAll('.btn-primary').length }`);
      check(armed.text.includes('@octocat') && armed.text.includes('Squash'), `the armed block says who and which method (${armed.text.slice(0, 160)})`);
      check(armed.acts.includes('Turn off') && armed.spinners === 0 && armed.primary === 0, `it offers Turn off, nothing moves, no gradient (${JSON.stringify(armed.acts)})`);
      check(lines('gh', /enablePullRequestAutoMerge/).length === 1, 'gh was asked through the arming mutation');
      check(!calls('gh').split('\n').some((l) => l.startsWith('pr merge') && l.split(' ').includes('--auto')), 'never through `gh pr merge --auto`');
      // The board card says so as well
      await page.goto(`/tasks?project=${ghProject.id}`, 1500);
      await page.waitFor(`return !!document.querySelector('${card(armMe.id)} .workitem-strip-auto')`, { timeout: 60_000, label: 'the board badge' });
      const badge = await page.eval(`const s = document.querySelector('${card(armMe.id)} .workitem-strip-auto'); return { text: s.textContent, live: s.className.includes('live') || !!s.querySelector('.spinner-glyph, .spinner-ring, .spinner-dots') }`);
      check(badge.text.includes('auto-merge on') && badge.text.includes('merges on its own'), `the board card says auto-merge is on, in words (${badge.text})`);
      // A plain badge never animates, so its animation would prove nothing: what is checked is that it is not drawn as a live thing
      check(!badge.live, 'and it is not a live thing: no live class and no spinner while the host waits');
      await page.shot('merge-board-auto-merge-dark');
      await scan(page, check, 'the board with an auto-merge badge');
      await visit(armMe, 'the armed block again', '.mg .badge-idle');
      await scan(page, check, 'the armed block, dark');
      await page.shot('merge-item-armed-dark');
      // The light theme reads the armed state the host holds, then turns it off
      await page.eval(`localStorage.setItem('agentry-theme', 'light'); return true`);
      await visit(armMe, '[light] the armed block', '.mg .badge-idle');
      await page.shot('merge-item-armed-light');
      await scan(page, check, 'the armed block, light');
      await press('.mg', 'Turn off');
      await page.waitFor(`return !!document.querySelector('.mg .mb-note[data-reason="checks-running"]')`, { timeout: 30_000, label: 'the block after Turn off' });
      check(lines('gh', /^pr merge .*--disable-auto/).length === 1, 'gh was asked to turn auto-merge off');
      scenario('gh', { mergeStatus: 'BLOCKED', requiredChecks: 'e2e', checks: 'running' });
    }

    // ================= 3. The head guard =================
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    scenario('gh');
    await visit(moves, 'the block before the head moves');
    check((await text('.mg .mg-head')).includes(HEAD.slice(0, 7)), 'the person is looking at the first head');
    // The fake host's head moves between what they saw and the click
    scenario('gh', { headSha: MOVED });
    const before = lines('gh', /^pr merge/).length;
    await press('.mg .mg-foot', 'Merge');
    await page.waitFor(`return !!document.querySelector('.mg .callout-warn')`, { timeout: 30_000, label: 'the head moved notice' });
    // The state is read again after the refusal, and the new head arrives with it
    await page.waitFor(`return document.querySelectorAll('.mg .rv-row .mg-mono').length >= 2`, { timeout: 30_000, label: 'the head now, read again' });
    const movedNote = await page.eval(`const b = document.querySelector('.mg'); return { text: b.textContent, badge: b.querySelector('.badge-warn')?.textContent ?? '', buttons: [...b.querySelectorAll('.mg-foot button')].map((x) => ({ text: x.textContent.trim(), disabled: x.disabled, primary: x.classList.contains('btn-primary') })) }`);
    check(movedNote.text.includes('The branch changed while you were looking, and nothing was merged.') && movedNote.badge === 'branch changed', `the block says the branch changed, in words (${movedNote.badge})`);
    check(movedNote.text.includes(HEAD.slice(0, 7)) && movedNote.text.includes(MOVED.slice(0, 7)), `it names both heads: the one seen and the one now (${movedNote.text.replace(/\s+/g, ' ').slice(0, 400)})`);
    check(movedNote.buttons.some((b) => b.text === 'Merge' && b.disabled) && movedNote.buttons.some((b) => b.text === 'Read again' && !b.disabled), `Merge is off and Read again is offered (${JSON.stringify(movedNote.buttons)})`);
    check(lines('gh', /^pr merge/).length === before, 'no `pr merge` reached the host: a commit nobody saw is never merged');
    const refused = await api.post(`/change-requests/${movesId}/merge`, { method: 'squash', expectedHead: HEAD, deleteBranch: false });
    check(refused.status === 409 && refused.body.code === 'head-moved', `the API refuses the same way (${refused.status} ${refused.body.code})`);
    check(lines('gh', /^pr merge/).length === before, 'and still nothing was merged');
    await page.shot('merge-item-head-moved');
    await scan(page, check, 'the head moved state');
    await press('.mg .mg-foot', 'Read again');
    await page.waitFor(`return !document.querySelector('.mg .callout-warn') && (document.querySelector('.mg .mg-head')?.textContent ?? '').includes('${MOVED.slice(0, 7)}')`, { timeout: 30_000, label: 'the block after Read again' });
    check((await buttons('.mg .mg-foot')).some((b) => b.text === 'Merge' && !b.disabled), 'Read again reads the new head and Merge is offered on it');

    // The audit of the clicks: the refused one is recorded as failed, with its reason
    {
      const reader = db();
      const rows = reader.prepare('SELECT action, outcome, reason, expected_head FROM change_request_merges WHERE cr_id = ? ORDER BY requested_at').all(movesId);
      reader.close();
      check(rows.length >= 2 && rows.every((r) => r.action === 'merge' && r.outcome === 'failed' && r.reason === 'head-moved' && r.expected_head === HEAD), `every refused click is on record with its reason (${JSON.stringify(rows)})`);
    }

    // ================= 4. Merge =================
    scenario('gh');
    await visit(mergeMe, 'the block to merge from');
    await page.click('.mg .segment', 'Merge commit', 300);
    await page.fill('.mg input[aria-label="Commit subject"]', 'Round the cart total (#8)');
    await page.fill('.mg textarea', 'Half up, as the invoice rounds.');
    await page.click('.mg .mg-check', undefined, 300);
    check(await page.eval(`return document.querySelector('.mg .mg-check [role=checkbox]')?.getAttribute('aria-checked') === 'true'`), 'the branch box is ticked');
    await press('.mg .mg-foot', 'Merge');
    await page.waitFor(`return !document.querySelector('.mg')`, { timeout: 60_000, label: 'the block after the merge' });
    const merged = lines('gh', /^pr merge 8/);
    check(merged.length === 1, `gh was asked to merge once (${merged.length})`);
    const argv = merged[0] ?? '';
    check(argv.includes('--merge ') && argv.includes(`--match-head-commit ${HEAD}`) && argv.includes('--subject Round the cart total (#8)') && argv.includes('--body-file -') && argv.includes('--delete-branch'), `the method, the head, the subject, the body and the branch box reached it (${argv})`);
    check(!argv.includes('--admin') && !argv.split(' ').includes('--auto') && argv.includes('-R github.com/acme/shop'), 'never --admin or --auto, and always -R');
    check(readFileSync(join(stateDir, 'gh.merge-body'), 'utf8').includes('Half up, as the invoice rounds.'), 'the body travelled on stdin');
    let done = null;
    for (let i = 0; i < 40 && done !== 'done'; i++) {
      done = (await api.get(`/work-items/${mergeMe.id}`)).body.status;
      if (done !== 'done') await page.sleep(500);
    }
    check(done === 'done', `the item moved to Done after the merge (${done})`);
    {
      // The row is written when the click arrives and settled when the host has answered
      let row;
      for (let tries = 0; tries < 80; tries++) {
        const reader = db();
        row = reader.prepare('SELECT action, method, outcome, requested_by, delete_branch FROM change_request_merges WHERE cr_id = ?').get(mergeId);
        reader.close();
        if (row?.outcome && row.outcome !== 'requested') break;
        await page.sleep(250);
      }
      check(row?.outcome === 'merged' && row.method === 'merge' && row.delete_branch === 1 && !!row.requested_by, `the click is recorded with the person as actor (${JSON.stringify(row)})`);
    }
    await page.shot('merge-item-merged');

    // ================= 5. GitLab =================
    repository(glRoot, glBare, GL_ORIGIN);
    // The head is a real commit with a CI file: the pipeline guard reads it locally, finds the CI
    // configuration, and so waits for a pipeline that is on its way instead of proving there is none
    writeFileSync(join(glRoot, '.gitlab-ci.yml'), 'test:\n  script: [true]\n');
    git(glRoot, 'add', '.');
    git(glRoot, 'commit', '-q', '-m', 'ci');
    const glHead = git(glRoot, 'rev-parse', 'HEAD');
    BASE.glab.headSha = glHead;
    scenario('glab', { ci: 'none' });
    await api.post('/hosts/refresh');
    const glProject = (await api.post('/projects/import', { path: glRoot, name: 'e2e-merge-gl', template: 'software' })).body;
    check(!!glProject?.id, 'the GitLab project was imported');
    projects.push(glProject.id);
    const waiting = await item(glProject.id, 'Waiting for the pipeline');
    open(glProject.id, waiting, 7, 'gitlab');

    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
      scenario('glab', { ci: 'none' });
      await visit(waiting, `[${theme}] waiting for the pipeline`, '.mg .mg-live');
      const wait = await page.eval(
        `const b = document.querySelector('.mg'); const live = b.querySelector('.mg-live'); return { text: live.textContent, glyph: live.querySelector('.spinner-glyph')?.textContent ?? null, badge: b.querySelector('.badge-active')?.textContent ?? '', rings: b.querySelectorAll('.spinner-ring').length, button: [...b.querySelectorAll('.mg-foot button')].map((x) => ({ text: x.textContent.trim(), disabled: x.disabled })) }`,
      );
      check(wait.text.includes('Waiting for the pipeline') && wait.badge === 'waiting for the pipeline', `[${theme}] the wait is said in words (${wait.badge})`);
      check(!!wait.glyph && /[⠀-⣿]/.test(wait.glyph), `[${theme}] a braille spinner stands beside the verb (${JSON.stringify(wait.glyph)})`);
      check(wait.button.length === 1 && wait.button[0].disabled, `[${theme}] Merge is not offered, only the disabled wait (${JSON.stringify(wait.button)})`);
      // It is the one live thing: it turns at full motion and holds still under reduced motion
      await page.reduceMotion(false);
      const seen = new Set();
      for (let i = 0; i < 12 && seen.size < 2; i++) {
        seen.add(await text('.mg .mg-live .spinner-glyph'));
        await page.sleep(250);
      }
      check(seen.size >= 2, `[${theme}] the spinner turns at full motion (${[...seen]})`);
      await page.reduceMotion(true);
      await page.sleep(300);
      const still = new Set();
      for (let i = 0; i < 4; i++) {
        still.add(await text('.mg .mg-live .spinner-glyph'));
        await page.sleep(250);
      }
      check(still.size === 1, `[${theme}] and holds still under reduced motion (${[...still]})`);
      // Nothing else in the block moves, and under reduced motion not even the live element carries a running animation
      const moving = `return [...document.querySelectorAll('.mg, .mg *')].filter((e) => { const s = getComputedStyle(e); return s.animationName !== 'none' && parseFloat(s.animationDuration) >= 0.05; }).map((e) => e.className)`;
      const reduced = await page.eval(moving);
      check(reduced.length === 0, `[${theme}] no element of the block animates under reduced motion (${JSON.stringify(reduced)})`);
      await page.reduceMotion(false);
      const alone = await page.eval(`return [...document.querySelectorAll('.mg, .mg *')].filter((e) => { const s = getComputedStyle(e); return s.animationName !== 'none' && parseFloat(s.animationDuration) >= 0.05 && !e.closest('.mg-live'); }).map((e) => e.className)`);
      check(alone.length === 0, `[${theme}] at full motion only the live element moves (${JSON.stringify(alone)})`);
      await page.reduceMotion(false);
      check((await surfaces()).inBlock.length === 0, `[${theme}] nothing here claims the gradient while it waits`);
      await page.shot(`merge-item-pipeline-wait-${theme}`);
      await scan(page, check, `the GitLab wait, ${theme}`);
    }

    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    const running = await item(glProject.id, 'Pipeline running');
    open(glProject.id, running, 8, 'gitlab');
    scenario('glab', { ci: 'pending' });
    await visit(running, 'a pipeline running', '.mg .mb-note[data-reason="checks-running"]');
    {
      const acts = await buttons('.mg .mb-acts');
      check(acts.length === 1 && acts[0].primary && /auto-merge|pipeline finishes/i.test(acts[0].text), `with a pipeline running, arming is the action (${JSON.stringify(acts)})`);
      await press('.mg .mb-acts', acts[0].text);
      await page.waitFor(`return (document.querySelector('.mg')?.textContent ?? '').includes('auto-merge on')`, { timeout: 30_000, label: 'the armed GitLab block' });
      const armLine = lines('glab', /^mr merge 8/).find((l) => l.includes('--auto-merge ') || l.endsWith('--auto-merge'));
      check(!!armLine && armLine.includes(`--sha ${glHead}`) && !armLine.includes('--auto-merge=false'), `glab was asked to arm on the head the person saw (${armLine})`);
      check((await text('.mg')).includes('GitLab does not say who or when'), 'the armed block says what GitLab does not tell: who and when');
      await scan(page, check, 'the armed GitLab block');
      await press('.mg', 'Turn off');
      await page.waitFor(`return !!document.querySelector('.mg .mb-note')`, { timeout: 30_000, label: 'the GitLab block after Turn off' });
      check(lines('glab', /cancel_merge_when_pipeline_succeeds/).length === 1, 'glab was asked to cancel the merge when the pipeline succeeds');
    }

    // Update from base: a fast-forward project is rebased on GitLab, and the block reads the result
    const behind = await item(glProject.id, 'Behind the base');
    open(glProject.id, behind, 9, 'gitlab');
    // The checkout has pushed what it has: the branch's remote-tracking ref is where its head is, so a rebase on GitLab
    // loses nothing here (without it Agentry cannot say, and offers its own update instead)
    git(glRoot, 'update-ref', `refs/remotes/origin/task/${behind.key.toLowerCase()}`, 'HEAD');
    scenario('glab', { ci: 'passing', mergeDetail: 'need_rebase' });
    await visit(behind, 'a branch behind its base', '.mg .mb-note[data-reason="behind"]');
    {
      const note = await page.eval(`const n = document.querySelector('.mg .mb-note'); return { word: n.querySelector('.badge')?.textContent.trim(), acts: [...n.querySelectorAll('.mb-acts button, .mb-acts a')].map((b) => b.textContent.trim()) }`);
      check(note.word === 'out of date' && note.acts.join() === 'Rebase on GitLab', `GitLab offers its own rebase, in words (${JSON.stringify(note)})`);
      await page.shot('merge-item-behind-gitlab');
      await scan(page, check, 'the GitLab behind state');
      await press('.mg .mb-note', 'Rebase on GitLab');
      await page.waitFor(`return !!document.querySelector('.mg .mg-foot') && !document.querySelector('.mg .mb-note')`, { timeout: 60_000, label: 'the block after the rebase' });
      check(lines('glab', /^mr rebase 9/).length === 1, 'glab was asked to rebase the merge request');
      // Merge now: auto-merge is always off, and a rebase carries no message
      await press('.mg .mg-foot', 'Merge');
      await page.waitFor(`return !document.querySelector('.mg')`, { timeout: 60_000, label: 'the block after the GitLab merge' });
      const now = lines('glab', /^mr merge 9/)[0] ?? '';
      check(now.includes('--auto-merge=false') && now.includes(`--sha ${glHead}`) && now.includes('-y') && !now.includes('--squash'), `Merge now carries the head and turns glab's auto-merge off (${now})`);
    }

    // ================= 6. The orchestration =================
    writeFileSync(fake.scripts, JSON.stringify({ [MARKER]: `say: Writing the survey\nrun: echo survey > survey.txt` }));
    scenario('gh', { mergeStatus: 'CLEAN' });
    const created = await api.post('/orchestrations', {
      name: 'e2e-merge',
      objective: 'a graph whose branch becomes a pull request that merges',
      cwd: ghRoot,
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
    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    await page.waitFor(`return [...document.querySelectorAll('.card .btn.btn-primary')].some((b) => b.textContent.includes('Push & open PR'))`, { label: 'the push button' });
    {
      const every = await gradients();
      check(every.splits === 1 && every.all.length <= 2 && every.zone.length === 1 && every.zone[0].text.includes('Push & open PR'), `before the push, Push & open PR is the one gradient surface besides the split button: the cost card is plain (${JSON.stringify(every.all)})`);
    }
    await page.click('.card .btn.btn-primary', 'Push & open PR', 400);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the confirmation' });
    await page.click('[role=dialog] .btn-primary', 'Push and open', 600);
    await page.waitFor(`return !!document.querySelector('.omrg .omrg-foot .btn-primary')`, { timeout: 90_000, label: 'the orchestration merge block' });

    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
      await page.goto(`/orchestration/${orchestrationId}`, 1500);
      await page.waitFor(`return !!document.querySelector('.omrg .omrg-foot .btn-primary')`, { timeout: 60_000, label: `[${theme}] the orchestration merge block` });
      const omrg = await page.eval(
        `const b = document.querySelector('.omrg'); return { methods: [...b.querySelectorAll('.segment')].map((s) => s.textContent.trim()), box: !!b.querySelector('[role=checkbox], input[type=checkbox], .check'), subject: !!b.querySelector('input[aria-label="Commit subject"]'), foot: [...b.querySelectorAll('.omrg-foot .btn-primary')].map((x) => x.textContent.trim()), guard: b.querySelector('.omrg-guard')?.textContent ?? '' }`,
      );
      check(omrg.methods.join('|') === 'Squash|Merge commit' && omrg.box && omrg.subject, `[${theme}] the card offers the allowed methods, the branch box and the message (${omrg.methods})`);
      check(omrg.foot.length === 1 && omrg.foot[0].startsWith('Merge') && omrg.guard.includes(HEAD.slice(0, 8)), `[${theme}] Merge is its one gradient action, on the head shown (${omrg.foot} / ${omrg.guard})`);
      const every = await gradients();
      check(every.splits === 1 && every.all.length <= 2 && every.zone.length === 1 && every.zone[0].text.startsWith('Merge'), `[${theme}] the split New chat button counts once, and the Merge button is the only other gradient surface: the cost card and Relaunch are plain (${JSON.stringify(every.all)})`);
      await page.shot(`merge-orchestration-ready-${theme}`);
      await scan(page, check, `the orchestration merge block, ${theme}`);
    }
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    scenario('gh', { mergeStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' });
    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.omrg .omrg-blocked')`, { timeout: 60_000, label: 'the orchestration blocked state' });
    {
      const blocked = await page.eval(`const b = document.querySelector('.omrg .omrg-blocked'); return { text: b.textContent, badge: b.querySelector('.badge')?.textContent.trim() ?? '', merge: [...document.querySelectorAll('.omrg-foot .btn-primary')].length }`);
      check(blocked.badge === 'not approved' && blocked.text.includes('approval') && blocked.merge === 0, `a blocked orchestration says its word and sentence, with no Merge (${JSON.stringify({ badge: blocked.badge, merge: blocked.merge })} ${blocked.text})`);
      await scan(page, check, 'the orchestration blocked state');
    }
    // Every blocker action has a button or a link on the orchestration too, as on the item page
    const orchCr = (await api.get(`/orchestrations/${orchestrationId}`)).body.pullRequest?.id;
    for (const c of CASES) {
      scenario('gh', c.fields);
      if (orchCr) await api.get(`/change-requests/${orchCr}/merge?refresh=1`);
      await page.goto(`/orchestration/${orchestrationId}`, 1500);
      await page.waitFor(`return !!document.querySelector('.omrg .omrg-blocked[data-reason="${c.code}"]')`, { timeout: 60_000, label: `the orchestration's ${c.name} state` });
      const remedy = await page.eval(
        `const b = document.querySelector('.omrg .omrg-blocked'); return { word: b.querySelector('.badge')?.textContent.trim() ?? '', acts: [...b.querySelectorAll('button, a.btn')].map((x) => x.textContent.trim()), merge: document.querySelectorAll('.omrg-foot .btn-primary').length }`,
      );
      check(remedy.word === c.word && remedy.acts.some((a) => a.includes(c.remedy)) && remedy.merge === 0, `[orchestration ${c.name}] the word, and a button or a link for ${c.remedy} (${JSON.stringify(remedy)})`);
    }
    // The notices of the item page are on the orchestration: what Agentry did to auto-merge, and a repository that does not allow it
    if (orchCr) {
      const writer = db();
      writer
        .prepare("INSERT INTO change_request_merges (id, cr_id, action, delete_branch, requested_at, requested_by, outcome, detail) VALUES (?, ?, 'disarm', 0, ?, 'agentry', 'disarmed', 'turned off before Agentry pushed: arm it again afterwards')")
        .run(randomUUID(), orchCr, new Date().toISOString());
      writer.close();
      scenario('gh');
      await api.get(`/change-requests/${orchCr}/merge?refresh=1`);
      await page.goto(`/orchestration/${orchestrationId}`, 1500);
      await page.waitFor(`return !!document.querySelector('.omrg .omrg-foot .btn-primary')`, { timeout: 60_000, label: 'the orchestration block with a disarm on record' });
      const notice = await text('.omrg [role=note]');
      check(notice.includes('turned auto-merge off') && notice.includes('pushed to the branch'), `the orchestration says what Agentry did to auto-merge, as the item page does (${notice})`);
      const cleaner = db();
      cleaner.prepare('DELETE FROM change_request_merges WHERE cr_id = ?').run(orchCr);
      cleaner.close();
    }

    // The head guard here too: the fake host's head moves between the page and the click
    scenario('gh');
    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.omrg .omrg-foot .btn-primary')`, { timeout: 60_000, label: 'the orchestration block again' });
    scenario('gh', { headSha: MOVED });
    const orchBefore = lines('gh', /^pr merge/).length;
    await press('.omrg-foot', 'Merge PR #20');
    await page.waitFor(`return !!document.querySelector('.omrg [role=alert]')`, { timeout: 30_000, label: 'the orchestration refusal' });
    check((await text('.omrg [role=alert]')).includes('Nothing was merged') && lines('gh', /^pr merge/).length === orchBefore, 'a head that moved is refused with its reason and nothing is merged');
    // The refusal is followed by a read: the guard now names the head the host has, and Merge is offered on it again
    await page.waitFor(`return (document.querySelector('.omrg .omrg-guard')?.textContent ?? '').includes('${MOVED.slice(0, 8)}')`, { timeout: 30_000, label: 'the orchestration read again after the refusal' });
    check(lines('gh', /^pr merge/).length === orchBefore, 'the orchestration read the new head again, and still nothing was merged');
    await page.shot('merge-orchestration-head-moved');
    scenario('gh');
    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.omrg .omrg-foot .btn-primary')`, { timeout: 60_000, label: 'the orchestration block on the new head' });
    await press('.omrg-foot', 'Merge PR #20');
    await page.waitFor(`return !document.querySelector('.omrg .omrg-foot .btn-primary') || (document.querySelector('.omrg')?.textContent ?? '').includes('merged')`, { timeout: 60_000, label: 'the orchestration after the merge' });
    // The call reaches the fake a moment after the button is gone: wait for it, not for the page
    for (let tries = 0; tries < 80 && lines('gh', /^pr merge 2/).length === 0; tries++) await page.sleep(250);
    check(lines('gh', /^pr merge 20 .*--match-head-commit a1b2c3d4/).length === 1, `gh was asked to merge the orchestration's pull request on the head shown (${lines('gh', /^pr merge 2/)}) calls: ${calls('gh').slice(-700)}`);

    // ================= 7. A phone =================
    await page.viewport(390, 844);
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    scenario('gh');
    await visit(ready, 'the block on a phone');
    {
      const heights = await page.eval(`return [...document.querySelectorAll('.mg .btn, .mg .segment, .mg .mg-check, .mg input, .mg textarea')].map((e) => Math.round(e.getBoundingClientRect().height))`);
      check(heights.length > 0 && heights.every((h) => h >= 44), `buttons, the method control, the box and the fields are 44 px targets (${heights})`);
      const fonts = await page.eval(`return [...document.querySelectorAll('.mg input, .mg textarea')].map((e) => parseFloat(getComputedStyle(e).fontSize))`);
      check(fonts.every((f) => f >= 16), `inputs are 16 px on a phone (${fonts})`);
      check((await page.eval(`return document.documentElement.scrollWidth - innerWidth`)) <= 1, 'the phone page does not scroll sideways');
      const gradient = await surfaces();
      check(gradient.inBlock.join() === 'Merge' && gradient.outside.length === 0, `on a phone Merge leads and nothing outside the block has the gradient (${JSON.stringify(gradient)})`);
      check(gradient.surfaces.length + gradient.fab <= 2, `the FAB and Merge are at most two gradient surfaces (${JSON.stringify(gradient)})`);
      await page.shot('merge-item-phone');
      await scan(page, check, 'the merge block on a phone');
    }
    scenario('gh', { draft: true });
    await visit(ready, 'a blocked state on a phone', '.mg .mb-note[data-reason="draft"]');
    {
      const heights = await page.eval(`return [...document.querySelectorAll('.mg .mb-acts button, .mg .mb-acts a')].map((e) => Math.round(e.getBoundingClientRect().height))`);
      check(heights.length > 0 && heights.every((h) => h >= 44), `the remedy is a 44 px target (${heights})`);
      await page.shot('merge-item-phone-blocked');
      await scan(page, check, 'a blocked state on a phone');
    }
    await page.eval(`localStorage.setItem('agentry-theme', 'light'); return true`);
    scenario('gh');
    await visit(ready, '[light] the block on a phone');
    await page.shot('merge-item-phone-light');
    await scan(page, check, 'the merge block on a phone, light');
    await page.goto(`/tasks?project=${ghProject.id}`, 1500);
    await page.waitFor(`return !!document.querySelector('[data-item-id]')`, { label: 'the phone board' });
    await scan(page, check, 'the phone board');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    writeFileSync(fake.scripts, '{}');
    for (const file of ['gh.json', 'glab.json', 'gh.merged', 'glab.merged', 'gh.armed', 'glab.armed', 'gh.checks', 'glab.rebased', 'gh.created', 'gh.next', 'gh.merge-body']) rmSync(join(stateDir, file), { force: true });
    await api.post('/hosts/refresh').catch(() => {});
    if (orchestrationId) await api.del(`/orchestrations/${orchestrationId}`).catch(() => {});
    for (const id of chats) await api.del(`/chats/${id}`).catch(() => {});
    for (const id of projects) await api.del(`/projects/${id}`).catch(() => {});
    for (const dir of [ghBare, glBare]) rmSync(dir, { recursive: true, force: true });
  }
};
