// A change request's review, end to end through the fake gh and glab (e2e/fake-hosts): the threads,
// the draft review, the one review that is posted, the reviewers, the address dialog and the review
// block of the item page.
//
// Reference screens: DesktopTareaRevision, DesktopTareaRevisionEnvio, DesktopTareaRevisionEstados,
// MobileTareaRevision*, DSRevision.
//
// 1. A repository whose `origin` is a GitHub project, an item in review with an open PR #7, and the
//    fake gh answering the `threads` scenario (an open thread with a suggestion, a resolved one and an
//    outdated one whose text tries HTML): the routes read them, reply and resolve go to the host and
//    come back re-read, and the reviewers are asked for with the refusals the host gives (the author,
//    an unknown login that exits 0).
// 2. The draft review: notes and a suggestion are saved as rows, one is removed, and Submit posts
//    them as ONE review (a single call, a COMMENT event, the head commit, a suggestion fence).
//    Approving on GitHub is refused, and so is a request for changes; a review of the person's own
//    that is pending on GitHub stops the post with `pending-review-exists`.
// 3. The item page, in both themes: the review block (decision, reviewers, threads), the draft
//    review with "Submit review" as the zone's gradient action while "Work on it" turns neutral, the
//    submit dialog saying approving is done on GitHub, and the address dialog listing the unresolved
//    threads with the host's text drawn as text, never as HTML.
// 4. A phone: the submit form and the address dialog are Sheets, targets are 44 px, nothing scrolls
//    sideways.
// 4b. The features are reachable from a screen, not only from the API. With `review.triage` on (the
//    fake CLI answers it) the address dialog shows the marks and chooses what is marked agent; the
//    unresolved count reads the same in the block, the strip, the dialog, the diff's header and the
//    API; the item's changes page draws the thread under its line, and Reply works from it; a note
//    is added from a line of the diff (inline on a desktop, a Sheet on a phone) and appears in the
//    review block; Submit review sends the three notes as ONE review; a review that stopped half
//    way is still offered Publish / Discard after a reload; and a review fix shows one live surface.
// 5. A GitLab project: the same threads read as discussions, the approval is the person's own call
//    (approve and revoke go through glab), and a request for a reviewer replaces nothing.
//
// What is not covered: starting the address flow (it starts a chat of the project's flow) and the
// GitLab draft-note publish (the core suite covers it against recordings; the partly-posted state
// here is a stored post with a saved review the fake gh lists as pending).
// Axe runs on every screen above, in both themes where the screen is new.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const fakeCli = true;
export const timeout = 300_000;

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const THREAD_OPEN = 'PRRT_kwDOe2e0001';
const THREAD_RESOLVED = 'PRRT_kwDOe2e0002';
const THREAD_OUTDATED = 'PRRT_kwDOe2e0003';
const GITLAB_OPEN = '1111111111111111111111111111111111111111';

/** 20 lines; the item's branch rewrites 12 to 14, where the fake host's threads and the notes sit */
const cartSource = (changed) =>
  Array.from({ length: 20 }, (_, i) => (changed && i >= 11 && i <= 13 ? `export const total${i + 1} = round(${i + 1});` : `export const line${i + 1} = ${i + 1};`)).join('\n') + '\n';

const POINT = 'review.triage';
const unresolvedIn = (text) => Number(/(\d+) unresolved/i.exec(text)?.[1] ?? Number.NaN);

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

export default async ({ page, api, check, dirs }) => {
  const root = join(dirs.workspaceDir, 'e2e-reviews');
  const stateDir = join(dirs.dataDir, 'fake-hosts');
  const read = (file) => (existsSync(join(stateDir, file)) ? readFileSync(join(stateDir, file), 'utf8') : '');
  const calls = (name) => read(`${name}.calls`);
  const scenario = (name, fields) => {
    writeFileSync(join(stateDir, `${name}.json`), JSON.stringify({ reviews: 'threads', headSha: HEAD, ...fields }));
    for (const state of ['threadstate', 'replies', 'requested', 'reviews-posted', 'approved']) rmSync(join(stateDir, `${name}.${state}`), { force: true });
  };
  const db = () => {
    const d = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    d.exec('PRAGMA busy_timeout = 15000');
    return d;
  };
  let projectId = null;
  try {
    // ---- The repository: origin is a GitHub project ----
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'e2e@example.com');
    git(root, 'config', 'user.name', 'e2e');
    writeFileSync(join(root, 'README.md'), '# shop\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'cart.ts'), cartSource(false));
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'first commit');
    git(root, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
    scenario('gh', {});
    await api.post('/hosts/refresh');

    const imported = await api.post('/projects/import', { path: root, name: 'e2e-reviews', template: 'software' });
    check(imported.status === 201, `a project was imported (${imported.status})`);
    projectId = imported.body.id;

    const made = await api.post(`/projects/${projectId}/work-items`, { title: 'Round the cart total', acceptanceCriteria: [{ text: 'It works' }] });
    await api.post(`/work-items/${made.body.id}/move`, { status: 'in_review' });
    const item = made.body;
    const crId = randomUUID();
    {
      const writer = db();
      const now = new Date().toISOString();
      writer
        .prepare(
          `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, url, branch, base, ci, conflicts, approved_at, opened_at, checked_at, created_at, updated_at)
           VALUES (?, ?, ?, 'open', 7, 'https://github.com/acme/shop/pull/7', ?, 'main', 'passing', '[]', ?, ?, ?, ?, ?)`,
        )
        .run(crId, item.id, projectId, `task/${item.key.toLowerCase()}`, now, now, now, now, now);
      writer.prepare("UPDATE work_items SET waiting = 'merge' WHERE id = ?").run(item.id);
      writer.close();
    }

    // ---- 1. Threads, replies, resolves, reviewers ----
    const threads = (await api.get(`/change-requests/${crId}/threads?refresh=1`)).body;
    const byId = new Map((threads.threads ?? []).map((t) => [t.id, t]));
    check(byId.size === 3 && threads.headSha === HEAD, `the host's three threads are read at the head (${byId.size}, ${threads.headSha})`);
    const open = byId.get(THREAD_OPEN);
    check(open && !open.isResolved && !open.isOutdated && open.path === 'src/cart.ts' && open.line === 12, `the open thread sits on src/cart.ts:12 (${JSON.stringify(open && { path: open.path, line: open.line })})`);
    check(open?.comments[0]?.suggestion?.toContent.includes('Math.round'), 'its suggestion is read as lines, not left in the text');
    check(byId.get(THREAD_RESOLVED)?.isResolved === true && byId.get(THREAD_RESOLVED)?.resolvedBy === 'hubot', 'the resolved one says who resolved it');
    const outdated = byId.get(THREAD_OUTDATED);
    check(outdated?.isOutdated === true && outdated.line === null && outdated.originalLine === 20, 'the outdated one has no line now and keeps where it was');
    check(!/<!-- agentry/.test(JSON.stringify(threads)), 'no marker of ours reaches the person');

    const reply = await api.post(`/change-requests/${crId}/threads/${THREAD_OPEN}/reply`, { body: 'Done, rounding half up now.' });
    check(reply.status === 200 && reply.body.comments.length === 2 && reply.body.comments[1].body.startsWith('Done, rounding'), `a reply reaches the host and comes back in the thread (${reply.status})`);
    check(/comments\/5001\/replies/.test(calls('gh')), 'it went to the reply endpoint of the thread root');
    const resolved = await api.post(`/change-requests/${crId}/threads/${THREAD_OPEN}/resolve`);
    check(resolved.status === 200 && resolved.body.isResolved === true, `resolve is the host's, read back (${resolved.status})`);
    const reopened = await api.post(`/change-requests/${crId}/threads/${THREAD_OPEN}/unresolve`);
    check(reopened.status === 200 && reopened.body.isResolved === false, 'and so is reopening');

    const reviewers = (await api.get(`/change-requests/${crId}/reviewers`)).body;
    check(reviewers.decision === 'review-required' && reviewers.unresolvedThreads === 1, `the decision and the unresolved count (an outdated thread is folded, so it is not counted) (${JSON.stringify({ d: reviewers.decision, u: reviewers.unresolvedThreads })})`);
    check(reviewers.reviewers.some((r) => r.login === 'hubot' && r.state === 'commented') && reviewers.reviewers.some((r) => r.login === 'monalisa' && r.state === 'requested'), 'one reviewer commented and one is pending');
    const own = await api.post(`/change-requests/${crId}/reviewers`, { add: ['octocat'] });
    check(own.status === 409 && own.body.code === 'own-change-request', `the author cannot be asked (${own.status} ${own.body.code})`);
    const ghost = await api.post(`/change-requests/${crId}/reviewers`, { add: ['ghost-nobody'] });
    check(ghost.status >= 400 && ghost.body.code === 'not-found', `a login the host ignores is an error, not a silent success (${ghost.status} ${ghost.body.code})`);
    const asked = await api.post(`/change-requests/${crId}/reviewers`, { add: ['dani-lopez'] });
    check(asked.status === 200 && asked.body.reviewers.some((r) => r.login === 'dani-lopez' && r.state === 'requested'), `a real login is added to the list, never replacing it (${asked.status})`);
    check(asked.body.reviewers.some((r) => r.login === 'monalisa'), 'and the ones already there stay');

    // ---- 2. The draft review and the one post ----
    const draft = (body) => api.post(`/change-requests/${crId}/review-drafts`, body);
    const note = await draft({ path: 'src/cart.ts', side: 'right', line: 12, body: 'Check the rounding of a negative total.' });
    const suggestion = await draft({ path: 'src/cart.ts', side: 'right', line: 14, body: '  return Math.round(total * 100) / 100;', suggestion: true });
    const whole = await draft({ body: 'The tests need a case for refunds.' });
    const doomed = await draft({ path: 'README.md', side: 'right', line: 1, body: 'Typo.' });
    check([note, suggestion, whole, doomed].every((r) => r.status === 201), 'a note, a suggestion, a note on the whole PR and one to drop are saved as drafts');
    check((await api.del(`/change-requests/${crId}/review-drafts/${doomed.body.id}`)).status === 200, 'a draft is removed on its own');
    check(calls('gh').includes('/reviews') === false, 'nothing reached the host while the review is a draft');
    check((await api.get(`/change-requests/${crId}/review-drafts`)).body.length === 3, 'three notes wait');

    const withChanges = await api.post(`/change-requests/${crId}/reviews`, { event: 'request-changes', body: 'No.' });
    check(withChanges.status === 409 && withChanges.body.code === 'not-offered', `requesting changes is the host's, never ours (${withChanges.status} ${withChanges.body.code})`);
    const approve = await api.post(`/change-requests/${crId}/reviews`, { event: 'approve', body: '' });
    check(approve.status >= 400, `approving on GitHub is refused (${approve.status})`);
    check((await api.get(`/change-requests/${crId}/review-drafts`)).body.length === 3, 'and the drafts are still there after a refusal');

    scenario('gh', { pendingReview: true });
    const blocked = await api.post(`/change-requests/${crId}/reviews`, { event: 'comment', body: 'Looks good.' });
    check(blocked.status === 409 && blocked.body.code === 'pending-review-exists', `a pending review of the person's own stops the post (${blocked.status} ${blocked.body.code})`);
    check(read('gh.reviews-posted') === '', 'and nothing was sent');
    scenario('gh', {});

    const posted = await api.post(`/change-requests/${crId}/reviews`, { event: 'comment', body: 'Looks good overall.' });
    check(posted.status === 200 && posted.body.state === 'posted', `the review is posted (${posted.status} ${posted.body.state})`);
    check(read('gh.reviews-posted').trim() === '1', 'as ONE request, whatever the number of notes');
    const sent = read('gh.review-1');
    check(sent.includes('"event":"COMMENT"') && sent.includes(`"commit_id":"${HEAD}"`), 'a COMMENT on the head commit the person looked at');
    check(sent.includes('```suggestion') && sent.includes('"path":"src/cart.ts"') && sent.includes('The tests need a case for refunds.'), 'with the suggestion as a fence, the notes on their lines and the general note in the body');
    check((await api.get(`/change-requests/${crId}/review-drafts`)).body.length === 0, 'the drafts are gone once the review is out');

    // ---- 3. The item page ----
    scenario('gh', {});
    await draft({ path: 'src/cart.ts', side: 'right', line: 12, body: 'One more thing on the rounding.' });
    await page.goto('/', 300);
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
      await page.goto(`/tasks/${item.key}`, 1500);
      await page.waitFor(`return !!document.querySelector('.rv')`, { label: `[${theme}] the review block` });
      const block = await page.text('.rv');
      check(/Review/.test(block) && /review required/i.test(block) && /hubot/i.test(block) && /monalisa/i.test(block), `[${theme}] the block names the decision and the reviewers (${block.slice(0, 160)})`);
      check(/\d+ unresolved/i.test(block), `[${theme}] and counts the unresolved threads`);
      check(await page.eval(`return !!document.querySelector('.rv .rv-address')`), `[${theme}] the threads row offers Address with an agent`);
      check(/your review/i.test(block) && /draft/i.test(block), `[${theme}] the draft review is listed`);

      // The zone has one gradient action: Submit review, and the header's Work on it is neutral
      const submit = await page.eval(`const b = document.querySelector('.rv-submit-btn'); return b ? { text: b.textContent, primary: b.classList.contains('btn-primary') } : null`);
      check(submit?.primary === true && /Submit review/.test(submit.text), `[${theme}] "Submit review" is the primary action (${JSON.stringify(submit)})`);
      const work = await page.eval(`const b = document.querySelector('.workitem-work'); return b ? b.classList.contains('btn-primary') : null`);
      check(work === false || work === null, `[${theme}] "Work on it" is neutral while a draft review waits (${work})`);
      // The top bar's split "New chat" is one surface, though it is two buttons
      const gradients = await page.eval(`return [...document.querySelectorAll('.btn-primary:not(.split-btn-more)')].map((b) => (b.className + ' | ' + b.textContent.trim().slice(0, 30)))`);
      check(gradients.length <= 2, `[${theme}] at most two gradient surfaces on the page (${JSON.stringify(gradients)})`);

      // Status colours come with a word
      check(await page.eval(`return [...document.querySelectorAll('.rv .badge')].every((b) => b.textContent.trim().length > 0)`), `[${theme}] every badge has a word`);
      check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the review block`);
      await page.shot(`reviews-item-${theme}`);

      // The submit dialog: comment only, GitHub's own page for the rest
      await page.click('.rv-submit-btn', 'Submit review', 500);
      await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: `[${theme}] the submit dialog` });
      const dialog = await page.text('[role=dialog]');
      check(/Comment sends all the comments at once/.test(dialog) && !/Approve/.test(dialog), `[${theme}] the dialog offers a comment only (${dialog.slice(0, 200)})`);
      // The way to approve is on the page, as the validated prototype has it: the note and a link to the host
      check(/Approving or asking for changes is done on GitHub/i.test(block) && /Open on GitHub/i.test(block), `[${theme}] approving is sent to GitHub (${block.slice(-200)})`);
      check(!/Comment and approve/.test(dialog), `[${theme}] "Comment and approve" is GitLab's alone`);
      check(await page.eval(`return !!document.querySelector('[role=dialog] .rv-send.btn-primary')`), `[${theme}] the dialog's send is its own primary action`);
      check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the submit dialog`);
      await page.shot(`reviews-submit-${theme}`);
      await page.key('Escape');
      await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: `[${theme}] the dialog closes` });

      // The address dialog: the unresolved threads, the host's words as text
      await page.waitFor(`return !!document.querySelector('.item-pr-wait.is-address')`, { label: `[${theme}] the address strip` });
      const strip = await page.text('.item-pr-wait.is-address');
      check(/1 review thread waits for an answer/.test(strip), `[${theme}] the strip counts what waits, an outdated thread not among them (${strip})`);
      await page.click('.item-pr-wait.is-address .btn', 'Address with an agent', 500);
      await page.waitFor(`return !!document.querySelector('[role=dialog] .addr-list')`, { label: `[${theme}] the address dialog` });
      const address = await page.text('[role=dialog]');
      check(/Unresolved threads · 1/i.test(address) && !/outdated/i.test(address) && /src\/cart\.ts/.test(address), `[${theme}] it lists the unresolved threads, the outdated one not (${address.replace(/\s+/g, ' ').slice(0, 700)})`);
      check(/These comments are other people's/.test(address) && /Nothing is answered or resolved/.test(address), `[${theme}] and warns whose words they are and what it will not do`);
      // Nothing is chosen until the person chooses (or `review.triage` marks), as the validated prototype has it
      check(/0 of 1 chosen/.test(address) && /Address 0 comments/.test(address), `[${theme}] nothing is chosen beforehand (${address.replace(/\s+/g, ' ').slice(-120)})`);
      await page.eval(`document.querySelectorAll('[role=dialog] .addr-thread')[0].click(); return true`);
      await page.sleep(250);
      const chosen = await page.text('[role=dialog]');
      check(/Address 1 comment/.test(chosen), `[${theme}] with the count in its action once they are chosen (${chosen.replace(/\s+/g, ' ').slice(-120)})`);
      check(await page.eval(`return !document.querySelector('[role=dialog] img') && window.__pwned !== 1`), `[${theme}] a host's HTML is text: no element came of it`);
      check(!/Resolved|README/.test(address), `[${theme}] the resolved thread is not offered`);
      check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the address dialog`);
      await page.shot(`reviews-address-${theme}`);
      await page.key('Escape');
      await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: `[${theme}] the dialog closes` });
    }

    // ---- 4. A phone ----
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    await page.viewport(390, 844);
    await page.goto(`/tasks/${item.key}`, 1500);
    await page.waitFor(`return !!document.querySelector('.rv-submit-btn')`, { label: 'the review block on a phone' });
    check((await page.eval(`return document.documentElement.scrollWidth - innerWidth`)) <= 0, 'the phone page does not scroll sideways');
    const target = await page.eval(`return document.querySelector('.rv-submit-btn').getBoundingClientRect().height`);
    check(target >= 44, `Submit review is a 44 px target (${target})`);
    await page.shot('reviews-item-phone');
    await scan(page, check, 'the review block on a phone');
    await page.click('.rv-submit-btn', 'Submit review', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the submit sheet' });
    check(await page.eval(`const d = document.querySelector('[role=dialog]'); const r = d.getBoundingClientRect(); return r.width <= innerWidth && r.bottom >= innerHeight - 1`), 'the submit form is a Sheet from the bottom edge');
    const sendHeight = await page.eval(`return document.querySelector('[role=dialog] .rv-send').getBoundingClientRect().height`);
    check(sendHeight >= 44, `its send is a 44 px target (${sendHeight})`);
    check(await page.eval(`return [...document.querySelectorAll('[role=dialog] textarea, [role=dialog] input')].every((el) => parseFloat(getComputedStyle(el).fontSize) >= 16)`), 'and its inputs are 16 px');
    await page.shot('reviews-submit-phone');
    await scan(page, check, 'the submit sheet on a phone');
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the sheet closes' });
    await page.click('.item-pr-wait.is-address .btn', 'Address with an agent', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .addr-list')`, { label: 'the address sheet' });
    check(await page.eval(`return [...document.querySelectorAll('[role=dialog] .addr-list [role=checkbox], [role=dialog] .addr-list button')].every((el) => el.getBoundingClientRect().height >= 44)`), 'the address rows are 44 px targets');
    check(await page.eval(`return !document.querySelector('[role=dialog] .addr-list input[type=checkbox]')`), 'with no always-visible native checkbox');
    await page.shot('reviews-address-phone');
    await scan(page, check, 'the address sheet on a phone');
    await page.key('Escape');
    await page.viewport(1440, 900);

    // ---- 4b. Reachable from a screen ----
    const branch = `task/${item.key.toLowerCase()}`;
    git(root, 'checkout', '-q', '-b', branch);
    writeFileSync(join(root, 'src', 'cart.ts'), cartSource(true));
    git(root, 'commit', '-q', '-am', 'round the total');
    git(root, 'checkout', '-q', 'main');
    {
      const writer = db();
      writer.prepare('UPDATE work_items SET branch = ? WHERE id = ?').run(branch, item.id);
      writer.close();
    }
    const setTheme = (theme) => page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
    const changesUrl = `/tasks/${item.key}/changes?file=${encodeURIComponent('src/cart.ts')}&mode=unified`;
    const unresolvedNow = async () => (await api.get(`/change-requests/${crId}/reviewers`)).body.unresolvedThreads;
    await api.del('/decisions').catch(() => {});
    scenario('gh', {});

    // review.triage on: the fake CLI marks the first open thread `agent` and the rest `person`
    const triageInfo = (await api.get('/decisions/points')).body.find((p) => p.id === POINT);
    check(Boolean(triageInfo), 'review.triage is a decision point of the build');
    const triageSettings = async (mode) => {
      const { jev, ...rest } = (await api.get('/decisions/settings')).body;
      await api.put('/decisions/settings', { ...rest, points: { ...rest.points, [POINT]: { mode, threshold: triageInfo.defaultThreshold, consent: null } } });
    };
    const triageOff = async () => {
      await api.put(`/decisions/points/${POINT}/consent`, { granted: false, stateVersion: triageInfo.stateVersion, providers: [] });
      await triageSettings('off');
    };
    await api.put(`/decisions/points/${POINT}/consent`, { granted: true, stateVersion: triageInfo.stateVersion, providers: ['cli'] });
    await triageSettings('shadow');
    try {
      await api.get(`/change-requests/${crId}/threads?refresh=1`);
      for (const end = Date.now() + 40_000; Date.now() < end; ) {
        if ((await api.get(`/decisions?point=${POINT}`)).body?.items?.length) break;
        await page.sleep(300);
      }
      const answered = (await api.get(`/decisions?point=${POINT}`)).body?.items?.[0];
      check(answered?.answers?.[THREAD_OPEN]?.value === 'agent', `review.triage was asked for the open threads and marked the first one agent (${JSON.stringify(answered?.answers)})`);

      for (const theme of ['dark', 'light']) {
        await setTheme(theme);
        await page.goto(`/tasks/${item.key}`, 1500);
        await page.waitFor(`return !!document.querySelector('.rv')`, { label: `[${theme}] the review block (triage)` });
        // The same count before the threads load (the block has the reviewers' number) and after
        const early = unresolvedIn(await page.text('.rv'));
        await page.waitFor(`return !!document.querySelector('.item-pr-wait.is-address')`, { label: `[${theme}] the address strip (triage)` });
        const late = unresolvedIn(await page.text('.rv'));
        const stripCount = Number(/(\d+) review thread/.exec(await page.text('.item-pr-wait.is-address'))?.[1] ?? Number.NaN);
        const apiCount = await unresolvedNow();
        check(early === late && late === stripCount && stripCount === apiCount && apiCount === 1, `[${theme}] one unresolved count everywhere, before and after the threads load (${early}, ${late}, strip ${stripCount}, api ${apiCount})`);
        await page.click('.item-pr-wait.is-address .btn', 'Address with an agent', 500);
        await page.waitFor(`return !!document.querySelector('[role=dialog] .addr-list')`, { label: `[${theme}] the address dialog (triage)` });
        const marked = await page.text('[role=dialog]');
        check(/review\.triage/.test(marked) && /1 of 1 chosen/.test(marked) && /Address 1 comment/.test(marked), `[${theme}] the point's marks are shown and what it marked agent is chosen (${marked.replace(/\s+/g, ' ').slice(-220)})`);
        check(await page.eval(`return !!document.querySelector('[role=dialog] .decided-face') && document.querySelector('[role=dialog] .addr-thread')?.getAttribute('aria-pressed') === 'true'`), `[${theme}] the marked thread is the chosen one`);
        check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the address dialog with marks`);
        await page.shot(`reviews-address-triage-${theme}`);
        await page.key('Escape');
        await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: `[${theme}] the dialog closes (triage)` });
      }
    } finally {
      await triageOff().catch(() => {});
      await api.del('/decisions').catch(() => {});
    }

    // The item's changes page: the thread under its line, Reply from it, a note from a line
    await setTheme('dark');
    await page.goto(changesUrl, 1500);
    await page.waitFor(`return !!document.querySelector('.changes-review .diff .rt.open')`, { label: 'the thread under its line in the diff' });
    const card = await page.eval(`const c = document.querySelector('.changes-review .diff .rt.open'); return { label: c.getAttribute('aria-label'), text: c.textContent, inDiff: !!c.closest('.diff') }`);
    check(card.inDiff && /cart\.ts:12/.test(card.label) && /Round half up here/.test(card.text), `the open thread is drawn in the diff on src/cart.ts:12 (${card.label})`);
    check(/Math\.round/.test(card.text), 'with its suggestion drawn as lines');
    check(await page.eval(`return !document.querySelector('.changes-review img') && window.__pwned !== 1`), "a host's HTML in an outdated thread is text here too");
    const chip = await page.eval(`return document.querySelector('.changes-threads-chip')?.textContent ?? ''`);
    check(unresolvedIn(chip) === 1, `the diff's header counts the same unresolved threads (${chip})`);

    await page.fill('.rt.open .rt-foot input', 'Fixed, thanks.');
    await page.click('.rt.open .rt-foot button[type=submit]', 'Reply', 600);
    await page.waitFor(`return document.querySelector('.rt.open')?.textContent.includes('Fixed, thanks.')`, { label: 'the reply comes back in the thread' });
    check(/comments\/5001\/replies/.test(calls('gh')) && /Fixed, thanks\./.test(read('gh.replies')), 'Reply from the diff reached the host');
    await page.click('.rt.open .rt-foot button[type=button]', 'Resolve', 800);
    for (const end = Date.now() + 15_000; Date.now() < end && !new RegExp(`${THREAD_OPEN} resolved`).test(read('gh.threadstate')); ) await page.sleep(250);
    check(new RegExp(`${THREAD_OPEN} resolved`).test(read('gh.threadstate')), 'Resolve from the diff reached the host, and only by that click');
    await api.post(`/change-requests/${crId}/threads/${THREAD_OPEN}/unresolve`);

    // A note from the line's gutter, inline on a desktop
    await page.goto(changesUrl, 1500);
    await page.waitFor(`return !!document.querySelector('.diff-add-note[aria-label="Add a note on line 13"]')`, { label: 'the add-note button on line 13' });
    await page.click('.diff-add-note[aria-label="Add a note on line 13"]', undefined, 400);
    await page.waitFor(`return !!document.querySelector('.changes-review .diff .rc')`, { label: 'the composer under the line' });
    await page.fill('.rc .rc-note', 'Please name this total.');
    await page.click('.rc .rc-foot .btn-primary', 'Add to the review', 700);
    await page.waitFor(`return !!document.querySelector('.changes-review .diff .rt.draft')`, { label: 'the note is drawn under its line' });
    check(read('gh.reviews-posted') === '', 'a note in the diff reaches nothing: it is saved as a draft');
    check((await api.get(`/change-requests/${crId}/review-drafts`)).body.length === 2, 'the note is a second draft of the review');
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await page.goto(changesUrl, 1500);
      await page.waitFor(`return !!document.querySelector('.changes-review .diff .rt.open') && !!document.querySelector('.changes-review .diff .rt.draft')`, { label: `[${theme}] a thread and a note in the diff` });
      check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the changes page with a thread and a note`);
      await page.shot(`reviews-changes-${theme}`);
      await page.click('.diff-add-note[aria-label="Add a note on line 15"]', undefined, 400);
      await page.waitFor(`return !!document.querySelector('.changes-review .diff .rc')`, { label: `[${theme}] the composer` });
      check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the composer`);
      await page.shot(`reviews-composer-${theme}`);
      await page.click('.rc .rc-foot .btn-ghost', 'Cancel', 400);
    }

    // The same from a phone: the composer and the reply are Sheets
    await setTheme('dark');
    await page.viewport(390, 844);
    await page.goto(changesUrl, 1500);
    await page.waitFor(`return !!document.querySelector('.diff-add-note[aria-label="Add a note on line 14"]')`, { label: 'the add-note button on a phone' });
    await page.click('.diff-add-note[aria-label="Add a note on line 14"]', undefined, 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .rc-note')`, { label: 'the note Sheet' });
    check(await page.eval(`const d = document.querySelector('[role=dialog]'); const r = d.getBoundingClientRect(); return r.width <= innerWidth && r.bottom >= innerHeight - 1`), 'the note form is a Sheet from the bottom edge');
    check(await page.eval(`return [...document.querySelectorAll('[role=dialog] .rc-foot .btn')].every((b) => b.getBoundingClientRect().height >= 44) && [...document.querySelectorAll('[role=dialog] textarea')].every((el) => parseFloat(getComputedStyle(el).fontSize) >= 16)`), 'its buttons are 44 px targets and its inputs 16 px');
    await scan(page, check, 'the note Sheet on a phone');
    await page.shot('reviews-composer-phone');
    await page.fill('[role=dialog] .rc-note', 'And a test for it.');
    await page.click('[role=dialog] .rc-foot .btn-primary', 'Add to the review', 800);
    await page.waitFor(`return !document.querySelector('[role=dialog]') && !!document.querySelector('.changes-review .diff .rt.draft')`, { label: 'the Sheet closes and the note is drawn' });
    check((await api.get(`/change-requests/${crId}/review-drafts`)).body.length === 3, 'the phone note is the third draft');
    await page.click('.rt.open .rt-foot .btn', 'Reply', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] textarea')`, { label: 'the reply Sheet' });
    await page.fill('[role=dialog] textarea', 'On it.');
    await page.click('[role=dialog] button[type=submit]', 'Reply', 800);
    await page.waitFor(`return /On it\\./.test(document.querySelector('.rt.open')?.textContent ?? '')`, { label: 'the phone reply comes back' });
    await scan(page, check, 'the changes page on a phone');
    await page.shot('reviews-changes-phone');
    await page.viewport(1440, 900);

    // The notes are in the review block, and Submit review sends ONE review
    await page.goto(`/tasks/${item.key}`, 1500);
    await page.waitFor(`return !!document.querySelector('.rv-submit-btn')`, { label: 'the review block with three notes' });
    check(/3 comments/.test(await page.text('.rv')), `the three notes show in the review block (${(await page.text('.rv-draft')).replace(/\s+/g, ' ').slice(0, 160)})`);
    await page.click('.rv-submit-btn', 'Submit review', 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .rv-send')`, { label: 'the submit dialog (three notes)' });
    await page.fill('[role=dialog] textarea', 'Reviewed from the diff.');
    await page.click('[role=dialog] .rv-send', undefined, 800);
    for (const end = Date.now() + 20_000; Date.now() < end && read('gh.reviews-posted').trim() !== '1'; ) await page.sleep(250);
    check(read('gh.reviews-posted').trim() === '1', `Submit review posted ONE review (${read('gh.reviews-posted').trim()})`);
    const oneReview = read('gh.review-1');
    check(oneReview.includes('"event":"COMMENT"') && oneReview.includes(`"commit_id":"${HEAD}"`) && (oneReview.match(/"path":"src\/cart\.ts"/g) ?? []).length === 3, 'with the three notes of the diff, a COMMENT on the head the person looked at');
    check(oneReview.includes('Please name this total.') && oneReview.includes('And a test for it.') && oneReview.includes('Reviewed from the diff.'), 'and the words the person wrote');
    await page.waitFor(`return !document.querySelector('.rv-submit-btn')`, { label: 'the draft is gone from the block' });
    check((await api.get(`/change-requests/${crId}/review-drafts`)).body.length === 0, 'no draft is left once it is out');

    // A review that stopped half way is still offered Publish / Discard after a reload
    scenario('gh', { pendingReview: true });
    const partlyId = randomUUID();
    {
      const writer = db();
      const at = new Date().toISOString();
      writer
        .prepare('INSERT INTO review_posts (id, cr_id, marker, event, state, remote_id, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)')
        .run(partlyId, crId, '<!-- agentry:e2e-partly -->', 'comment', 'partly', JSON.stringify({ code: 'review-partly-posted', detail: '', saved: 1, total: 2, draftIds: ['8001'] }), at, at);
      writer.close();
    }
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      for (const visit of ['first load', 'after a reload']) {
        await page.goto(`/tasks/${item.key}`, 1500);
        await page.waitFor(`return !!document.querySelector('.rv-draft .rv-foot')`, { label: `[${theme}] the partly sent review (${visit})` });
        const partly = await page.text('.rv-draft');
        check(/partly sent/i.test(partly) && /Some comments were saved as drafts on GitHub/.test(partly) && /1 saved comment still waits on GitHub/.test(partly), `[${theme}] the block says what stopped (${visit}) (${partly.replace(/\s+/g, ' ').slice(0, 220)})`);
        const buttons = await page.eval(`return [...document.querySelectorAll('.rv-draft .rv-foot .btn')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, primary: b.classList.contains('btn-primary') }))`);
        check(buttons.some((b) => b.text === 'Publish the saved' && !b.disabled && b.primary) && buttons.some((b) => b.text === 'Discard the saved' && !b.disabled), `[${theme}] Publish the saved and Discard the saved are offered (${visit}) (${JSON.stringify(buttons)})`);
        check(await page.eval(`return !document.querySelector('.rv-submit-btn')`), `[${theme}] and Submit review is not, a second post would double the comments (${visit})`);
      }
      check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the partly sent review`);
      await page.shot(`reviews-partly-${theme}`);
    }
    {
      const writer = db();
      writer.prepare('DELETE FROM review_posts WHERE id = ?').run(partlyId);
      writer.close();
    }
    scenario('gh', {});

    // A review fix is ONE live surface: the review block's, not the checks' as well
    {
      const writer = db();
      writer.prepare("UPDATE work_item_pull_requests SET fix_state = 'fixing', fix_kind = 'review', fix_origin = 'person', fix_attempts = 1, fix_head = ? WHERE id = ?").run(HEAD, crId);
      writer.close();
    }
    try {
      for (const theme of ['dark', 'light']) {
        await setTheme(theme);
        await page.goto(`/tasks/${item.key}`, 1500);
        await page.waitFor(`return !!document.querySelector('.check-fix')`, { label: `[${theme}] the review fix` });
        const live = await page.eval(`return [...document.querySelectorAll('.check-fix')].map((f) => ({ label: f.getAttribute('aria-label'), live: f.classList.contains('live-rail') }))`);
        check(live.length === 1 && live[0].label === 'Comments under way' && live[0].live === true, `[${theme}] a review fix draws one live surface, the review's (${JSON.stringify(live)})`);
        check(await page.eval(`return !document.querySelector('.workitem-fix-checks') && !document.querySelector('.item-pr-wait.is-address')`), `[${theme}] with no checks fix action and no second offer to address`);
        check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the item with a review fix`);
        await page.shot(`reviews-fix-${theme}`);
      }
      await setTheme('dark');
      await page.goto(`/tasks?project=${projectId}`, 1500);
      await page.waitFor(`return !!document.querySelector('[data-item-id="${item.id}"] .workitem-strip')`, { label: 'the board strip of the review fix' });
      const strip = await page.text(`[data-item-id="${item.id}"] .workitem-strip`);
      check(/addressing the comments/i.test(strip), `the board strip says the comments are being addressed (${strip})`);
    } finally {
      const writer = db();
      writer.prepare('UPDATE work_item_pull_requests SET fix_state = NULL, fix_kind = NULL, fix_origin = NULL, fix_attempts = 0, fix_head = NULL WHERE id = ?').run(crId);
      writer.close();
    }

    // ---- 5. A GitLab project: discussions, and the approval is a call of its own ----
    const gitlabRoot = join(dirs.workspaceDir, 'e2e-reviews-gitlab');
    rmSync(gitlabRoot, { recursive: true, force: true });
    mkdirSync(gitlabRoot, { recursive: true });
    git(gitlabRoot, 'init', '-q', '-b', 'main');
    git(gitlabRoot, 'config', 'user.email', 'e2e@example.com');
    git(gitlabRoot, 'config', 'user.name', 'e2e');
    writeFileSync(join(gitlabRoot, 'README.md'), '# shop\n');
    git(gitlabRoot, 'add', '.');
    git(gitlabRoot, 'commit', '-q', '-m', 'first commit');
    git(gitlabRoot, 'remote', 'add', 'origin', 'https://gitlab.com/acme/shop.git');
    scenario('glab', {});
    await api.post('/hosts/refresh');
    const lab = await api.post('/projects/import', { path: gitlabRoot, name: 'e2e-reviews-gitlab', template: 'software' });
    check(lab.status === 201, `a GitLab project was imported (${lab.status})`);
    const labProject = lab.body.id;
    try {
      const labItem = (await api.post(`/projects/${labProject}/work-items`, { title: 'Round the cart total on GitLab', acceptanceCriteria: [{ text: 'It works' }] })).body;
      await api.post(`/work-items/${labItem.id}/move`, { status: 'in_review' });
      const mrId = randomUUID();
      {
        const writer = db();
        const now = new Date().toISOString();
        writer
          .prepare(
            `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, url, branch, base, ci, conflicts, approved_at, opened_at, checked_at, created_at, updated_at, host, hostname)
             VALUES (?, ?, ?, 'open', 7, 'https://gitlab.com/acme/shop/-/merge_requests/7', ?, 'main', 'passing', '[]', ?, ?, ?, ?, ?, 'gitlab', 'gitlab.com')`,
          )
          .run(mrId, labItem.id, labProject, `task/${labItem.key.toLowerCase()}`, now, now, now, now, now);
        writer.prepare("UPDATE work_items SET waiting = 'merge' WHERE id = ?").run(labItem.id);
        writer.close();
      }
      const labThreads = (await api.get(`/change-requests/${mrId}/threads?refresh=1`)).body;
      const labById = new Map((labThreads.threads ?? []).map((t) => [t.id, t]));
      check(labById.size === 3, `GitLab's discussions are read as threads (${labById.size} ${JSON.stringify(labThreads).slice(0, 300)} | ${calls('glab').slice(-600)})`);
      check(labById.get(GITLAB_OPEN)?.comments[0]?.suggestion?.toContent.includes('Math.round') && labById.get(GITLAB_OPEN)?.comments[0]?.suggestion?.fromContent !== null, 'a GitLab suggestion carries the line it replaces');
      check(labById.get('3333333333333333333333333333333333333333')?.isOutdated === true, 'a note left on another commit than the head is outdated');
      const labReply = await api.post(`/change-requests/${mrId}/threads/${GITLAB_OPEN}/reply`, { body: 'Fixed.' });
      check(labReply.status === 200 && labReply.body.comments.length === 2, `a reply is a note on the discussion (${labReply.status})`);
      const labResolve = await api.post(`/change-requests/${mrId}/threads/${GITLAB_OPEN}/resolve`);
      check(labResolve.status === 200 && labResolve.body.isResolved === true && /mr note resolve 7 1{40}/.test(calls('glab')), `resolving goes through glab (${labResolve.status})`);

      let approval = (await api.get(`/change-requests/${mrId}/approval`)).body;
      check(approval.viewerHasApproved === false && approval.canApprove === true && approval.approvalsRequired === 1, `the rule wants one approval and the person has not given it (${JSON.stringify(approval)})`);
      approval = (await api.post(`/change-requests/${mrId}/approval`, { sha: HEAD })).body;
      check(approval.viewerHasApproved === true && /mr approve 7 --sha a1b2c3d4/.test(calls('glab')), 'approving is pinned to the head the person looked at');
      approval = (await api.del(`/change-requests/${mrId}/approval`)).body;
      check(approval.viewerHasApproved === false && /mr revoke 7/.test(calls('glab')), 'and it is revoked the same way');
      const labReviewers = await api.post(`/change-requests/${mrId}/reviewers`, { add: ['dani.lopez'] });
      check(labReviewers.status === 200 && /--reviewer=\+dani\.lopez/.test(calls('glab')) && labReviewers.body.reviewers.some((r) => r.login === 'monalisa'), 'a reviewer is added with +name, so the list is not replaced');

      // The page shows the person's approval, so it is given again after the revoke above
      approval = (await api.post(`/change-requests/${mrId}/approval`, { sha: HEAD })).body;
      check(approval.viewerHasApproved === true, 'the person approves again for the page to show it');

      for (const theme of ['dark', 'light']) {
        await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
        await page.goto(`/tasks/${labItem.key}`, 1500);
        await page.waitFor(`return !!document.querySelector('.rv')`, { label: `[${theme}] the review block on a merge request` });
        const text = await page.text('.rv');
        check(/your approval/i.test(text) && !/github/i.test(text), `[${theme}] a merge request shows the person's approval and never GitHub's words (${text.replace(/\s+/g, " ").slice(0, 600)})`);
        check((await page.axe()).length === 0, `[${theme}] axe finds nothing on a merge request's review`);
        await page.shot(`reviews-gitlab-${theme}`);
      }
    } finally {
      await api.del(`/projects/${labProject}`).catch(() => {});
      rmSync(gitlabRoot, { recursive: true, force: true });
    }
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    for (const name of ['gh', 'glab']) {
      for (const file of ['json', 'threadstate', 'replies', 'requested', 'reviews-posted', 'review-1', 'approved']) rmSync(join(stateDir, `${name}.${file}`), { force: true });
    }
    await api.post('/hosts/refresh').catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
