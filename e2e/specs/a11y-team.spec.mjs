// Accessibility of a project's team, documents, memory and assistant (see a11y-shared.mjs):
// orchestration 3's and 4's screens, in both themes and at phone width, and status never colour alone.
import { a11ySpec, checkStatusWords, scanBothThemes, scanNarrow } from './a11y-shared.mjs';

export const timeout = 300_000;

export default a11ySpec(async ({ page, problems, scan, fx }) => {
  const pages = [...fx.ecosystem, ...fx.assistant];
  await scanBothThemes(page, pages, scan);
  await scanNarrow(page, pages, scan, problems);
  await page.viewport(1440, 900);
  await checkStatusWords(page, pages, problems);
});
