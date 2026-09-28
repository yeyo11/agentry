// A work item's documents and its waiting state (decisions 29, 30 and 34 of
// docs/plans/project-ecosystem.md): the documents tied to it, named by their heading and opening on
// the Documents tab, one tied by hand; QA's pass waiting for the person's approval, and the last
// bounce waiting for the person, each with the move that ends the wait. On a desktop and a phone.
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

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  try {
    const project = await seedProject({ api, check, dirs }, 'e2e-documents-item');
    projectId = project.id;
    const seeded = await seedEcosystem({ api, check, dirs }, project);
    const item = async (id) => (await api.get(`/work-items/${id}`)).body;

    // ---- its documents ----
    await page.viewport(1440, 1000);
    await page.goto(`/tasks/${seeded.board.key}?project=${projectId}`, 1500);
    await page.waitFor(`return document.querySelector('.workitem-docs .doc-row')?.textContent.includes('Board with fixed columns and limits')`, {
      label: 'the tied document, named by its heading',
    });
    const row = await page.text('.workitem-docs .doc-row');
    check(row.includes('SPEC') && row.includes('Architect'), `the row says its kind and the role that wrote it (${row})`);
    check(!(await page.text('.work-links')).includes('board.md'), 'a document is not listed with the chats');

    // Tie one by hand, with its kind
    await page.click('.workitem-docs .workitem-add', 'Tie', 600);
    await page.fill('.dialog .relation-search input', 'status');
    await page.click('.dialog .relation-pick', 'docs/status.md', 1000);
    await until(async () => (await item(seeded.board.id)).links.some((l) => l.kind === 'document' && l.documentPath === 'docs/status.md' && l.role === 'reference'), 'the document was tied by hand');
    await page.waitFor(`return document.querySelectorAll('.workitem-docs .doc-row').length === 2`, { label: 'the section lists it' });

    // A document opens on its project's Documents tab
    await page.click('.workitem-docs .doc-row', 'Board with fixed columns and limits', 1500);
    await page.waitFor(`const q = new URLSearchParams(location.search); return location.pathname === '/' && q.get('view') === 'documents' && q.get('doc') === 'docs/specs/board.md'`, {
      label: 'the Documents tab, on that document',
    });
    await page.waitFor(`return !!document.querySelector('.doc-view .md-h1')`, { label: 'the document renders' });

    // ---- QA passed it: it waits for the person's approval (DesktopTarea) ----
    // "Waits for you" beside the column, QA's word in the activity, and "Move to Done" as the approval:
    // no panel of its own, which the reference does not draw
    await page.goto(`/tasks/${seeded.templates.key}?project=${projectId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.workitem-head .workitem-waiting-badge.badge-idle')`, { label: 'the waiting badge' });
    const badge = await page.text('.workitem-head .workitem-waiting-badge');
    check(/waits for you/i.test(badge), `it says it waits for the person, in words (${badge})`);
    check(await page.eval(`return !document.querySelector('.item-wait:not(.is-quiet)')`), 'no approval panel repeats what the head says');
    check((await page.text('.item-wait.is-quiet')).includes('bounce 1 of 3'), 'its bounces show, neutral');
    check((await page.text('.workitem-activity')).includes('Every criterion holds'), "QA's latest word is in the activity");
    await page.click('.workitem-head .workitem-done', 'Move to Done', 1000);
    // Its criterion is unchecked in the seed: approving asks first
    await page.click('[role=dialog] .btn-primary', 'Move to Done', 1000);
    await until(async () => {
      const now = await item(seeded.templates.id);
      return now.status === 'done' && !now.waiting;
    }, "the person's approval moved it to Done and ended the wait");
    await page.waitFor(`return !document.querySelector('.workitem-waiting-badge')`, { label: 'the waiting badge is gone' });

    // ---- QA sent it back three times of three: it waits for the person ----
    await page.goto(`/tasks/${seeded.cost.key}?project=${projectId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.item-wait .badge-idle')`, { label: 'the last bounce waits' });
    const bounces = await page.text('.item-wait');
    check(/waiting for you/i.test(bounces) && bounces.includes('QA sent it back 3 times') && bounces.includes('bounce 3 of 3'), `it says it used its bounces (${bounces})`);
    check(await page.eval(`return !!document.querySelector('.workitem-head .workitem-waiting-badge')`), 'and the head says it waits for the person too');

    // ---- the same on a phone: the actions are full-width, 44 px ----
    await page.viewport(390, 844);
    await page.goto(`/tasks/${seeded.cost.key}?project=${projectId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.item-wait .workitem-send-back')`, { label: 'the waiting state on a phone' });
    const heights = await page.eval(`return [...document.querySelectorAll('.item-wait-actions .btn')].map((b) => b.getBoundingClientRect().height)`);
    check(heights.length === 2 && heights.every((h) => h >= 44), `both actions are 44 px targets (${JSON.stringify(heights)})`);
    await page.click('.item-wait .workitem-send-back', 'Back to In progress', 1000);
    await until(async () => {
      const now = await item(seeded.cost.id);
      return now.status === 'in_progress' && !now.waiting && (now.bounces ?? 0) === 0;
    }, "the person's move starts a new round: no wait, no bounces");
  } finally {
    await page.viewport(1440, 900);
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
