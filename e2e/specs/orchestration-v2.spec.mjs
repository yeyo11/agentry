// Orchestration v2 in the browser: a finished graph is saved as a template, corrected and
// relaunched, launched from the template, and re-run from one task; the launch form takes limits and
// a verification phase. A template is renamed where it is listed, and a schedule is filled from a
// graph that already ran. Nothing is logged in inside the sandbox, so every worker fails at once: the
// graph is stopped to be a finished one, which is what these controls are for.
//
// The verification outcome card is not driven here: an outcome only exists once the core runs the
// checks on a real integration branch, which needs a repository and a logged-in CLI.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FINISHED = new Set(['completed', 'failed', 'stopped']);

export default async ({ page, api, check, dirs }) => {
  const workspace = join(dirs.workspaceDir, 'e2e-v2');
  mkdirSync(workspace, { recursive: true });
  const made = [];
  const templates = [];
  const schedules = [];
  // Every chat a worker of ours leaves behind is removed at the end; the ones that were there stay
  const before = new Set(((await api.get('/chats?origin=orchestration')).body ?? []).map((c) => c.id));

  const orchestration = async (id) => (await api.get(`/orchestrations/${id}`)).body;
  const until = async (id, done, label) => {
    for (let i = 0; i < 80; i++) {
      const state = await orchestration(id);
      if (state && done(state)) return state;
      await page.sleep(400);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  /** A graph nothing runs in any more: stopped, since the workers fail and the graph waits for a decision */
  const finish = async (id) => {
    let state = await until(id, (s) => s.status !== 'running', 'the graph to stop running');
    if (!FINISHED.has(state.status)) {
      await api.post(`/orchestrations/${id}/stop`);
      state = await until(id, (s) => FINISHED.has(s.status), 'the graph to be finished');
    }
    return state;
  };
  const clickButton = (text, within = 'main') => page.click(`${within} button`, text, 600);
  const dialogButton = (text) => page.click('[role=dialog] button', text, 600);

  try {
    // ---------- a finished graph ----------
    const created = await api.post('/orchestrations', {
      name: 'e2e-v2-source',
      objective: 'a graph to correct',
      cwd: workspace,
      maxAttempts: 1,
      worktree: false,
      synthesize: false,
      tasks: [
        { id: 'survey', name: 'Survey', prompt: 'Survey the code' },
        { id: 'fix', name: 'Fix', prompt: 'Fix what the survey found', dependsOn: ['survey'] },
      ],
    });
    check(created.status === 201, `the graph was created (${created.status})`);
    const source = created.body.id;
    made.push(source);
    await finish(source);

    await page.goto(`/orchestration/${source}`, 1500);
    await page.waitFor(`return [...document.querySelectorAll('main button')].some((b) => b.textContent.includes('Edit and relaunch'))`, { label: 'the relaunch button' });
    check((await page.text('main')).includes('Save as template'), 'a finished graph offers to be saved as a template');
    const rerunButtons = await page.eval(`return [...document.querySelectorAll('.board-task button')].filter((b) => b.textContent.includes('Re-run')).length`);
    check(rerunButtons === 2, `each task of a finished graph offers a re-run (saw ${rerunButtons})`);

    // ---------- save as a template ----------
    await clickButton('Save as template');
    await page.fill('[role=dialog] input', 'e2e-v2 template');
    await dialogButton('Save template');
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the save dialog closed' });
    const listed = (await api.get('/orchestrations/templates')).body;
    const template = listed.find((t) => t.name === 'e2e-v2 template');
    check(template, 'the template was saved');
    templates.push(template.id);
    check(template.spec.tasks.length === 2, 'the template holds the graph as it was launched');

    // ---------- edit and relaunch ----------
    await clickButton('Edit and relaunch');
    await page.fill('.task-editor textarea', 'Survey the code twice');
    await page.fill('input[aria-label="Time limit in minutes for task survey"]', '15');
    await clickButton('Relaunch 2 tasks');
    await page.waitFor(`return location.pathname.startsWith('/orchestration/') && location.pathname !== '/orchestration/${source}'`, { label: 'the relaunched graph opened' });
    const relaunched = (await api.get('/orchestrations')).body.find((o) => o.relaunchedFrom === source);
    check(relaunched, 'a new orchestration records where it came from');
    made.push(relaunched.id);
    const survey = relaunched.tasks.find((t) => t.id === 'survey');
    check(survey?.prompt === 'Survey the code twice', 'the corrected prompt was relaunched');
    check(survey?.limits?.maxMinutes === 15, 'the time limit was relaunched');
    check(relaunched.tasks.find((t) => t.id === 'fix')?.dependsOn?.includes('survey'), 'the dependencies were kept');
    check((await orchestration(source)).tasks[0].prompt === 'Survey the code', 'the original graph is untouched');
    check((await page.text('main')).includes('Relaunched from an earlier run'), 'the relaunched graph links back to its origin');
    await finish(relaunched.id);

    // ---------- launch the template ----------
    await page.goto('/orchestration', 1500);
    check((await page.text('main')).includes('e2e-v2 template'), 'the template is listed');
    await clickButton('Launch');
    await page.fill('[role=dialog] textarea', 'the same graph on another objective');
    await dialogButton('Launch');
    await page.waitFor(`return location.pathname.startsWith('/orchestration/')`, { label: 'the launched graph opened' });
    const launched = (await api.get('/orchestrations')).body.find((o) => o.templateId === template.id);
    check(launched, 'a graph launched from the template records it');
    made.push(launched.id);
    check(launched.objective === 'the same graph on another objective', 'the template ran on the new objective');
    await finish(launched.id);

    // ---------- re-run one task ----------
    await page.goto(`/orchestration/${source}`, 1500);
    const beforeRerun = (await orchestration(source)).status;
    await page.click('.board-task button', 'Re-run', 600);
    await dialogButton('Re-run');
    const after = await until(source, (s) => s.status !== beforeRerun, 'the graph to start over');
    check(after.status === 'running' || after.status === 'waiting', `re-running started the graph again (${after.status})`);
    await finish(source);

    // ---------- the launch form ----------
    await page.goto('/orchestration', 1500);
    await clickButton('New orchestration');
    await page.click('[role=radio]', 'Manual', 400);
    await clickButton('Add task');
    const form = await page.text('main');
    for (const text of ['Time limit (minutes)', 'Cost limit (USD)', 'Default limits for every task', 'Verify the integration branch', 'Save as template']) {
      check(form.includes(text), `the launch form has "${text}"`);
    }
    await page.eval(`[...document.querySelectorAll('main [role=switch]')].find((s) => s.closest('label')?.textContent.includes('Verify the integration branch')).click(); return true`);
    await page.waitFor(`return !!document.querySelector('main textarea[placeholder="pnpm build"]')`, { label: 'the verification commands' });
    // The fixer's ceiling, the install step Agentry adds and whether failed checks fail the graph
    const checks = await page.text('main');
    for (const text of ['Install step', 'Detected from the lockfile', 'Fixer cost limit (USD)', 'Fail the graph when the checks fail']) {
      check(checks.includes(text), `the verification fields have "${text}"`);
    }
    await page.select('main [aria-label="Install step"]', 'A command of my own');
    await page.waitFor(`return !!document.querySelector('main input[placeholder="pnpm install --frozen-lockfile"]')`, { label: 'the install command field' });

    // ---------- a schedule filled from a graph that ran ----------
    await page.goto('/schedules', 1200);
    await page.click('main .page-actions button', 'New schedule');
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the schedule form' });
    await page.click('[role=dialog] [role=radio]', 'An orchestration', 400);
    await page.select('[role=dialog] [aria-label="From an existing orchestration"]', 'e2e-v2-source');
    await page.waitFor(
      `return [...document.querySelectorAll('[role=dialog] textarea')].some((t) => t.value === 'Fix what the survey found')`,
      { label: 'the tasks filled from the graph' },
    );
    const filledName = await page.eval(`return document.querySelector('[role=dialog] input[placeholder="Morning dependency check"]').value`);
    check(filledName === 'e2e-v2-source', `an empty schedule name takes the graph's (${filledName})`);
    await page.click('[role=dialog] button', 'Create schedule', 1000);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the schedule form closed' });
    const scheduled = (await api.get('/schedules')).body.find((s) => s.name === 'e2e-v2-source');
    check(scheduled?.target.kind === 'orchestration', 'the schedule starts an orchestration');
    if (scheduled) {
      schedules.push(scheduled.id);
      const fix = scheduled.target.spec.tasks.find((t) => t.id === 'fix');
      check(fix?.dependsOn?.includes('survey'), 'the dependencies the form does not show came along from the graph');
      check(scheduled.target.spec.cwd === workspace && scheduled.target.spec.worktree === false, 'the directory and the worktree choice came from the graph');
    }

    // ---------- rename a template in place ----------
    await page.goto('/orchestration', 1500);
    await page.click('button[aria-label="Rename template e2e-v2 template"]', undefined, 400);
    await page.fill('input[aria-label="New name for e2e-v2 template"]', 'e2e-v2 renamed');
    await page.click('button[aria-label="Save the name"]', undefined, 800);
    await page.waitFor(`return document.querySelector('main')?.innerText.includes('e2e-v2 renamed')`, { label: 'the new name listed' });
    const renamed = (await api.get('/orchestrations/templates')).body.find((t) => t.id === template.id);
    check(renamed?.name === 'e2e-v2 renamed', 'the template was renamed');
    check(renamed?.spec.tasks.length === 2, 'renaming left the graph as it was');
    check(await page.eval(`return location.pathname === '/orchestration' && !document.querySelector('[role=dialog]')`), 'renaming did not open the graph');

    // ---------- delete the template ----------
    await page.goto('/orchestration', 1500);
    await page.click('button[aria-label^="Delete template"]', undefined, 600);
    await dialogButton('Delete');
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the delete dialog closed' });
    await page.sleep(500);
    check(!(await api.get('/orchestrations/templates')).body.some((t) => t.id === template.id), 'the template was deleted');
  } finally {
    for (const id of made) {
      await api.post(`/orchestrations/${id}/stop`).catch(() => {});
      await api.del(`/orchestrations/${id}`).catch(() => {});
    }
    for (const id of templates) await api.del(`/orchestrations/templates/${id}`).catch(() => {});
    for (const id of schedules) await api.del(`/schedules/${id}`).catch(() => {});
    for (const chat of (await api.get('/chats?origin=orchestration')).body ?? []) {
      if (!before.has(chat.id)) await api.del(`/chats/${chat.id}`).catch(() => {});
    }
  }
};
