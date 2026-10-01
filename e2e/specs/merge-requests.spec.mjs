// A GitLab project's merge requests, end to end through the fake glab (e2e/fake-hosts): the words,
// the numbers and the remedies are the host's own, never GitHub's.
//
// Reference screens: DesktopTableroMR, DesktopTareaMR, MobileTareaMR and DesktopOrquestacionMR*.
//
// 1. A repository whose `origin` is a gitlab.com project: readiness says GitLab, glab and ready.
// 2. Its items in every merge request state, written straight into the database as the watcher would
//    leave them (a GitLab row carries `host = 'gitlab'`): the board strip and the item page say
//    "MR !7", name GitLab, and link to its merge request. Nothing here reaches GitHub's words.
// 3. glab signed out: the project cannot open merge requests, and the note says which CLI and host,
//    with a link to the vendor's sign-in page instead of a command.
// 4. An orchestration on that project, run on the fake claude with a worktree per task: once it is
//    integrated, "Push & open MR" confirms, pushes (to a local bare repository, through git's
//    `pushInsteadOf`, so nothing leaves the machine), asks the fake glab for the merge request and
//    shows "Open merge request !7 on GitLab".
//
// What is not covered: approving an item into a merge request through its own flow (the push and
// `mr create` of a work item), which needs a verified run of the flow; the core suite covers it
// against the same fake.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const fakeCli = true;
export const timeout = 240_000;

const ORIGIN = 'https://gitlab.com/acme/shop.git';
const MR_URL = (n) => `https://gitlab.com/acme/shop/-/merge_requests/${n}`;
const MARKER = 'e2e-mr-survey-task';
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
  const root = join(dirs.workspaceDir, 'e2e-merge-requests');
  const bare = join(dirs.workspaceDir, 'e2e-merge-requests-origin.git');
  const stateDir = join(dirs.dataDir, 'fake-hosts');
  const calls = () => {
    try {
      return readFileSync(join(stateDir, 'glab.calls'), 'utf8');
    } catch {
      return '';
    }
  };
  let projectId = null;
  let orchestrationId = null;
  const chats = [];
  try {
    // ---- The repository: origin is a GitLab project, and pushes go to a local bare one ----
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
    git(root, 'remote', 'add', 'origin', ORIGIN);
    git(root, 'config', `url.${bare}.pushInsteadOf`, ORIGIN);
    git(root, 'push', '-q', bare, 'main');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'glab.json'), '{}');
    await api.post('/hosts/refresh');

    const imported = await api.post('/projects/import', { path: root, name: 'e2e-merge-requests', template: 'software' });
    check(imported.status === 201, `a project was imported (${imported.status})`);
    projectId = imported.body.id;

    // ---- Readiness: GitLab, through glab ----
    const ready = (await api.get(`/projects/${projectId}/code-host`)).body;
    check(ready.readiness?.status === 'ready' && ready.readiness.host === 'gitlab' && ready.readiness.hostname === 'gitlab.com', `the project is ready on GitLab (${JSON.stringify(ready.readiness)})`);
    check(ready.remote?.path === 'acme/shop', `its origin is parsed to a path (${JSON.stringify(ready.remote)})`);

    // ---- Items with a merge request in every state ----
    const add = async (title, status = 'in_review') => {
      const made = await api.post(`/projects/${projectId}/work-items`, { title, acceptanceCriteria: [{ text: 'It works' }] });
      await api.post(`/work-items/${made.body.id}/move`, { status });
      return made.body;
    };
    const open = await add('MR with green checks');
    const pending = await add('MR with checks running');
    const closed = await add('MR closed unmerged');
    const failed = await add('MR that failed to open');
    const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    db.exec('PRAGMA busy_timeout = 15000');
    const now = new Date().toISOString();
    const row = (item, fields) => {
      const r = { phase: 'open', number: null, url: null, ci: null, error_code: null, error_detail: null, opened_at: null, closed_at: null, checked_at: null, ...fields };
      db.prepare(
        `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, url, branch, base, ci, conflicts, error_code, error_detail, approved_at, opened_at, closed_at, checked_at, created_at, updated_at, host, hostname)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'main', ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, 'gitlab', 'gitlab.com')`,
      ).run(randomUUID(), item.id, projectId, r.phase, r.number, r.url, `task/${item.key.toLowerCase()}`, r.ci, r.error_code, r.error_detail, now, r.opened_at, r.closed_at, r.checked_at, now, now);
    };
    row(open, { number: 7, url: MR_URL(7), ci: 'passing', opened_at: now, checked_at: now });
    row(pending, { number: 8, url: MR_URL(8), ci: 'pending', opened_at: now, checked_at: now });
    row(closed, { phase: 'closed', number: 9, url: MR_URL(9), closed_at: now });
    row(failed, { phase: 'failed', error_code: 'create', error_detail: 'glab: 500 Internal Server Error' });
    for (const item of [open, pending]) db.prepare("UPDATE work_items SET waiting = 'merge' WHERE id = ?").run(item.id);
    for (const item of [closed, failed]) db.prepare("UPDATE work_items SET waiting = 'approval' WHERE id = ?").run(item.id);
    db.close();

    await page.goto('/', 300);
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('agentry-theme', '${theme}'); return true`);
      await page.goto(`/tasks?project=${projectId}`, 1500);
      await page.waitFor(`return !!document.querySelector('${card(open.id)}')`, { label: `[${theme}] the open MR's strip` });
      const strip = (item) => page.eval(`const s = document.querySelector('${card(item.id)}'); return s ? { text: s.textContent, ci: s.querySelector('.pr-ci')?.dataset.ci ?? null, link: s.querySelector('a[href^="https://gitlab.com"]')?.getAttribute('href') ?? null } : null`);
      const green = await strip(open);
      check(green?.text.includes('!7') && green.ci === 'passing', `[${theme}] an open MR says "!7" and its CI (${JSON.stringify(green)})`);
      check(!/#7|GitHub|\bPR\b/.test(green?.text ?? ''), `[${theme}] and nothing of GitHub's words (${green?.text})`);
      check(green?.link === MR_URL(7), `[${theme}] the strip links to the merge request (${green?.link})`);
      check((await strip(pending))?.text.includes('!8'), `[${theme}] a second MR reads "!8"`);
      check((await strip(closed))?.text.includes('!9'), `[${theme}] a closed MR names its number`);
      const broke = await page.eval(`return document.querySelector('${card(failed.id)}')?.textContent ?? ''`);
      check(broke.includes('MR') && !broke.includes('PR'), `[${theme}] a failure says MR (${broke})`);
      check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the board with MR states`);
      await page.shot(`merge-requests-board-${theme}`);

      await page.goto(`/tasks/${open.key}`, 1500);
      await page.waitFor(`return !!document.querySelector('.item-pr')`, { label: `[${theme}] the MR row under Changes` });
      const rowText = await page.eval(`const r = document.querySelector('.item-pr'); return { href: r.getAttribute('href'), text: r.textContent }`);
      check(rowText.href === MR_URL(7) && rowText.text.includes('!7') && rowText.text.includes('MR'), `[${theme}] the item's row is the MR (${JSON.stringify(rowText)})`);
      const panel = await page.eval(`return document.querySelector('.item-pr-wait')?.textContent ?? ''`);
      check(!panel.includes('GitHub') && !/\bPR\b/.test(panel), `[${theme}] the waiting panel never says GitHub or PR (${panel})`);
      check((await page.axe()).length === 0, `[${theme}] axe finds nothing on the item with an open MR`);
      await page.shot(`merge-requests-item-${theme}`);
    }

    // ---- The same item on a phone ----
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    await page.viewport(390, 844);
    await page.goto(`/tasks/${open.key}`, 1500);
    await page.waitFor(`return !!document.querySelector('.item-pr-wait')`, { label: 'the MR panel on a phone' });
    check((await page.eval(`return document.documentElement.scrollWidth - innerWidth`)) <= 0, 'the phone page does not scroll sideways');
    await page.shot('merge-requests-item-phone');
    await scan(page, check, 'the item with an open MR on a phone');
    await page.viewport(1440, 900);

    // ---- glab signed out: the note names the CLI and the host, and links the vendor's page ----
    writeFileSync(join(stateDir, 'glab.json'), JSON.stringify({ signedIn: false }));
    await api.post('/hosts/refresh');
    const blocked = (await api.get(`/projects/${projectId}/code-host`)).body;
    check(blocked.readiness?.status === 'cli-signed-out' && blocked.readiness.host === 'gitlab', `signed out is the reason (${JSON.stringify(blocked.readiness)})`);
    check(blocked.readiness?.remedy?.kind === 'sign-in' && blocked.readiness.remedy.url === 'https://docs.gitlab.com/cli/auth/login/', `with the vendor's sign-in page as the remedy (${JSON.stringify(blocked.readiness?.remedy)})`);
    const stuck = await add('Passed by QA, signed out');
    {
      const writer = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
      writer.exec('PRAGMA busy_timeout = 15000');
      writer.prepare("UPDATE work_items SET waiting = 'approval' WHERE id = ?").run(stuck.id);
      writer.close();
    }
    await page.goto(`/tasks?project=${projectId}`, 1500);
    await page.waitFor(`return !!document.querySelector('${card(stuck.id)} .pr-not-ready')`, { label: 'the note on the card' });
    const note = await page.eval(`const n = document.querySelector('${card(stuck.id)} .pr-not-ready'); const a = n.querySelector('a.pr-not-ready-remedy'); return { text: n.textContent, href: a?.getAttribute('href') ?? null, target: a?.getAttribute('target') ?? null }`);
    check(note.text.includes('glab') && note.text.includes('gitlab.com') && !note.text.includes('gh'), `the note names glab and gitlab.com (${note.text})`);
    check(note.href === 'https://docs.gitlab.com/cli/auth/login/' && note.target === '_blank', `and links the sign-in page (${JSON.stringify(note)})`);
    check(await page.eval(`return !document.querySelector('${card(stuck.id)} .workitem-approve')?.textContent.includes('MR')`), 'no merge request is offered while it cannot be opened');
    await page.shot('merge-requests-not-ready');
    writeFileSync(join(stateDir, 'glab.json'), '{}');
    await api.post('/hosts/refresh');

    // ---- An orchestration: push and open the merge request ----
    writeFileSync(fake.scripts, JSON.stringify({ [MARKER]: `say: Writing the survey\nrun: echo survey > survey.txt` }));
    const created = await api.post('/orchestrations', {
      name: 'e2e-merge-request',
      objective: 'a graph whose branch becomes a merge request',
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
    check(state?.integration?.status === 'merged', `the branch was integrated (${state?.status} / ${state?.integration?.status} / ${state?.integration?.error})`);
    check(!state?.integration?.pullRequestUrl && !state?.pullRequest, 'no merge request yet: nothing is pushed until it is asked for');

    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    const push = '.card .btn.btn-primary';
    await page.waitFor(`return [...document.querySelectorAll('${push}')].some((b) => b.textContent.includes('Push & open MR'))`, { label: 'the button names the merge request' });
    check(await page.eval(`return ![...document.querySelectorAll('${push}')].some((b) => /Push & open PR/.test(b.textContent))`), 'and not a pull request');
    await page.shot('merge-requests-orchestration-before');
    await page.click(push, 'Push & open MR', 400);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the confirmation' });
    const body = await page.text('[role=dialog]');
    check(body.includes('merge request') && body.includes('GitLab') && !body.includes('GitHub') && !body.includes('gh'), `the dialog speaks of a merge request on GitLab (${body})`);
    await page.click('[role=dialog] .btn-primary', 'Push and open', 600);
    await page.waitFor(`return [...document.querySelectorAll('a.btn')].some((a) => a.textContent.includes('Open MR !7 on GitLab'))`, { timeout: 60_000, label: 'the link to the merge request' });
    const link = await page.eval(`const a = [...document.querySelectorAll('a.btn')].find((a) => a.textContent.includes('Open MR !7 on GitLab')); return { href: a.getAttribute('href'), target: a.getAttribute('target') }`);
    check(link.href === MR_URL(7) && link.target === '_blank', `the link goes to merge request !7 (${JSON.stringify(link)})`);
    const after = (await api.get(`/orchestrations/${orchestrationId}`)).body;
    check(after.pullRequest?.host === 'gitlab' && after.pullRequest.number === 7, `the orchestration holds the merge request (${JSON.stringify(after.pullRequest)})`);
    check(/mr create/.test(calls()) && /-R https:\/\/gitlab\.com\/acme\/shop/.test(calls()), 'glab was asked to create it on the project');
    check(git(bare, 'branch', '--list', state.integration.branch).includes(state.integration.branch), 'the integration branch reached the bare origin, never the real host');
    const strip = await page.eval(`return [...document.querySelectorAll('.card .meta')].map((m) => m.textContent).join(' | ')`);
    check(strip.includes('MR !7') && strip.includes('waiting for merge'), `the card shows the request and its phase (${strip})`);
    check((await page.eval(`return document.body.innerText`)).includes('Agentry follows the MR on GitLab'), 'and says Agentry follows it on GitLab');
    await page.shot('merge-requests-orchestration-after');
    await scan(page, check, 'the orchestration with its merge request');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    writeFileSync(fake.scripts, '{}');
    rmSync(join(stateDir, 'glab.json'), { force: true });
    rmSync(join(stateDir, 'glab.created'), { force: true });
    rmSync(join(stateDir, 'glab.next'), { force: true });
    await api.post('/hosts/refresh').catch(() => {});
    if (orchestrationId) await api.del(`/orchestrations/${orchestrationId}`).catch(() => {});
    for (const id of chats) await api.del(`/chats/${id}`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
    rmSync(bare, { recursive: true, force: true });
  }
};
