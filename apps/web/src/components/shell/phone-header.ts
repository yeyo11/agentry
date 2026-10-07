/**
 * Who heads a screen on a phone, decided by route: the app's top bar (scope, search, the bell), or
 * the page itself, with a back arrow, its title and a "⋯" sheet (design system, decision 4). Night
 * Shift draws every phone detail screen the second way; the routes below are the ones switched to
 * it so far. Moving another screen over is one entry here plus the page drawing `PhoneHeader`.
 * Pure, so the table is tested without a browser (test/shell-design.test.tsx).
 */

/** `app`: the shell's top bar. `page`: no top bar on a phone, the page draws its own header. */
export type PhoneHeaderMark = 'app' | 'page';

export interface PhoneHeaderRoute {
  /** The route's pathname, trailing slash allowed */
  path: RegExp;
  /** Only when a project is in scope: a project's page and its tabs live at `/` */
  projectPage?: boolean;
  phoneHeader: 'page';
}

/**
 * The ecosystem's screens (orchestration 7, the owner's decision on phone headers). A task's chat
 * and a flow run's chat are the chat page, shared by every chat, and keep the chat's own header
 * until the rest of the app moves over.
 */
export const PHONE_HEADER_ROUTES: readonly PhoneHeaderRoute[] = [
  // A project's page and every tab of it: the board, the team, a member, the flow, documents, memory,
  // resources (MobileProyecto, MobileMiembro, MobileFlujo, MobileDocumento…)
  { path: /^\/$/, projectPage: true, phoneHeader: 'page' },
  // The new project wizard: a modal flow, headed by "Cerrar" instead of a back arrow
  { path: /^\/projects\/new\/?$/, phoneHeader: 'page' },
  // The project assistant (MobileAsistente)
  { path: /^\/projects\/[^/]+\/assistant\/?$/, phoneHeader: 'page' },
  // The Agentry assistant's entry (MobileAsistenteAgentry); its chat is the chat page and keeps the chat's header
  { path: /^\/assistant\/?$/, phoneHeader: 'page' },
  // Tasks, the board and the list reached from Más, and a new task (MobileTablero, MobileNuevaTarea)
  { path: /^\/tasks\/?$/, phoneHeader: 'page' },
  // The milestones and a work item's page (MobileHitos, MobileTarea); the review of an item's
  // changes is a screen of its own and keeps the bar
  { path: /^\/tasks\/[^/]+\/?$/, phoneHeader: 'page' },
];

export function phoneHeaderOf(pathname: string, projectPage = false): PhoneHeaderMark {
  const route = PHONE_HEADER_ROUTES.find((entry) => entry.path.test(pathname) && (entry.projectPage === undefined || entry.projectPage === projectPage));
  return route?.phoneHeader ?? 'app';
}
