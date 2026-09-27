// The project assistant (web-assistant): the wizard hands a new project to it, which, with nothing to
// read, offers the template's team member by member and proposes first tasks from a description; the
// empty Team screen asks it for a proposal, whose run is live while it reads and still once it ends,
// each proposal accepted, discarded or restored on its own. Runs against the fake CLI, whose scripts
// file answers each run as the CLI's `--json-schema` would.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const NEW = 'e2e-assistant-new';
const READ = 'e2e-assistant';

const answer = {
  summary: 'A small API.',
  findings: [
    { kind: 'stack', label: 'TypeScript' },
    { kind: 'gap', label: 'no CI' },
  ],
  read: [{ kind: 'file', path: 'README.md' }],
  teamMembers: [{ role: 'qa', model: 'sonnet', responsibility: 'Verifies each item', writes: ['tests/'], reason: 'Nothing checks the routes.' }],
  resources: [
    {
      kind: 'commands',
      name: 'migrate',
      description: 'Runs the migrations.',
      content: '---\ndescription: Runs the migrations.\n---\n\nRun them.\n',
      reason: 'The chats run the same three commands by hand.',
    },
  ],
  workItems: [{ type: 'bug', title: 'Refunds are stored as totals', priority: 'urgent', labels: ['payments'], acceptanceCriteria: ['A partial refund stays partial'], reason: 'No test covers it.' }],
};
const firstTasks = {
  summary: 'First tasks.',
  workItems: [{ type: 'story', title: 'Sync notes with a git folder', priority: 'high', labels: ['git'], acceptanceCriteria: [], reason: 'It is half of what you describe.' }],
};

/** Waits for the API to answer `probe` with something truthy. */
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const onAssistant = `return /^\\/projects\\/[^/]+\\/assistant$/.test(location.pathname)`;
const rows = (status) => `return document.querySelectorAll('.suggestion-row[data-proposal]${status ? `[data-status=${status}]` : ''}').length`;

export default async ({ page, api, check, dirs, fakeCli }) => {
  const made = [];
  try {
    // Each run is answered by the project it reads: its prompt names the project
    writeFileSync(
      fakeCli.scripts,
      JSON.stringify({
        [`project "${NEW}"`]: `json: ${JSON.stringify(firstTasks)}`,
        [`project "${READ}"`]: ['read: README.md', 'run: sleep 4', `json: ${JSON.stringify(answer)}`].join('\n'),
      }),
    );
    await page.viewport(1440, 1024);

    // ---- the wizard hands a new, empty project to the assistant ----
    await page.goto('/projects/new', 1200);
    await page.waitFor(`return !!document.querySelector('.wizard-propose [role=switch]')`, { label: 'the propose switch' });
    check((await page.eval(`return document.querySelector('.wizard-propose [role=switch]').getAttribute('aria-checked')`)) === 'true', 'proposing is on for Professional software');
    await page.click('.template-grid [role=radio]', 'Simple', 300);
    check((await page.eval(`return document.querySelector('.wizard-propose [role=switch]').getAttribute('aria-checked')`)) === 'false', 'and off for Simple');
    await page.click('.template-grid [role=radio]', 'Professional software', 300);
    await page.fill('.wizard-name input', NEW);
    await page.click('.wizard-create', undefined, 1500);
    await page.waitFor(onAssistant, { label: 'the wizard lands on the assistant' });
    const newId = decodeURIComponent(await page.eval(`return location.pathname.split('/')[2]`));
    made.push(newId);
    await page.waitFor(`return !!document.querySelector('.assistant-empty-line')`, { label: 'nothing to read' });
    check((await page.eval(rows('pending'))) === 4, "an empty project is offered the template's four roles");
    check(await page.eval(`return document.querySelector('.assistant-empty-line').textContent.includes('no cost')`), 'a run that read nothing says it cost nothing');
    check(!(await page.eval(`return !!document.querySelector('.live-energy')`)), 'nothing reads, so nothing is live');

    // Accepted, discarded and restored one by one
    await page.click('.suggestion-row[data-status=pending] .btn', 'Accept', 800);
    await page.waitFor(`${rows('accepted')} === 1`, { label: 'one member accepted' });
    check(await page.eval(`return document.querySelector('.suggestion-row[data-status=accepted] .suggestion-done').textContent.includes('added')`), 'an accepted role says it was added');
    const team = await api.get(`/projects/${newId}/team`);
    check(team.body.members.length === 1, `accepting wrote one member and no more (${team.body.members.length})`);
    await page.click('.suggestion-row[data-status=pending] .btn-quiet', 'Discard', 800);
    await page.waitFor(`${rows('discarded')} === 1`, { label: 'one role discarded' });
    await page.click('.suggestion-row[data-status=discarded] .btn', 'Undo', 800);
    await page.waitFor(`${rows('discarded')} === 0 && ${rows('pending').replace('return ', '')} === 3`, { label: 'the role restored' });

    // A description asks for the first tasks
    await page.fill('.assistant-describe-input', 'A notes app synced with a git folder');
    await page.click('.assistant-describe .btn-primary', 'Propose tasks', 1000);
    await page.waitFor(`return [...document.querySelectorAll('.suggestion-row[data-proposal] .suggestion-title')].some((t) => t.textContent.includes('Sync notes'))`, { label: 'the first tasks proposed' });
    await page.click('.suggestion-row[data-status=pending] .btn', 'Accept', 800);
    await page.waitFor(`return [...document.querySelectorAll('.suggestion-row[data-status=accepted] .suggestion-done')].some((d) => d.textContent.includes('created') && !!d.querySelector('.workitem-key'))`, {
      label: 'the task created, with its key',
    });
    const items = await api.get(`/projects/${newId}/work-items`);
    const created = items.body.filter((i) => i.title === 'Sync notes with a git folder');
    check(created.length === 1 && created[0].status === 'backlog', `the task is in Backlog (${JSON.stringify(created.map((i) => i.status))})`);

    // ---- the empty Team screen asks for a proposal; the run is live, then still ----
    const dir = join(dirs.workspaceDir, READ);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# e2e-assistant\n\nA small API.\n');
    const imported = await api.post('/projects/import', { path: dir, name: READ, template: 'software' });
    check(imported.status === 201, `a project with a README was imported (${imported.status})`);
    const project = imported.body;
    made.push(project.id);
    await page.goto(`/?project=${project.id}&view=team`, 1200);
    await page.waitFor(`return !!document.querySelector('.team-empty-propose')`, { label: 'Ask for a proposal' });
    check(await page.eval(`return document.querySelector('.team-empty .btn-primary')?.classList.contains('team-empty-propose')`), 'asking for a proposal is the primary action of an empty team');
    await page.click('.team-empty-propose', undefined, 800);
    await page.waitFor(onAssistant, { label: 'the assistant opens' });
    await page.waitFor(`return !!document.querySelector('.suggestion-run.is-live.live-energy')`, { label: 'a live run' });
    check((await page.eval(`return document.querySelectorAll('.live-energy').length`)) === 1, 'one energy border, on the run');
    check(await page.eval(`return [...document.querySelectorAll('.suggestion-run.is-live .btn')].some((b) => b.textContent.includes('Stop'))`), 'a live run can be stopped');
    check(await page.eval(`return document.querySelector('.assistant-head-actions .btn-primary')?.disabled === true`), 'Go to the project waits for the run');
    check(await page.eval(`return document.querySelectorAll('.suggestion-wait').length === 3`), 'the three sections wait, dashed and still');
    await page.waitFor(`return [...document.querySelectorAll('.suggestion-step')].some((s) => s.textContent.includes('README.md'))`, { label: 'what it read so far' });

    await page.waitFor(`return !!document.querySelector('.suggestion-run.is-done')`, { label: 'the run ended', timeout: 30_000 });
    check(!(await page.eval(`return !!document.querySelector('.live-energy')`)), 'a finished run stands still');
    check((await page.eval(rows())) === 3, `one proposal of each kind (${await page.eval(rows())})`);
    check(await page.eval(`return document.querySelector('.assistant-tasks').classList.contains('grad-border')`), 'the first tasks are what the screen is about');
    const review = await page.eval(`return [...document.querySelectorAll('.suggestion-row[data-proposal] a.btn')].map((a) => a.getAttribute('href'))[0] ?? ''`);
    check(review.includes('view=resources') && review.includes('section=commands') && review.includes('proposal='), `Review opens the proposal in the Resources tab (${review})`);
    await page.click('.suggestion-run.is-done .btn', 'See what it has read', 500);
    check(await page.eval(`return !!document.querySelector('.assistant-read .suggestion-step')`), 'what it read is kept on the run');
    const run = await until(async () => {
      const runs = await api.get(`/projects/${project.id}/assistant/runs?kind=project`);
      return runs.body?.[0]?.status === 'completed' ? runs.body[0] : null;
    }, 'the run completed');
    check(run.findings.some((f) => f.label === 'TypeScript'), 'what it found is kept too');

    // ---- the phone: a section at a time, and 44 px targets ----
    await page.viewport(390, 844);
    await page.goto(`/projects/${project.id}/assistant`, 1500);
    await page.waitFor(`return !!document.querySelector('.assistant-page.is-phone .assistant-tabs')`, { label: 'the phone sections' });
    check(await page.eval(`return !!document.querySelector('.assistant-foot .btn-primary')`), 'Go to the project is the phone footer');
    const heights = await page.eval(`return [...document.querySelectorAll('.suggestion-card .suggestion-acts .btn')].map((b) => b.getBoundingClientRect().height)`);
    check(heights.length > 0 && heights.every((h) => h >= 44), `a phone's proposal buttons are 44 px targets (${heights})`);
    check(!(await page.eval(`return !!document.querySelector('.suggestion-card input[type=checkbox], .suggestion-card .checkbox')`)), 'no checkboxes on a phone');
    check(page.takeErrors().length === 0, 'no console errors');
  } finally {
    await page.viewport(1440, 1024);
    for (const id of made) await api.del(`/projects/${id}`).catch(() => {});
  }
};
