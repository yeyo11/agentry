// The tabs of Settings and where each one lives: plain data, so a test can read it without the page.

/** A section of the Decisions tab; `?tab=supervisor` scrolls to one. */
export type DecisionsSection = 'engine' | 'points' | 'supervisor';

// The label is a translation key, not text: the constant is built once, the language can change
export const TAB_LABELS = {
  appearance: 'shell:appearance.tab',
  notifications: 'config:config.tabs.notifications',
  account: 'config:config.tabs.account',
  instructions: 'config:config.tabs.instructions',
  settings: 'config:config.tabs.settings',
  memory: 'home:settings.tabs.memory',
  rules: 'config:config.tabs.rules',
  'output-styles': 'config:config.tabs.output-styles',
  mcp: 'config:config.tabs.mcp',
  plugins: 'home:settings.tabs.plugins',
  skills: 'config:config.tabs.skills',
  agents: 'config:config.tabs.agents',
  commands: 'config:config.tabs.commands',
  workflows: 'config:config.tabs.workflows',
  tools: 'config:config.tabs.tools',
  files: 'config:config.tabs.files',
  install: 'config:config.tabs.install',
  decisions: 'decisions:tab',
  security: 'config:config.tabs.security',
  remote: 'config:config.tabs.remote',
} as const;

export type TabId = keyof typeof TAB_LABELS;

/**
 * Twenty tabs read as four questions: how Agentry itself behaves, what Claude Code is told, what it
 * is extended with, and the machine it runs on. The `?tab=` ids are the old flat ones, so every
 * deep link (the palette, the update dot, the docs) still lands where it did.
 */
export const GROUPS: ReadonlyArray<{ id: 'agentry' | 'claude' | 'extensions' | 'system'; tabs: readonly TabId[] }> = [
  { id: 'agentry', tabs: ['appearance', 'notifications', 'account', 'decisions'] },
  { id: 'claude', tabs: ['instructions', 'settings', 'memory', 'rules', 'output-styles'] },
  { id: 'extensions', tabs: ['mcp', 'plugins', 'skills', 'agents', 'commands', 'workflows', 'tools'] },
  { id: 'system', tabs: ['files', 'install', 'security', 'remote'] },
];

export const TAB_ORDER: TabId[] = GROUPS.flatMap((group) => group.tabs);

export const isTab = (value: string | null): value is TabId => value !== null && Object.hasOwn(TAB_LABELS, value);

/** Ids that moved: the Supervisor tab is now a section of Decisions, and its old link scrolls to it. */
const TAB_ALIASES: Readonly<Record<string, { tab: TabId; section: DecisionsSection }>> = {
  supervisor: { tab: 'decisions', section: 'supervisor' },
};

export function resolveTab(asked: string | null): { tab: TabId | null; section?: DecisionsSection } {
  if (isTab(asked)) return { tab: asked };
  const alias = asked !== null && Object.hasOwn(TAB_ALIASES, asked) ? TAB_ALIASES[asked] : undefined;
  return alias ?? { tab: null };
}
