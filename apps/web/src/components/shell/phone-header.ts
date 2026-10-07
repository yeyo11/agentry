/**
 * Who heads a screen on a phone, decided by route: the app's top bar (scope, search, the bell), or
 * the page itself, with a back arrow, its title and a "⋯" sheet (design system, decision 4). Night
 * Shift draws every phone detail screen the second way, and every one of them is listed below; the
 * tab roots (Home without a project, Chats, Orchestrations) and the 404 page keep the bar. A new
 * detail screen is one entry here plus the page drawing its header (`PhoneHeader`, or the chat's and
 * the changes screen's own).
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
 * The ecosystem's screens (orchestration 7, the owner's decision on phone headers), then the rest of
 * the app (CW-8, docs/plans/phone-headers-rest-of-app.md). The chat page, which is also a task's chat
 * and a flow run's chat, and the changes screen keep their own headers rather than `PhoneHeader`.
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
  // The milestones and a work item's page (MobileHitos, MobileTarea)
  { path: /^\/tasks\/[^/]+\/?$/, phoneHeader: 'page' },
  // A new chat, a modal flow closed with ✕ (MobileNuevoChat); listed before a chat, which it also matches
  { path: /^\/chats\/new\/?$/, phoneHeader: 'page' },
  // A chat, a task's chat and a flow run's chat (MobileChat, MobileChatTarea, MobileChatFlujo): `.chat-head`
  { path: /^\/chats\/[^/]+\/?$/, phoneHeader: 'page' },
  // The review of changes (MobileCambios, MobilePasos, MobileDiff): `.changes-head`
  { path: /^\/chats\/[^/]+\/changes\/?$/, phoneHeader: 'page' },
  { path: /^\/tasks\/[^/]+\/changes\/?$/, phoneHeader: 'page' },
  { path: /^\/orchestration\/[^/]+\/(?:tasks\/[^/]+\/)?changes\/?$/, phoneHeader: 'page' },
  // An orchestration (MobileOrquestacion)
  { path: /^\/orchestration\/[^/]+\/?$/, phoneHeader: 'page' },
  // The screens reached from Más (MobileCuentas, MobileProyectos, MobileProgramaciones, MobileUso,
  // MobileConectores, MobileAjustes)
  { path: /^\/projects\/?$/, phoneHeader: 'page' },
  { path: /^\/schedules\/?$/, phoneHeader: 'page' },
  // The schedule editor, a modal flow headed by "Cancelar" (the MobileNuevaTarea pattern)
  { path: /^\/schedules\/(?:new|[^/]+\/edit)\/?$/, phoneHeader: 'page' },
  { path: /^\/usage\/?$/, phoneHeader: 'page' },
  { path: /^\/connectors\/?$/, phoneHeader: 'page' },
  // Settings, its list and each tab (MobileAjustes, MobileInstalar)
  { path: /^\/settings\/?$/, phoneHeader: 'page' },
];

export function phoneHeaderOf(pathname: string, projectPage = false): PhoneHeaderMark {
  const route = PHONE_HEADER_ROUTES.find((entry) => entry.path.test(pathname) && (entry.projectPage === undefined || entry.projectPage === projectPage));
  return route?.phoneHeader ?? 'app';
}
