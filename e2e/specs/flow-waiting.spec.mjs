// Switching the flow on offers to start the cards already waiting (docs/plans/flow-start-waiting.md):
// cards put in Backlog while the flow is off, then a save on the Flow screen that switches it on asks
// about them. Escape keeps today's behaviour; "Start them" queues one run per card as the person, and
// the toast says how many start now. The dialog passes axe in both themes, and on a phone it is a
// sheet with 44 px actions. On the fake CLI: switching the flow on starts real runs, which must not
// reach a model. (team.spec and team-gaps.spec run on the real CLI and never switch the flow on.)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async ({ page, api, check, dirs }) => {
  const made = [];
  try {
    const dir = join(dirs.workspaceDir, 'e2e-flow-waiting');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-flow-waiting', template: 'software', modules: ['board', 'team'] });
    check(imported.status === 201, `a software project was imported (${imported.status})`);
    const project = imported.body;
    made.push(project.id);
    await api.post(`/projects/${project.id}/team/from-template`, {});
    const settings = (await api.get(`/projects/${project.id}/settings`)).body;
    check(settings.flow && settings.flow.enabled === false, 'the template fills the flow and leaves it off');
    await api.put(`/projects/${project.id}/settings`, { ...settings, flow: { ...settings.flow, maxParallel: 1 } });
    for (const title of ['Cart totals', 'Coupon field', 'Guest checkout']) {
      const created = await api.post(`/projects/${project.id}/work-items`, { title, status: 'backlog', type: 'task' });
      check(created.status === 201, `a card waits in Backlog (${created.status})`);
    }
    await api.post(`/projects/${project.id}/work-items`, { title: 'Checkout', status: 'backlog', type: 'epic' });
    const runs = async () => (await api.get(`/projects/${project.id}/flow/runs`)).body;
    check((await runs()).total === 0, 'no run started while the flow was off');

    const flowScreen = `/?project=${project.id}&view=team&section=flow`;
    const dialog = '[role=dialog]';
    /** Switches the flow on the screen and saves it: `on` is what the switch should read after */
    const saveSwitch = async (save, on) => {
      await page.click('.flow-auto [role=switch]', undefined, 300);
      check((await page.eval(`return document.querySelector('.flow-auto [role=switch]').getAttribute('aria-checked')`)) === String(on), `the switch reads ${on ? 'on' : 'off'}`);
      await page.click(save, undefined, 300);
      await page.waitFor(`return document.querySelector(${JSON.stringify(save)})?.disabled === true`, { label: 'the flow saved' });
    };
    const axeOn = async (theme) => {
      const violations = await page.axe({ include: dialog });
      check(violations.length === 0, `the open prompt passes axe in the ${theme} theme (${violations.map((v) => v.id).join(', ')})`);
    };

    // ---- a desktop, dark: Escape keeps today's behaviour ----
    await page.viewport(1440, 900);
    await page.goto(flowScreen, 800);
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    await page.goto(flowScreen, 1500);
    await page.waitFor(`return !!document.querySelector('.flow-auto [role=switch]')`, { label: 'the Flow screen' });
    await saveSwitch('.team-toolbar .btn-primary', true);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(dialog)})`, { label: 'the prompt about the waiting cards' });
    const title = await page.text(`${dialog} h2`);
    check(title === '3 cards are waiting in columns with a responsible role', `the prompt counts the cards, not the epic (${title})`);
    const rows = await page.eval(`return [...document.querySelectorAll('.flow-waiting-row')].map((r) => r.textContent)`);
    check(rows.length === 1 && rows[0].includes('Backlog') && rows[0].includes('Product Owner') && rows[0].includes('3 cards'), `one line per column with its role (${rows})`);
    const buttons = await page.eval(`return [...document.querySelectorAll('${dialog} .dialog-foot .btn')].map((b) => [b.textContent, b.classList.contains('btn-primary')])`);
    check(JSON.stringify(buttons) === '[["Only new ones",false],["Start them",true]]', `"Start them" is the one primary action (${JSON.stringify(buttons)})`);
    check((await page.eval(`return document.querySelectorAll('${dialog} .btn-primary').length`)) === 1, 'one primary button in the prompt');
    await axeOn('dark');
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector(${JSON.stringify(dialog)})`, { label: 'Escape closes the prompt' });
    await sleep(600);
    check((await runs()).total === 0, 'Escape starts nothing, as "Only new ones" does');

    // A save that leaves the flow on asks nothing
    await page.fill('.flow-limits input[aria-label="Runs at once"]', '2');
    await page.click('.team-toolbar .btn-primary', undefined, 300);
    await sleep(800);
    check(!(await page.eval(`return !!document.querySelector(${JSON.stringify(dialog)})`)), 'a save of a flow already on asks nothing');
    await page.fill('.flow-limits input[aria-label="Runs at once"]', '1');
    await page.click('.team-toolbar .btn-primary', undefined, 800);

    // ---- light: "Start them" queues one run per card, as the person ----
    await saveSwitch('.team-toolbar .btn-primary', false);
    await page.eval(`localStorage.setItem('agentry-theme', 'light'); return true`);
    await page.goto(flowScreen, 1500);
    await page.waitFor(`return !!document.querySelector('.flow-auto [role=switch]')`, { label: 'the Flow screen, light' });
    await saveSwitch('.team-toolbar .btn-primary', true);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(dialog)})`, { label: 'the prompt again' });
    await axeOn('light');
    await page.click(`${dialog} .dialog-foot .btn-primary`, 'Start them', 800);
    await page.waitFor(`return !document.querySelector(${JSON.stringify(dialog)})`, { label: 'the prompt closes' });
    await page.waitFor(`return document.querySelector('.toasts')?.textContent.includes('1 starts now and 2 wait in the queue')`, { label: 'the toast with how many start now' });
    const started = await runs();
    check(started.total === 3 && started.runs.every((r) => r.queuedBy === 'person'), `one run per card, queued by the person (${started.runs.map((r) => `${r.item?.title}:${r.queuedBy}`)})`);

    // ---- a phone: a sheet, primary first, 44 px actions ----
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
    await page.viewport(390, 844);
    await page.goto(flowScreen, 1500);
    await page.waitFor(`return !!document.querySelector('.flow-auto [role=switch]')`, { label: 'the phone Flow screen' });
    // Off cancels what was queued, so the cards wait again
    await saveSwitch('.member-phone-foot .btn-primary', false);
    await saveSwitch('.member-phone-foot .btn-primary', true);
    await page.waitFor(`return !!document.querySelector('.flow-waiting-sheet .sheet-actions')`, { label: 'the prompt as a sheet' });
    const phone = await page.eval(`return [...document.querySelectorAll('.flow-waiting-sheet .sheet-actions .btn')].map((b) => [b.textContent, b.classList.contains('btn-primary'), b.getBoundingClientRect().height])`);
    check(phone.length === 2 && phone[0][0] === 'Start them' && phone[0][1] && phone[1][0] === 'Only new ones', `the primary first on a phone (${JSON.stringify(phone)})`);
    check(phone.every(([, , height]) => height >= 44), `both actions are 44 px targets (${JSON.stringify(phone)})`);
    const before = (await runs()).total;
    await page.click('.flow-waiting-sheet .sheet-actions .btn', 'Only new ones', 600);
    await page.waitFor(`return !document.querySelector('.flow-waiting-sheet')`, { label: '"Only new ones" closes the sheet' });
    await sleep(600);
    check((await runs()).total === before, '"Only new ones" starts nothing');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.setItem('agentry-theme', 'dark'); localStorage.removeItem('agentry:project'); return true`).catch(() => {});
    for (const id of made) await api.del(`/projects/${id}`).catch(() => {});
  }
};
