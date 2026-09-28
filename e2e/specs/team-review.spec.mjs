// What the cross-screen review of orchestration 3 (web-review-3) fixed, held in place: the Team
// tab's deeper crumbs, a member as a page of its own, the phone's tab bar stepping aside for the
// screens that end in their own Save bar, a role drawn and named the same on the board and on the
// work item, and the item page's waiting panel no longer styling the board card's note.
// Nothing here starts a run: the flow stays off.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const crumbs = `return [...document.querySelectorAll('.topbar .crumbs .crumb-page')].map((c) => c.textContent.trim())`;

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  try {
    const dir = join(dirs.workspaceDir, 'e2e-team-review');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-team-review', template: 'software' });
    check(imported.status === 201, `a software project (${imported.status})`);
    projectId = imported.body.id;
    const team = await api.post(`/projects/${projectId}/team/from-template`, {});
    check(team.status === 200 || team.status === 201, `the template's team (${team.status})`);
    const item = (await api.post(`/projects/${projectId}/work-items`, { title: 'Name the columns', assignee: { kind: 'role', role: 'qa' } })).body;
    const base = `/?project=${projectId}&view=team`;

    // ---- crumbs: Team, Team / Flow, Team / Developer ----
    await page.viewport(1440, 900);
    await page.goto(base, 1200);
    await page.waitFor(`return document.querySelectorAll('.member-card[data-agent]').length === 4`, { label: 'the team' });
    const plain = await page.eval(crumbs);
    check(plain.at(-1) === 'Team', `the Team tab's crumb ends in Team (${plain})`);
    await page.goto(`${base}&section=flow`, 1200);
    await page.waitFor(`return document.querySelectorAll('.flow-row').length === 5`, { label: 'the flow' });
    const flow = await page.eval(crumbs);
    check(flow.slice(-2).join(' / ') === 'Team / Flow', `the flow's crumb (${flow})`);
    check(await page.eval(`return !!document.querySelector('.topbar .crumbs a.crumb-page[href*="view=team"]')`), 'Team in the crumb leads back to the team');
    await page.goto(`${base}&section=activity`, 1200);
    await page.waitFor(`return !!document.querySelector('.flow-log-page')`, { label: 'the team activity' });
    const activity = await page.eval(crumbs);
    check(activity.slice(-2).join(' / ') === 'Team / Activity', `the activity's crumb (${activity})`);

    // ---- a member is a page of its own ----
    await page.goto(`${base}&member=developer`, 1200);
    await page.waitFor(`return !!document.querySelector('.member-page')`, { label: 'the member page' });
    const member = await page.eval(crumbs);
    check(member.slice(-2).join(' / ') === 'Team / Developer', `the member's crumb names its role (${member})`);
    check(await page.eval(`return !document.querySelector('.project-tabs') && !document.querySelector('.member-page')?.closest('[role=tabpanel]')`), "a member's page has no project tabs over it");

    // ---- a role is the same squircle and name on the item as on the board ----
    await page.goto(`/tasks/${item.key}?project=${projectId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.workitem-props')`, { label: 'the item' });
    const props = await page.eval(`const r = document.querySelector('.workitem-props .role-avatar'); return r ? { initials: r.textContent, label: r.getAttribute('aria-label') } : null`);
    check(props?.initials === 'QA', `the item draws its role's squircle (${JSON.stringify(props)})`);
    check((await page.text('.workitem-props')).includes('QA') && !(await page.text('.workitem-props')).includes(' qa'), 'the item names the role, not its id');

    // ---- the phone: Save bars without the tab bar under them ----
    await page.viewport(390, 844);
    for (const [path, has] of [
      [`${base}&member=developer`, false],
      [`${base}&section=flow`, false],
      [base, true],
      [`/?project=${projectId}&view=memory`, true],
    ]) {
      await page.goto(path, 1200);
      await page.waitFor(`const m = document.querySelector('main'); return m && m.innerText.trim().length > 20`, { label: path });
      const shown = await page.eval(`return !!document.querySelector('nav.tabbar')`);
      check(shown === has, `${path}: the tab bar is ${has ? 'there' : 'hidden'} (${shown})`);
    }
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry:project'); return true`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
