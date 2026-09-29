// Accessibility of a project and its board (see a11y-shared.mjs): the project's page and its views,
// the new project wizard, the board and its list, every project's tasks, milestones and a work item,
// in both themes and at phone and tablet width; the board's overlays; status never colour alone.
import { a11ySpec, checkStatusWords, checkTablet, OVERLAY_RULES, scanBothThemes, scanNarrow, settle } from './a11y-shared.mjs';

export const timeout = 300_000;

export default a11ySpec(async ({ page, problems, scan, fx }) => {
  const { projectId, story, board, itemPage, milestones } = fx;
  const pages = [
    `/?project=${projectId}`,
    ...['board', 'settings', 'memory', 'resources', 'worktrees'].map((view) => `/?project=${projectId}&view=${view}`),
    '/projects/new',
    board,
    `${board}&view=list`,
    '/tasks?project=all',
    milestones,
    itemPage,
  ];
  await scanBothThemes(page, pages, scan);

  // ---------- axe: phone and tablet width ----------
  await scanNarrow(
    page,
    [`/?project=${projectId}`, `/?project=${projectId}&view=settings`, `/?project=${projectId}&view=board`, `/?project=${projectId}&view=resources`, '/projects/new', board, `${board}&view=list`, milestones, itemPage],
    scan,
    problems,
  );
  await checkTablet(page, [`/?project=${projectId}`, board, itemPage], problems);

  // The board's own overlays: New task, a work item in its panel, and a move menu on a phone
  await page.goto(`${board}&new=1`, 800);
  await page.waitFor(`return !!document.querySelector('[role=dialog] .newtask-form, [role=dialog] form')`, { label: 'the New task dialog' });
  await scan(page, 'new task dialog', { rules: OVERLAY_RULES });
  await page.key('Escape');
  await page.goto(`${board}&item=${story.key}`, 800);
  await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(story.title)})`, { label: 'the work item panel' });
  await scan(page, 'work item panel', { rules: OVERLAY_RULES });
  await page.key('Escape');
  // …and orchestration 4's: Suggest tasks before it runs, and Create with AI on the Resources tab
  await page.goto(`${board}&suggest=1`, 800);
  await page.waitFor(`return !!document.querySelector('[role=dialog] .suggest-body')`, { label: 'the Suggest tasks dialog' });
  await scan(page, 'suggest tasks dialog', { rules: OVERLAY_RULES });
  await page.key('Escape');
  await page.goto(`/?project=${projectId}&view=resources&ai=1`, 800);
  await page.waitFor(`return !!document.querySelector('[role=dialog] .create-ai-description')`, { label: 'the Create with AI dialog' });
  await scan(page, 'create with AI dialog', { rules: OVERLAY_RULES });
  await page.key('Escape');
  await page.viewport(420, 900);
  await settle(page, `${board}&new=1`);
  await scan(page, '420px new task screen', { rules: OVERLAY_RULES });
  await settle(page, `${board}&suggest=1`);
  await scan(page, '420px suggest tasks screen', { rules: OVERLAY_RULES });
  await page.viewport(1440, 900);

  // ---------- status is never colour alone ----------
  await checkStatusWords(page, [board, `${board}&view=list`, milestones, itemPage], problems);
});
