// The Memory tab of a project (decisions 32 and 33 of docs/plans/project-ecosystem.md): proposals
// approved as they are, edited then approved, or discarded, one by one, each written where it says
// only once approved; the project journal with an entry added by hand; the CLI's own memory opening
// in the editor; the tab's idle count; and the phone's three tabs with 44 px targets.
import { seedEcosystem, seedProject } from './memory-seed.mjs';

export const timeout = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(condition, label, limit = 15_000) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await condition().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(200);
  }
}

const proposalCount = `return document.querySelectorAll('.memory-proposals .memory-proposal').length`;

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  try {
    const project = await seedProject({ api, check, dirs }, 'e2e-memory');
    projectId = project.id;
    await seedEcosystem({ api, check, dirs }, project);
    const pending = async () => (await api.get(`/projects/${projectId}/memory/proposals?status=pending`)).body;
    const proposal = async (text) => (await api.get(`/projects/${projectId}/memory/proposals`)).body.find((p) => p.text.includes(text));

    // ---- a desktop ----
    await page.viewport(1440, 1000);
    await page.goto(`/?project=${projectId}&view=memory`, 1500);
    await page.waitFor(`${proposalCount} === 3`, { label: 'three proposals wait' });
    check((await page.text('.project-tabs [role=tab][aria-selected=true] .count-idle')).trim() === '3', 'the Memory tab counts the proposals waiting, in idle');
    check(/3 wait for your approval/i.test(await page.text('.memory-card .memory-waiting')), 'the card says how many wait, in words');
    check((await page.text('.memory-proposal')).includes('CLAUDE.md'), 'the oldest proposal says where it will be written');
    check(await page.eval(`return !!document.querySelector('.memory-proposal .role-avatar[aria-label="Architect"]')`), 'who proposed it is its role');

    // Approve as it is: written to CLAUDE.md, under its section
    await page.click('.memory-proposal .memory-approve', 'Approve', 800);
    await until(async () => (await proposal('MIGRATIONS'))?.status === 'approved', 'the first proposal was approved');
    const claudeMd = (await api.get(`/config/instructions?project=${projectId}&variant=shared`)).body;
    check(claudeMd.content.includes('MIGRATIONS'), 'the approved text is in CLAUDE.md');
    await page.waitFor(`${proposalCount} === 2`, { label: 'the approved one leaves the list' });

    // Edit, then approve: what is written is the edited text
    await page.click('.memory-proposal .memory-edit', 'Edit', 400);
    await page.fill('.memory-proposal-edit textarea', 'Badge text in specs is compared case-insensitively.');
    await page.click('.memory-proposal-edit button[type=submit]', undefined, 800);
    await until(async () => (await proposal('e2e specs read'))?.status === 'approved', 'the edited proposal was approved');
    check((await proposal('e2e specs read')).approvedText === 'Badge text in specs is compared case-insensitively.', 'the edited text is what was approved');
    const files = (await api.get(`/memory/${projectId}`)).body;
    check(files.some((f) => f.name === 'e2e-badges.md' && f.content.includes('case-insensitively')), 'the edited text is in the memory file it named');

    // Discard: nothing is written
    const before = (await api.get(`/memory/${projectId}`)).body.find((f) => f.name === 'tests.md').content;
    await page.click('.memory-proposal .memory-reject', 'Discard', 800);
    await until(async () => (await proposal('Core tests'))?.status === 'rejected', 'the last proposal was discarded');
    check((await api.get(`/memory/${projectId}`)).body.find((f) => f.name === 'tests.md').content === before, 'a discarded proposal writes nothing');
    await until(async () => (await pending()).length === 0, 'nothing waits');
    await page.waitFor(`return document.querySelector('.memory-card .memory-none')?.textContent.includes('No proposal is waiting')`, { label: 'the card says none wait' });
    check(await page.eval(`return !document.querySelector('.project-tabs .count-idle')`), 'the tab loses its count');

    // The journal: the closed item and the decisions, grouped by day, and an entry added by hand
    const journal = await page.text('.journal-list');
    check(journal.includes('Per-project settings in a JSON') && /closed/.test(journal), `the closed item is in the journal (${journal.slice(0, 200)})`);
    check(journal.includes('Tasks carry no dates or estimates'), 'the decision written by hand is there');
    check(await page.eval(`return [...document.querySelectorAll('.journal-list .journal-day-label')].some((h) => h.textContent === 'Today')`), 'entries are grouped by day');
    await page.click('.memory-intro .btn', 'Add to the journal', 500);
    await page.fill('.dialog textarea', 'Documents live under docs/');
    await page.click('.dialog-foot .btn-primary', 'Add', 800);
    await until(async () => (await api.get(`/projects/${projectId}/journal`)).body.entries.some((e) => e.text === 'Documents live under docs/' && e.kind === 'decision'), 'the entry was added');
    await page.waitFor(`return document.querySelector('.journal-list')?.textContent.includes('Documents live under docs/')`, { label: 'the entry shows' });

    // What every agent gets, and the CLI's own files opening in the editor
    check((await page.text('.memory-handed')).includes('CLAUDE.md'), 'the handed card lists CLAUDE.md');
    await page.click('.memory-tree a', 'tests.md', 1200);
    await page.waitFor(`return new URLSearchParams(location.search).get('section') === 'files'`, { label: 'the editor opens' });
    await page.waitFor(`return document.querySelector('.master-item-on')?.textContent.includes('tests.md')`, { label: 'on the file clicked' });
    await page.click('.memory-editor-back', undefined, 800);
    await page.waitFor(`return !!document.querySelector('.memory-grid')`, { label: 'back to the tab' });

    // ---- a phone: three tabs of one screen ----
    await page.viewport(390, 844);
    await page.goto(`/?project=${projectId}&view=memory`, 1500);
    await page.waitFor(`return document.querySelectorAll('.memory-phone [role=radio]').length === 3`, { label: 'three tabs' });
    const small = await page.eval(
      `return [...document.querySelectorAll('.memory-phone [role=radio], .memory-phone .btn')].filter((el) => el.offsetParent && el.getBoundingClientRect().height < 44).map((el) => el.textContent.trim())`,
    );
    check(small.length === 0, `phone targets are at least 44 px (${JSON.stringify(small)})`);
    await page.click('.memory-phone [role=radio]', 'Journal', 800);
    await page.waitFor(`return document.querySelectorAll('.journal-card').length >= 3`, { label: 'the journal as cards' });
    await page.click('.memory-phone [role=radio]', 'From the CLI', 800);
    await page.waitFor(`return document.querySelector('.memory-phone .doc-cells')?.textContent.includes('tests.md')`, { label: 'the memory files as cells' });
    check(await page.eval(`return !document.querySelector('.memory-phone input[type=checkbox]')`), 'no checkbox on a phone');
  } finally {
    await page.viewport(1440, 900);
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
