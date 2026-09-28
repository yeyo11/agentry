// "Suggest tasks" on the board and the resources with AI (decisions 35 to 37 of
// docs/plans/project-ecosystem.md), end to end against the fake CLI: an assistant run is a chat whose
// answer the fake returns as its structured result. Nothing is written before a proposal is accepted:
// the selected tasks are created one by one in Backlog, a similar one starts unselected, a discarded
// one can be restored; a suggested resource opens in the editor unsaved and exists once saved there;
// "Create with AI" builds one from a description. On a phone the proposals are Include buttons, never
// checkboxes.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(condition, label, limit = 20_000) {
  const end = Date.now() + limit;
  for (;;) {
    // A condition may be synchronous, such as a file existing
    const value = await Promise.resolve().then(condition).catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(200);
  }
}

// Text only each kind of run's prompt holds (packages/core/src/assistant-answer.ts)
const WORK_ITEMS_KEY = 'the next work items: what is missing or broken';
const SUGGEST_KEY = '`resources`: agents, skills and commands that would help';
const ONE_AGENT_KEY = 'Build exactly one agent from this description';

const agentFile = (name, description) => `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep\nmodel: sonnet\n---\n\n# ${name}\n\nReview the change.\n`;

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  let projectId = null;
  try {
    // A project with something to read, so a run starts its chat
    const dir = join(dirs.workspaceDir, 'e2e-suggest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# e2e-suggest\n\nA project the assistant reads.\n');
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-suggest', template: 'software' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    const project = imported.body;
    projectId = project.id;
    const make = async (body) => (await api.post(`/projects/${projectId}/work-items`, body)).body;
    const epic = await make({ title: 'Board polish', type: 'epic' });
    const existing = await make({ title: 'Filter the list by epic', type: 'story' });
    const itemCount = async () => (await api.get(`/projects/${projectId}/work-items`)).body.length;
    const before = await itemCount();

    const workItems = [
      { type: 'story', title: 'Undo the last move of a card', description: 'Undo.', priority: 'medium', labels: ['board'], acceptanceCriteria: ['A move can be undone'], epic: epic.key, similarTo: null, reason: 'A person always wins over an automatic move, but cannot undo their own.' },
      { type: 'bug', title: 'Column limit not checked on import', description: 'Import.', priority: 'high', labels: ['core'], acceptanceCriteria: [], epic: null, similarTo: null, reason: 'PUT settings checks the limit, import does not.' },
      { type: 'story', title: 'Filter the list by milestone', description: 'Filter.', priority: 'low', labels: [], acceptanceCriteria: [], epic: null, similarTo: existing.key, reason: 'Milestones exist, but the list only filters by epic.' },
    ];
    const resources = [
      { kind: 'agents', name: 'migration-reviewer', description: 'Reviews every new migration', content: agentFile('migration-reviewer', 'Reviews every new migration'), reason: 'db.ts has many migrations.' },
      { kind: 'commands', name: 'openapi', description: 'Regenerates the OpenAPI schemas', content: '---\ndescription: Regenerates the OpenAPI schemas\n---\n\nRegenerate them.\n', reason: 'CI failed on stale schemas.' },
    ];
    const one = { kind: 'agents', name: 'glossary-reviewer', description: 'Reads every new Spanish string against the glossary', content: agentFile('glossary-reviewer', 'Reads every new Spanish string against the glossary'), reason: 'You asked for it.' };
    const answer = (extra) => `read: README.md\njson: ${JSON.stringify({ summary: 'Read it.', read: [{ kind: 'file', path: 'README.md' }], ...extra })}`;
    writeFileSync(
      fake.scripts,
      JSON.stringify({ [WORK_ITEMS_KEY]: answer({ workItems }), [ONE_AGENT_KEY]: answer({ resources: [one] }), [SUGGEST_KEY]: answer({ resources }) }),
    );

    // ---- Suggest tasks, on a desktop ----
    await page.viewport(1440, 1000);
    await page.goto(`/tasks?project=${projectId}`, 1500);
    // A board worked by a team has the flow's button beside the views, and Suggest keeps its sparkle alone
    await page.click('.workitem-head .workitem-suggest-icon[aria-label="Suggest tasks"]', undefined, 800);
    await page.waitFor(`return location.search.includes('suggest=1') && !!document.querySelector('.dialog .suggest-body')`, { label: 'the dialog, in the address' });
    check((await page.text('.dialog')).includes('created in Backlog'), 'the dialog says where the tasks go');
    await page.fill('.suggest-focus input', 'what is left for v0.20');
    await page.click('.dialog .suggest-again', 'Suggest', 600);
    await page.waitFor(`return !!document.querySelector('.dialog .suggest-line')`, { label: 'the run answered', timeout: 30_000 });
    const line = await page.text('.dialog .suggest-line');
    check(line.includes('3 proposals'), `the done line counts the proposals (${line})`);
    check((await page.eval(`return document.querySelectorAll('.dialog .suggestion-row').length`)) === 3, 'one row per proposal');
    const similar = await page.eval(
      `const row = [...document.querySelectorAll('.dialog .suggestion-row')].find((r) => r.textContent.includes('milestone')); return row?.querySelector('.checkbox')?.getAttribute('data-state')`,
    );
    check(similar === 'unchecked', `a proposal like an existing item starts unselected (${similar})`);
    // The mark is a flex row, so innerText breaks the line between "Similar to" and the key
    const like = (await page.text('.dialog .suggestion-row:nth-child(3)')).replace(/\s+/g, ' ');
    check(like.includes(`Similar to ${existing.key}`), `it names the item it resembles (${like})`);
    check((await page.text('.dialog .dialog-foot')).includes('2 of 3 selected'), 'the footer counts the selection');
    check((await itemCount()) === before, 'nothing is created before the person creates it');

    // Discard one, and restore it
    await page.click('.dialog .suggestion-row .suggest-discard', 'Discard', 800);
    await page.waitFor(`return document.querySelectorAll('.dialog .suggestion-row.is-discarded').length === 1`, { label: 'the proposal is discarded' });
    await page.click('.dialog .suggestion-row.is-discarded button', 'Undo', 800);
    await page.waitFor(`return document.querySelectorAll('.dialog .suggestion-row.is-discarded').length === 0`, { label: 'and restored' });

    // With the flow on, creating them in Backlog queues a refine run each: the dialog says how many
    // before anyone presses Create, and says nothing while the flow is off
    check(!(await page.eval(`return !!document.querySelector('.dialog .suggest-flow-note')`)), 'with the flow off, no run is announced');
    await api.request('PUT', `/projects/${projectId}/team/product-owner`, { role: 'product-owner', model: 'opus', responsibility: 'Refines the backlog' });
    const settingsNow = (await api.get(`/projects/${projectId}/settings`)).body;
    const modules = [...new Set([...settingsNow.modules, 'board', 'team'])];
    const withFlow = { ...settingsNow, modules, flow: { enabled: true, columns: { backlog: 'product-owner' }, maxBounces: 3 } };
    check((await api.request('PUT', `/projects/${projectId}/settings`, withFlow)).status === 200, 'the flow was switched on');
    await page.waitFor(`return document.querySelector('.dialog .suggest-flow-note')?.textContent.includes('The flow will queue 2 runs, 2 at a time: Product Owner refines each task in Backlog')`, {
      label: 'the dialog says how many flow runs creating them queues',
    });
    // Off again, so this spec creates cards without starting runs
    await api.request('PUT', `/projects/${projectId}/settings`, { ...withFlow, flow: { ...withFlow.flow, enabled: false } });
    await page.waitFor(`return !document.querySelector('.dialog .suggest-flow-note')`, { label: 'and nothing once the flow is off' });

    await page.click('.dialog .suggest-create', 'Create the selected', 1000);
    await until(async () => (await itemCount()) === before + 2, 'the two selected tasks were created');
    const created = (await api.get(`/projects/${projectId}/work-items`)).body.find((w) => w.title === 'Undo the last move of a card');
    check(created?.status === 'backlog' && created.type === 'story' && created.epicId === epic.id, 'created in Backlog with its type and epic');
    await page.waitFor(`return document.querySelectorAll('.dialog .suggestion-row.is-accepted').length === 2`, { label: 'the rows say what they became' });
    check((await page.text('.dialog .suggestion-row.is-accepted')).includes(created.key), 'an accepted row names the key it got');
    check((await itemCount()) === before + 2, 'the unselected one was not created');

    // Closing leaves the board, which shows the new cards
    await page.click('.dialog .icon-btn[aria-label]', undefined, 600);
    await page.waitFor(`return !location.search.includes('suggest=1') && document.body.innerText.includes('Undo the last move of a card')`, { label: 'the new card on the board' });

    // ---- Suggest on the Resources tab: a proposal opens unsaved and is saved in the editor ----
    const agentPath = join(dir, '.claude/agents/migration-reviewer.md');
    await page.goto(`/?project=${projectId}&view=resources`, 1500);
    await page.waitFor(`return !!document.querySelector('.resources-toolbar .resources-suggest')`, { label: 'the Resources tab' });
    await page.click('.resources-toolbar .resources-suggest', 'Suggest', 600);
    await page.waitFor(`return document.querySelectorAll('.resources-proposals .suggestion-row').length === 2`, { label: 'two resource proposals', timeout: 30_000 });
    check((await page.text('.resources-proposals')).includes('.claude/agents/migration-reviewer.md'), 'a proposal says where it would be saved');
    check(!existsSync(agentPath), 'nothing is written before the proposal is saved');
    await page.click('.resources-proposals .suggestion-row button', 'Review', 1000);
    await page.waitFor(`return new URLSearchParams(location.search).has('proposal') && !!document.querySelector('.resource-proposal-editor')`, { label: 'the proposal in the editor' });
    const meta = await page.text('.resource-proposal-editor .editor-meta');
    // The badge is an uppercase label, which innerText reads as it is drawn
    check(/not saved yet/i.test(meta) && meta.includes('.claude/agents/migration-reviewer.md'), `it is unsaved and says where it goes (${meta})`);
    await page.click('.resource-proposal-actions .btn-primary', undefined, 1200);
    await until(() => existsSync(agentPath), 'saving the proposal writes the agent file');
    await page.waitFor(`return new URLSearchParams(location.search).get('res') === 'agents:migration-reviewer'`, { label: 'the editor holds the saved file' });

    // The other one is discarded from the card
    await page.goto(`/?project=${projectId}&view=resources`, 1500);
    await page.waitFor(`return document.querySelectorAll('.resources-proposals .suggestion-row.is-accepted').length === 1`, { label: 'the saved one says so' });
    await page.click('.resources-proposals .suggestion-row button', 'Discard', 800);
    await page.waitFor(`return document.querySelectorAll('.resources-proposals .suggestion-row.is-discarded').length === 1`, { label: 'the other is discarded' });
    check(!existsSync(join(dir, '.claude/commands/openapi.md')), 'a discarded resource is never written');

    // ---- Create with AI ----
    const onePath = join(dir, '.claude/agents/glossary-reviewer.md');
    await page.click('.resources-toolbar .resources-create-ai', 'Create with AI', 800);
    await page.waitFor(`return location.search.includes('ai=1') && !!document.querySelector('.dialog .create-ai-description')`, { label: 'the Create with AI dialog' });
    await page.fill('.dialog .create-ai-description', 'An agent that reads every new Spanish string against GLOSSARY.md');
    await page.click('.dialog .create-ai-start', 'Create', 600);
    await page.waitFor(`return !!document.querySelector('.dialog .create-ai-open:not([disabled])')`, { label: 'the resource is written', timeout: 30_000 });
    check((await page.text('.dialog .create-ai-result')).includes('glossary-reviewer'), 'it shows the file it wrote');
    check(!existsSync(onePath), 'nothing is saved before the editor saves it');
    await page.click('.dialog .create-ai-open', 'Open in the editor', 1000);
    await page.waitFor(`return !location.search.includes('ai=1') && !!document.querySelector('.resource-proposal-editor')`, { label: 'it opens in the editor' });
    await page.click('.resource-proposal-actions .btn-primary', undefined, 1200);
    await until(() => existsSync(onePath), 'saving it writes the agent file');

    // "Suggest" pressed with a file open leaves the editor, so the run and its proposals are in view
    await page.waitFor(`return !!document.querySelector('.resources-editor')`, { label: 'a file open in the editor' });
    await page.click('.resources-toolbar .resources-suggest', undefined, 600);
    await page.waitFor(`return !document.querySelector('.resources-editor') && !!document.querySelector('.resources-proposals')`, { label: 'Suggest shows its run', timeout: 30_000 });
    // Suggest leaves out what the project already has: migration-reviewer is a file now
    await page.waitFor(
      `const rows = [...document.querySelectorAll('.resources-proposals .suggestion-row')]; return rows.length === 1 && rows[0].textContent.includes('openapi')`,
      { label: 'the new proposal', timeout: 30_000 },
    );
    // "Create with AI" builds what it is asked for, a taken name included: the editor offers a free one
    await page.click('.resources-toolbar .resources-create-ai', 'Create with AI', 800);
    await page.waitFor(`return !!document.querySelector('.dialog .create-ai-description')`, { label: 'the Create with AI dialog, again' });
    await page.fill('.dialog .create-ai-description', 'An agent that reads every new Spanish string against GLOSSARY.md');
    await page.click('.dialog .create-ai-start', 'Create', 600);
    await page.waitFor(`return !!document.querySelector('.dialog .create-ai-open:not([disabled])')`, { label: 'the resource is written again', timeout: 30_000 });
    check((await page.text('.dialog .create-ai-result')).includes('glossary-reviewer-2'), 'it shows the free name it will be saved under');
    await page.click('.dialog .create-ai-open', 'Open in the editor', 1000);
    await page.waitFor(`return document.querySelector('.resource-proposal-name-input')?.value === 'glossary-reviewer-2'`, { label: 'a taken name becomes the first free one' });
    // On a phone the name is a 44 px target at 16 px, so iOS does not zoom into it
    await page.viewport(390, 844);
    await page.waitFor(`return !!document.querySelector('.resource-proposal-editor.is-phone .resource-proposal-name-input')`, { label: 'the proposal editor on a phone' });
    const nameBox = await page.eval(
      `const input = document.querySelector('.resource-proposal-name-input'); return { height: input.getBoundingClientRect().height, font: getComputedStyle(input).fontSize }`,
    );
    check(nameBox.height >= 44 && nameBox.font === '16px', `the phone's name field is a 44 px target at 16 px (${JSON.stringify(nameBox)})`);
    await page.viewport(1440, 1000);

    // ---- On a phone: the same suggestion as Include buttons, no checkboxes ----
    // The desktop created the first two by title, which now makes them "similar" too: the new run
    // proposes two new ones beside the one like an existing item
    const fresh = [
      { ...workItems[0], title: 'Redo a move that was undone', epic: null },
      { ...workItems[1], title: 'Column limit not checked on restore' },
      workItems[2],
    ];
    writeFileSync(
      fake.scripts,
      JSON.stringify({ [WORK_ITEMS_KEY]: answer({ workItems: fresh }), [ONE_AGENT_KEY]: answer({ resources: [one] }), [SUGGEST_KEY]: answer({ resources }) }),
    );
    await page.viewport(390, 844);
    await page.goto(`/tasks?project=${projectId}&suggest=1`, 1800);
    await page.waitFor(`return !!document.querySelector('.newtask-screen .suggest-body')`, { label: 'the full screen' });
    check((await page.eval(`return document.querySelectorAll('.newtask-screen .checkbox').length`)) === 0, 'a phone shows no checkboxes');
    await page.click('.newtask-screen .suggest-again', undefined, 600);
    await page.waitFor(`return document.querySelectorAll('.newtask-screen .suggestion-card .suggestion-pick').length === 3`, { label: 'the new run proposes again', timeout: 30_000 });
    const pressed = await page.eval(`return [...document.querySelectorAll('.newtask-screen .suggestion-pick')].map((b) => b.getAttribute('aria-pressed')).join(',')`);
    check(pressed === 'true,true,false', `included and not included, pressed or not (${pressed})`);
    const small = await page.eval(
      `return [...document.querySelectorAll('.newtask-screen .suggestion-pick, .newtask-screen .suggest-create')].filter((b) => b.getBoundingClientRect().height < 44).length`,
    );
    check(small === 0, 'every button is a 44 px target');
    check((await page.text('.newtask-screen .suggest-create')).includes('(2)'), 'the create button counts what is included');
  } finally {
    await page.viewport(1440, 900);
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
