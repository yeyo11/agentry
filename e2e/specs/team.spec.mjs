// The Team tab (web-team): the tab follows the Team module; an empty team takes the template's; the
// members with their files, columns and paths; a member's page saves its metadata and shows its agent
// file in the editor; the flow is edited as a draft and saved whole; and the board worked by a team
// shows each column's role, a card's bounces, and the approval that moves an item to Done. The flow's
// own runs are core's; the states only the flow writes (bounces, waiting) are seeded in the database.
// Every card is placed before the flow is switched on, so this spec never starts a run.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tabs = `return [...document.querySelectorAll('.project-tabs [role=tab]')].map((t) => t.textContent.replace(/\\d+$/, '').trim())`;

export default async ({ page, api, check, dirs }) => {
  const made = [];
  try {
    const dir = join(dirs.workspaceDir, 'e2e-team');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-team', template: 'software' });
    check(imported.status === 201, `a software project was imported (${imported.status})`);
    const project = imported.body;
    made.push(project.id);

    // ---- the tab exists while the module is on ----
    await page.viewport(1440, 900);
    await page.goto(`/?project=${project.id}`, 1200);
    await page.waitFor(`return document.querySelectorAll('.project-tabs [role=tab]').length > 2`, { label: 'the project tabs' });
    const withTeam = await page.eval(tabs);
    check(withTeam.includes('Team') && withTeam.indexOf('Team') === withTeam.indexOf('Board') + 1, `Team follows Board in the tabs (${withTeam})`);
    await api.request('PATCH', `/projects/${project.id}`, { modules: ['board', 'documents', 'memory'] });
    await page.goto(`/?project=${project.id}&view=team`, 1200);
    await page.waitFor(`return !location.search.includes('view=team') && document.querySelectorAll('.project-tabs [role=tab]').length > 2`, { label: 'a hidden tab lands on Summary' });
    check(!(await page.eval(tabs)).includes('Team'), 'with the module off there is no Team tab');
    await api.request('PATCH', `/projects/${project.id}`, { modules: ['board', 'team', 'documents', 'memory'] });

    // ---- an empty team offers the template's ----
    await page.goto(`/?project=${project.id}&view=team`, 1200);
    await page.waitFor(`return !!document.querySelector('.team-empty')`, { label: 'the empty team' });
    const offer = await page.eval(`return [...document.querySelectorAll('.team-template-chip')].map((c) => c.textContent)`);
    check(offer.length === 4 && offer[0].includes('Product Owner') && offer[0].includes('opus'), `the template's four roles with their models (${offer})`);
    check(await page.eval(`return !!document.querySelector('.team-empty svg[aria-hidden]')`), 'the empty state has its illustration');
    await page.click('.team-empty .team-empty-template', "Use the template's", 1500);
    await page.waitFor(`return document.querySelectorAll('.member-card[data-agent]').length === 4`, { label: 'four member cards' });
    const cards = await page.eval(
      `return [...document.querySelectorAll('.member-card[data-agent]')].map((c) => ({ agent: c.dataset.agent, name: c.querySelector('.member-name')?.textContent, file: c.querySelector('.member-file')?.textContent, avatar: c.querySelector('.role-avatar')?.textContent, now: c.querySelector('.member-now')?.textContent }))`,
    );
    const dev = cards.find((c) => c.agent === 'developer');
    check(dev?.name === 'Developer' && dev.file === '.claude/agents/developer.md' && dev.avatar === 'DEV', `a member names its role, file and initials (${JSON.stringify(dev)})`);
    check(cards.every((c) => c.now?.includes('No work now')), 'a member at rest says so, still');
    check((await page.eval(`return document.querySelectorAll('.member-card.live-rail').length`)) === 0, 'nothing on a resting team is live');
    const summary = await page.eval(`return [...document.querySelectorAll('.team-flow-summary li')].map((li) => li.textContent)`);
    check(summary.length === 5 && summary[2]?.includes('Developer') && summary[4]?.includes('You approve it'), `the flow at a glance names each column's role (${summary})`);

    // ---- one member: its metadata saves through the team route ----
    await page.click('.member-card[data-agent="developer"] .member-head-link', undefined, 1200);
    await page.waitFor(`return new URLSearchParams(location.search).get('member') === 'developer' && !!document.querySelector('.member-page')`, { label: 'the member page' });
    await page.waitFor(`return document.querySelector('.member-editor .cm-content')?.textContent.includes('name: developer')`, { label: 'the agent file in the editor' });
    check((await page.eval(`return document.querySelector('.member-field [role=radio][aria-checked=true]')?.textContent`)) === 'Anywhere', 'a member with no writes may write anywhere');
    await page.fill('.member-textarea', 'Implements each task until its criteria hold.');
    await page.click('.member-field [role=radio]', 'These paths', 300);
    await page.fill('.member-writes .list-editor-add input', 'packages/**');
    await page.click('.member-writes .list-editor-add button', undefined, 300);
    await page.waitFor(`return document.querySelector('.member-page-head .badge-warn')?.textContent.includes('unsaved changes')`, { label: 'unsaved changes are said' });
    await page.click('.member-page-head .btn-primary', 'Save', 1500);
    await page.waitFor(`return !document.querySelector('.member-page-head .badge-warn')`, { label: 'saved' });
    const saved = (await api.get(`/projects/${project.id}/team`)).body.members.find((m) => m.agent === 'developer');
    check(saved.responsibility === 'Implements each task until its criteria hold.' && JSON.stringify(saved.writes) === '["packages/**"]', `the member's metadata was saved (${JSON.stringify(saved)})`);
    check(saved.file.state !== 'missing', `its agent file is still there (${saved.file.state})`);
    await page.click('.member-page-head a.icon-btn', undefined, 1000);
    await page.waitFor(`return !location.search.includes('member=') && !!document.querySelector('.member-grid')`, { label: 'back to the team' });
    check((await page.text('.member-card[data-agent="developer"]')).includes('packages/**'), 'the card shows where it may write');
    // Only the documents folder and anywhere read two ways, on the card as on the member's page
    await api.request('PUT', `/projects/${project.id}/team/qa`, { role: 'qa', model: 'sonnet', responsibility: 'Verifies each criterion', writes: [] });
    await page.waitFor(`return document.querySelector('.member-card[data-agent="qa"]')?.textContent.includes('Only the documents folder')`, { label: 'writes: [] is only the documents folder' });
    check((await page.text('.member-card[data-agent="architect"]')).includes('Anywhere in the project'), 'no writes is anywhere');

    // ---- a member's page follows what is saved elsewhere while nothing is typed in it ----
    await page.click('.member-card[data-agent="architect"] .member-head-link', undefined, 1200);
    await page.waitFor(`return new URLSearchParams(location.search).get('member') === 'architect' && !!document.querySelector('.member-model input')`, { label: "the architect's page" });
    await api.request('PUT', `/projects/${project.id}/team/architect`, { role: 'architect', model: 'haiku', responsibility: 'Decides the shape of the code' });
    await page.waitFor(`return document.querySelector('.member-textarea')?.value === 'Decides the shape of the code'`, { label: 'a save made elsewhere shows on the open page' });
    check(!(await page.eval(`return !!document.querySelector('.member-page-head .badge-warn')`)), 'and is not taken for an unsaved change');
    await page.click('.member-page-head a.icon-btn', undefined, 1000);
    await page.waitFor(`return !location.search.includes('member=') && !!document.querySelector('.member-grid')`, { label: 'back to the team again' });

    // ---- the flow, edited as a draft and saved whole ----
    const item = async (title, status, over = {}) => {
      const created = await api.post(`/projects/${project.id}/work-items`, { title, ...over });
      if (status) await api.post(`/work-items/${created.body.id}/move`, { status });
      return created.body;
    };
    // Every card before the flow goes on: with it on, a card entering a column would start a run
    const bounced = await item('Bounced once', 'in_progress', { assignee: { kind: 'role', role: 'developer' }, acceptanceCriteria: [{ text: 'one' }] });
    const approve = await item('Passed verification', 'in_review');
    await page.click('.team-switch [role=radio]', 'Flow', 1000);
    await page.waitFor(`return new URLSearchParams(location.search).get('section') === 'flow' && document.querySelectorAll('.flow-row').length === 5`, { label: 'the flow' });
    const rows = await page.eval(`return [...document.querySelectorAll('.flow-row')].map((r) => r.dataset.status)`);
    check(JSON.stringify(rows) === JSON.stringify(['backlog', 'todo', 'in_progress', 'in_review', 'done']), `a row per column (${rows})`);
    check(await page.eval(`return !!document.querySelector('.flow-row[data-status="done"] .flow-role.is-fixed')`), "Done is the person's, fixed");
    await page.click('.flow-auto [role=switch]', undefined, 400);
    // Bounces are the first row of the one Limits card, a stepper
    await page.click('.flow-limits .number-step', undefined, 300);
    await page.waitFor(`return document.querySelector('.team-toolbar .badge-warn')?.textContent.includes('unsaved changes')`, { label: 'the flow has unsaved changes' });
    await page.click('.team-toolbar .btn-primary', 'Save the flow', 1500);
    await page.waitFor(`return !document.querySelector('.team-toolbar .badge-warn')`, { label: 'the flow saved' });
    const flow = (await api.get(`/projects/${project.id}/settings`)).body.flow;
    check(flow?.enabled === true && flow.columns.in_progress === 'developer' && Number.isInteger(flow.maxBounces), `the flow was saved on, with its roles (${JSON.stringify(flow)})`);

    // ---- the board worked by a team ----
    const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    db.exec('PRAGMA busy_timeout = 15000');
    db.prepare('UPDATE work_items SET bounces = 1 WHERE id = ?').run(bounced.id);
    db.prepare("UPDATE work_items SET waiting = 'approval' WHERE id = ?").run(approve.id);
    db.close();
    await page.goto(`/tasks?project=${project.id}`, 1500);
    await page.waitFor(`return document.querySelectorAll('.workitem-col').length === 5 && !!document.querySelector('[data-item-id="${approve.id}"]')`, { label: 'the board' });
    const heads = await page.eval(`return [...document.querySelectorAll('.workitem-col')].map((c) => c.querySelector('.workitem-col-head .role-avatar, .workitem-col-head .team-person')?.getAttribute('aria-label') ?? null)`);
    check(heads[0] === 'Product Owner answers for this column' && heads[2] === 'Developer answers for this column' && heads[4] === 'You', `each column shows who acts in it (${heads})`);
    const state = await page.eval(`return document.querySelector('.board-flow-btn .badge')?.textContent`);
    check(state === 'On', `the toolbar says the flow is on (${state})`);
    const bounce = await page.eval(`return document.querySelector('[data-item-id="${bounced.id}"] .bounce')?.getAttribute('title')`);
    check(bounce?.startsWith('QA sent it back 1 time out of'), `a bounced card says so in words (${bounce})`);
    const assignee = await page.eval(`return document.querySelector('[data-item-id="${bounced.id}"] .workitem-card-foot .role-avatar')?.textContent`);
    check(assignee === 'DEV', `a role's card carries its squircle, not a person's monogram (${assignee})`);
    const waiting = await page.eval(`return document.querySelector('[data-item-id="${approve.id}"] .workitem-strip.is-wait')?.textContent ?? ''`);
    check(waiting.includes('waits') && waiting.includes('QA passed it'), `an item waiting for approval says why (${waiting})`);
    await page.click(`[data-item-id="${approve.id}"] .workitem-approve`, undefined, 1500);
    await page.waitFor(`return document.querySelector('.workitem-col[data-status="done"] [data-item-id="${approve.id}"]') !== null`, { label: 'approving moves it to Done' });
    const done = (await api.get(`/work-items/${approve.id}`)).body;
    check(done.status === 'done' && !done.waiting, `the person's move reached Done and cleared the wait (${done.status}, ${done.waiting})`);

    // ---- the phone: the members as cells, a member as its own screen ----
    await page.viewport(390, 844);
    await page.goto(`/?project=${project.id}&view=team`, 1500);
    await page.waitFor(`return document.querySelectorAll('.member-cell').length === 4`, { label: 'the phone members' });
    check(await page.eval(`return document.querySelector('.team-page .phone-head h1')?.textContent === 'Team'`), 'the phone Team screen heads itself');
    check(await page.eval(`return !!document.querySelector('.phone-head .phone-head-more')`), 'with its "⋯"');
    await page.click('.member-cell', 'QA', 1200);
    await page.waitFor(`return new URLSearchParams(location.search).get('member') === 'qa' && !!document.querySelector('.member-page.is-phone')`, { label: 'the phone member' });
    const target = await page.eval(`const b = document.querySelector('.member-phone-foot .btn-primary').getBoundingClientRect(); return b.height`);
    check(target >= 44, `the phone's Save is a 44 px target (${target})`);
    // Without a top bar, the head's way back is the screen's only way out (MobileMiembro, gap 21)
    const memberBack = await page.eval(`const r = document.querySelector('.member-page.is-phone .phone-head > .icon-btn').getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top }`);
    check(memberBack.w >= 44 && memberBack.h >= 44 && memberBack.top < 80, `the member's way back is a 44 px target at the top (${JSON.stringify(memberBack)})`);
    check(!(await page.eval(`return document.querySelector('.topbar').getClientRects().length > 0`)), 'and no top bar sits over the member');
    // Every tab's phone head leads to the assistant (gap 8)
    await page.goto(`/?project=${project.id}&view=team`, 1200);
    await page.waitFor(`return !!document.querySelector('.team-page .phone-head .phone-head-more')`, { label: 'the phone Team head' });
    await page.click('.team-page .phone-head .phone-head-more', undefined, 600);
    await page.waitFor(`return !!document.querySelector('.sheet-actions')`, { label: "the Team screen's sheet" });
    check(await page.eval(`return [...document.querySelectorAll('.sheet-actions button')].some((b) => b.textContent.trim() === 'Assistant')`), "the phone Team head leads to the project's assistant");
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.sheet-actions')`, { label: 'the sheet closes' });

    // ---- a team whose flow was never saved: nothing is drawn as if it were in force ----
    await page.viewport(1440, 900);
    const bareDir = join(dirs.workspaceDir, 'e2e-team-bare');
    mkdirSync(bareDir, { recursive: true });
    const bare = (await api.post('/projects/import', { path: bareDir, name: 'e2e-team-bare', template: 'custom', modules: ['board', 'team'] })).body;
    made.push(bare.id);
    await api.request('PUT', `/projects/${bare.id}/team/developer`, { role: 'developer', model: 'sonnet', responsibility: 'Implements', createFile: true });
    check((await api.get(`/projects/${bare.id}/settings`)).body.flow == null, 'a member added by hand saves no flow');
    await page.goto(`/?project=${bare.id}&view=team`, 1500);
    await page.waitFor(`return document.querySelectorAll('.member-card[data-agent]').length === 1`, { label: 'the bare team' });
    // innerText carries the badge's text-transform: uppercase
    const bareSummary = await page.text('.team-side-card');
    check(bareSummary.toLowerCase().includes('not set up') && !bareSummary.includes('Developer'), `the summary says there is no flow, and gives no column a role (${bareSummary})`);
    await page.click('.team-side-card .team-link', 'Set up', 1000);
    await page.waitFor(`return !!document.querySelector('.flow-proposal')`, { label: "the template's proposal, said to be unsaved" });
    const proposedRole = await page.eval(`return document.querySelector('.flow-row[data-status="in_progress"] .flow-role')?.textContent`);
    check(proposedRole?.includes('Developer'), `the proposal gives the developer its column (${proposedRole})`);
    check(!(await page.eval(`return document.querySelector('.team-toolbar .btn-primary').disabled`)), 'the proposal can be saved as it is');
    await page.click('.team-toolbar .btn-primary', 'Save the flow', 1500);
    await page.waitFor(`return !document.querySelector('.flow-proposal')`, { label: 'the proposal saved' });
    const bareFlow = (await api.get(`/projects/${bare.id}/settings`)).body.flow;
    check(bareFlow?.enabled === false && bareFlow.columns.in_progress === 'developer', `saved off, with the developer's column (${JSON.stringify(bareFlow)})`);

    // ---- a failed run says why on the Team screen ----
    const failDb = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    failDb.exec('PRAGMA busy_timeout = 15000');
    const failItem = (await api.post(`/projects/${bare.id}/work-items`, { title: 'Failed once' })).body;
    const now = new Date().toISOString();
    failDb
      .prepare(
        "INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, outcome, error, queued_at, started_at, ended_at) VALUES (?, ?, ?, 'developer', 'developer', 'sonnet', 'work', 'in_progress', 'ended', 'failed', ?, ?, ?, ?)",
      )
      .run('e2e-failed-run', bare.id, failItem.id, 'the account hit its rate limit', now, now, now);
    failDb.close();
    await page.goto(`/?project=${bare.id}&view=team`, 1500);
    await page.waitFor(`return document.querySelector('.team-activity')?.textContent.includes('the account hit its rate limit')`, { label: 'the reason a run failed' });
    check(await page.eval(`return !!document.querySelector('.team-activity .text-err')`), 'a failed run says so in the bad colour, beside its word');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry:project'); return true`).catch(() => {});
    for (const id of made) await api.del(`/projects/${id}`).catch(() => {});
  }
};
