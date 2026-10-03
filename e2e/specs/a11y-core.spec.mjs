// Accessibility of the app's own pages (see a11y-shared.mjs): the contrast of the theme tokens, and
// axe over Home, the chats, the orchestrations, connectors and every Settings tab, in both themes.
import { a11ySpec, scanBothThemes, SESSION, SETTINGS_TABS, tokenContrast } from './a11y-shared.mjs';

// Two themes and two dozen pages
export const timeout = 300_000;

export default a11ySpec(async ({ page, problems, scan, fx }) => {
  const pages = [
    '/',
    '/chats',
    '/chats/new',
    `/chats/${SESSION}`,
    '/projects',
    '/orchestration',
    `/orchestration/${fx.orchestrationId}`,
    '/connectors',
    ...SETTINGS_TABS.map((tab) => `/settings?tab=${tab}`),
  ];
  await scanBothThemes(page, pages, scan, (theme) => tokenContrast(page, theme, problems));
});
