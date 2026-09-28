// The Team and assistant gaps of orchestration 6 (docs/plans/project-ecosystem.md): the assistant
// reached from every tab's header and from the palette (8), the Flow screen's limits (5), a member's
// shell commands (7), and the team's whole activity behind "See all" (6). The runs of the activity are
// seeded in the database, as team.spec does: the flow is never switched on, so no run starts.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export default async ({ page, api, check, dirs }) => {
  const made = [];
  try {
    const dir = join(dirs.workspaceDir, 'e2e-gaps');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-gaps', template: 'software' });
    check(imported.status === 201, `a software project was imported (${imported.status})`);
    const project = imported.body;
    made.push(project.id);
    const assistant = `/projects/${project.id}/assistant`;
    await api.post(`/projects/${project.id}/team/from-template`, {});

    // ---- 8: the assistant from the header of every tab, and from the palette ----
    await page.viewport(1440, 900);
    for (const view of ['', '&view=board', '&view=team']) {
      await page.goto(`/?project=${project.id}${view}`, 1200);
      await page.waitFor(`return !!document.querySelector('main .project-head .project-head-assistant')`, { label: `the assistant in the header (${view || 'summary'})` });
      const href = await page.eval(`return document.querySelector('main .project-head .project-head-assistant').getAttribute('href')`);
      check(href === assistant, `the header leads to the project's assistant (${href})`);
    }
    await page.click('main .project-head .project-head-assistant', 'Assistant', 1200);
    await page.waitFor(`return location.pathname === ${JSON.stringify(assistant)}`, { label: "the assistant's page" });

    await page.goto(`/?project=${project.id}`, 1200);
    await page.key('k', 2);
    await page.waitFor(`return !!document.querySelector('[role=dialog][aria-label="Command palette"]')`, { label: 'palette open' });
    await page.type('project assistant');
    await page.sleep(300);
    const first = await page.eval(`return document.querySelector('.palette-option-title')?.textContent`);
    check(first === 'Project assistant', `the palette offers the project's assistant (${first})`);
    await page.key('Enter');
    await page.waitFor(`return location.pathname === ${JSON.stringify(assistant)}`, { label: 'the palette opens the assistant' });
    await page.waitFor(`return !document.querySelector('.palette')`, { label: 'palette closed' });

    // ---- 5: the Flow screen's limits, unlimited unless chosen ----
    await page.goto(`/?project=${project.id}&view=team&section=flow`, 1500);
    await page.waitFor(`return !!document.querySelector('.flow-limits')`, { label: 'the limits card' });
    check((await page.eval(`return document.querySelector('.flow-limits input[aria-label="Runs at once"]').value`)) === '2', 'two runs at once unless chosen');
    check((await page.eval(`return document.querySelector('.flow-limits input[aria-label="Cost per run, in USD"]').value`)) === '', 'no spending limit unless chosen');
    // "No limit" is read in the field itself: a field squeezed by its row showed one glyph of it
    const placeholderFits = `const i = document.querySelector('.flow-limits input[aria-label="Cost per run, in USD"]'); const c = document.createElement('canvas').getContext('2d'); const s = getComputedStyle(i); c.font = s.font; const room = i.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight); return { text: i.placeholder, need: Math.ceil(c.measureText(i.placeholder).width), room }`;
    const deskFit = await page.eval(placeholderFits);
    check(deskFit.text === 'No limit' && deskFit.need <= deskFit.room, `the cost field shows its placeholder whole (${JSON.stringify(deskFit)})`);
    await page.fill('.flow-limits input[aria-label="Runs at once"]', '3');
    await page.fill('.flow-limits input[aria-label="Cost per run, in USD"]', '1.5');
    await page.click('.team-toolbar .btn-primary', 'Save the flow', 1500);
    await page.waitFor(`return document.querySelector('.team-toolbar .btn-primary')?.disabled === true`, { label: 'the flow saved' });
    let flow = (await api.get(`/projects/${project.id}/settings`)).body.flow;
    check(flow?.maxParallel === 3 && flow.maxCostUsd === 1.5, `both limits saved (${JSON.stringify(flow)})`);
    await page.fill('.flow-limits input[aria-label="Cost per run, in USD"]', '');
    await page.click('.team-toolbar .btn-primary', 'Save the flow', 1500);
    await page.waitFor(`return document.querySelector('.team-toolbar .btn-primary')?.disabled === true`, { label: 'the flow saved again' });
    flow = (await api.get(`/projects/${project.id}/settings`)).body.flow;
    check(flow?.maxParallel === 3 && flow.maxCostUsd === undefined, `an emptied spend is no limit, not zero (${JSON.stringify(flow)})`);

    // ---- 7: a member's shell commands ----
    await page.goto(`/?project=${project.id}&view=team&member=developer`, 1500);
    await page.waitFor(`return !!document.querySelector('.member-page')`, { label: 'the member page' });
    await page.click('.member-field [role=radio]', 'These commands', 300);
    await page.fill('.member-commands input', 'pnpm test');
    await page.focus('.member-commands input');
    await page.press('Enter');
    await page.fill('.member-commands input', 'npm test, rm -rf /');
    await page.focus('.member-commands input');
    await page.press('Enter');
    await page.waitFor(`return document.querySelector('.member-field .field-error')?.textContent.includes('comma')`, { label: 'a comma is refused before the route does' });
    check(await page.eval(`return document.querySelector('.member-page-head .btn-primary').disabled`), 'Save stays off while a command cannot be saved');
    await page.click('.member-commands .chip-x[aria-label="Remove npm test, rm -rf /"]', undefined, 300);
    await page.click('.member-page-head .btn-primary', 'Save', 1500);
    await page.waitFor(`return document.querySelector('.member-page-head .btn-primary')?.disabled === true`, { label: 'the member saved' });
    let developer = (await api.get(`/projects/${project.id}/team`)).body.members.find((m) => m.agent === 'developer');
    check(JSON.stringify(developer?.commands) === '["pnpm test"]', `the member's commands saved (${JSON.stringify(developer?.commands)})`);
    // A model saved from the Flow screen keeps them: the route reads a body without them as unrestricted
    await page.goto(`/?project=${project.id}&view=team&section=flow`, 1500);
    // The model is a picker (`.model-pick`, "[opus] Opus 5.5"): open it and take the row whose alias is opus
    await page.click('.flow-models .model-pick[aria-label="Model of Developer"]', undefined, 400);
    await page.waitFor(
      `const o = [...document.querySelectorAll('[role=listbox] [role=option]')].find((o) => o.querySelector('.model-tag')?.textContent === 'opus'); if (!o) return false; o.click(); return true`,
      { label: 'the opus row of the model picker' },
    );
    await page.sleep(300);
    await page.click('.team-toolbar .btn-primary', 'Save the flow', 1500);
    await page.waitFor(`return document.querySelector('.team-toolbar .btn-primary')?.disabled === true`, { label: 'the model saved' });
    developer = (await api.get(`/projects/${project.id}/team`)).body.members.find((m) => m.agent === 'developer');
    check(developer?.model === 'opus' && JSON.stringify(developer.commands) === '["pnpm test"]', `a model change keeps the commands (${JSON.stringify(developer)})`);

    // ---- 6: "See all" opens Team activity, the third view: every run by day, filtered and paged ----
    const item = (await api.post(`/projects/${project.id}/work-items`, { title: 'Checkout totals' })).body;
    const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    db.exec('PRAGMA busy_timeout = 15000');
    const insert = db.prepare(
      'INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, outcome, error, cause, queued_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
    insert.run('e2e-gaps-1', project.id, item.id, 'product-owner', 'product-owner', 'opus', 'refine', 'backlog', 'ended', 'passed', null, null, at(30), at(30), at(28));
    insert.run('e2e-gaps-2', project.id, item.id, 'developer', 'developer', 'sonnet', 'work', 'in_progress', 'ended', 'failed', 'the account hit its rate limit', 'no-account', at(20), at(20), at(15));
    insert.run('e2e-gaps-3', project.id, item.id, 'qa', 'qa', 'sonnet', 'verify', 'in_review', 'ended', 'rejected', null, null, at(10), at(10), at(8));
    db.close();
    await page.goto(`/?project=${project.id}&view=team`, 1500);
    check(await page.eval(`return [...document.querySelectorAll('.team-switch [role=radio]')].map((b) => b.textContent.replace(/\\d+$/, '')).join(',') === 'Members,Flow,Activity'`), 'Team has three views: Members, Flow and Activity');
    await page.click('.team-side-card .team-link', 'See all', 1200);
    await page.waitFor(`return new URLSearchParams(location.search).get('section') === 'activity' && document.querySelectorAll('.flow-run').length === 3`, { label: 'every run of the team' });
    check(await page.eval(`return document.querySelector('.team-switch [role=radio][aria-checked=true]')?.textContent === 'Activity'`), 'the Activity view is the one selected');
    const order = await page.eval(`return [...document.querySelectorAll('.flow-run')].map((row) => row.dataset.status)`);
    check(JSON.stringify(order) === '["rejected","failed","passed"]', `newest first (${order})`);
    check((await page.text('.flow-run-day')).startsWith('TODAY') || (await page.text('.flow-run-day')).startsWith('Today'), 'the runs are grouped under their day');
    const why = await page.text('.flow-run[data-status="failed"] .flow-run-why');
    check(why.includes('No account had quota left.') && why.includes('The item stays in In progress, unchanged.'), `a failed run says why in words, from its cause (${why})`);
    check((await page.text('.flow-run[data-status="failed"] .flow-run-raw')).includes('the account hit its rate limit'), 'with the raw error under it');
    check(await page.eval(`return !!document.querySelector('.flow-run[data-status="failed"] .badge-bad')`), 'its badge in the bad colour, beside its word');
    check((await page.text('.flow-run[data-status="failed"] .flow-run-title')).includes('implementation'), 'the step is named by its column');
    await page.click('.flow-log-views [role=radio]', 'Failed', 800);
    await page.waitFor(`return document.querySelectorAll('.flow-run').length === 1 && !!document.querySelector('.flow-run[data-status="failed"]')`, { label: 'the Failed view' });
    await page.click('.flow-log-views [role=radio]', 'Sent back', 800);
    await page.waitFor(`return document.querySelectorAll('.flow-run').length === 1 && !!document.querySelector('.flow-run[data-status="rejected"]')`, { label: 'the Sent back view' });
    await page.click('.flow-log-views [role=radio]', 'All', 800);
    await page.click('.flow-log-chips .chip', 'QA', 800);
    await page.waitFor(`return document.querySelectorAll('.flow-run').length === 1 && !!document.querySelector('.flow-run[data-status="rejected"]')`, { label: 'the member filter' });
    check((await page.text('.flow-log-limits')).includes('No limit'), 'the flow\'s limits sit beside the runs');

    // ---- the same on a phone: its own header with the member filter, a row opens its chat ----
    await page.viewport(390, 844);
    await page.goto(`/?project=${project.id}&view=team&section=activity`, 1500);
    await page.waitFor(`return document.querySelectorAll('.flow-run').length === 3`, { label: 'the phone activity' });
    check(await page.eval(`return document.querySelector('.team-page .phone-head h1')?.textContent === 'Team'`), 'the phone activity heads itself');
    check(await page.eval(`return !!document.querySelector('.phone-head button[aria-label="Filter by member"]')`), 'its header carries the member filter');
    check(await page.eval(`return !document.querySelector('.flow-run .flow-run-retry') && !document.querySelector('.flow-run a')`), 'nothing inside a phone row is a control of its own');
    check(await page.eval(`return document.documentElement.scrollWidth <= innerWidth`), 'nothing scrolls sideways');
    // Its "⋯" still leads to the assistant: on a phone no tab's screen is a dead end on the way to it (gap 8)
    await page.click('.phone-head .phone-head-more', undefined, 600);
    await page.waitFor(`return !!document.querySelector('.sheet-actions')`, { label: "the activity's sheet" });
    check(await page.eval(`return [...document.querySelectorAll('.sheet-actions button')].some((b) => b.textContent.trim() === 'Assistant')`), "the phone activity's sheet leads to the assistant");
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.sheet-actions')`, { label: 'the sheet closes' });
    await page.goto(`/?project=${project.id}&view=team&section=flow`, 1500);
    await page.waitFor(`return !!document.querySelector('.flow-limits')`, { label: 'the phone limits card' });
    const phoneFit = await page.eval(placeholderFits);
    check(phoneFit.need <= phoneFit.room, `on a phone too (${JSON.stringify(phoneFit)})`);
    check(await page.eval(`return document.documentElement.scrollWidth <= innerWidth`), 'and the limits do not scroll the phone sideways');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry:project'); return true`).catch(() => {});
    for (const id of made) await api.del(`/projects/${id}`).catch(() => {});
  }
};
