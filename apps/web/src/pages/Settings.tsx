import type { ResourceKind } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api, keys, type Scope } from '../api';
import { ICON } from '../components/icons';
import { Card, Empty, ErrorBox, Segmented, Skeleton, usePageTitle, useTabGroup } from '../components/ui';
import { DirtyProvider, useDirtyKeys, useLeaveGuard } from '../lib/dirty';
import { timeAgo } from '../lib/format';
import { NARROW, useMediaQuery } from '../lib/media';
import { setThemePreference, useThemePreference, type ThemePreference } from '../lib/theme';
import { AccountTab } from './config/AccountTab';
import { AppearanceTab } from './config/AppearanceTab';
import { EditorTab } from './config/EditorTab';
import { FilesTab } from './config/FilesTab';
import { InstallTab } from './config/InstallTab';
import { InstructionsTab } from './config/InstructionsTab';
import { McpTab } from './config/McpTab';
import { NotificationsTab } from './config/NotificationsTab';
import { PluginsTab } from './config/PluginsTab';
import { ResourcesTab } from './config/ResourcesTab';
import { SecurityTab } from './config/SecurityTab';
import { SettingsTab } from './config/SettingsTab';
import { SupervisorTab } from './config/SupervisorTab';
import { ToolPresetsTab } from './config/ToolPresetsTab';

const RESOURCE_TABS: ResourceKind[] = ['agents', 'skills', 'commands', 'output-styles', 'rules', 'workflows'];

// The label is a translation key, not text: the constant is built once, the language can change
const TAB_LABELS = {
  appearance: 'shell:appearance.tab',
  notifications: 'config:config.tabs.notifications',
  editor: 'observe:editor.tab',
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
  supervisor: 'observe:supervisor.tab',
  security: 'config:config.tabs.security',
} as const;

type TabId = keyof typeof TAB_LABELS;

/**
 * Twenty tabs read as four questions: how Agentry itself behaves, what Claude Code is told, what it
 * is extended with, and the machine it runs on. The `?tab=` ids are the old flat ones, so every
 * deep link (the palette, the update dot, the docs) still lands where it did.
 */
const GROUPS: ReadonlyArray<{ id: 'agentry' | 'claude' | 'extensions' | 'system'; tabs: readonly TabId[] }> = [
  { id: 'agentry', tabs: ['appearance', 'notifications', 'editor', 'account'] },
  { id: 'claude', tabs: ['instructions', 'settings', 'memory', 'rules', 'output-styles'] },
  { id: 'extensions', tabs: ['mcp', 'plugins', 'skills', 'agents', 'commands', 'workflows', 'tools'] },
  { id: 'system', tabs: ['files', 'install', 'supervisor', 'security'] },
];

const TAB_ORDER: TabId[] = GROUPS.flatMap((group) => group.tabs);

// These edit what the CLI reads from ~/.claude: the heading says whose files they are
const CLAUDE_GROUPS = new Set(['claude', 'extensions']);

const isTab = (value: string | null): value is TabId => value !== null && Object.hasOwn(TAB_LABELS, value);

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

// The user scope is the empty one: no project id means the account's own files
const USER_SCOPE: Scope = {};

/** Claude's memory is kept per project, so the user scope only gets the way to each project's. */
function MemoryOverview() {
  const { t } = useTranslation(['home', 'config', 'work']);
  const { data, error, isLoading } = useQuery({ queryKey: keys.memoryProjects, queryFn: api.memoryProjects, refetchInterval: 15_000 });
  const projects = data ?? [];

  return (
    <Card title={t('settings.memory.title')}>
      <p className="small muted">
        {t('settings.memory.intro')}
      </p>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={4} />
      ) : projects.length === 0 ? (
        <Empty
          title={t('settings.memory.none')}
          action={
            <Link to="/projects" className="btn btn-primary">
              {t('settings.memory.goToProjects')}
            </Link>
          }
        >
          {t('settings.memory.noneHint')}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('work:shared.project')}</th>
                <th scope="col">{t('config:config.tabs.files')}</th>
                <th scope="col">{t('settings.memory.lastUpdate')}</th>
                <th scope="col">
                  <span className="sr-only">{t('settings.memory.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.projectId}>
                  <td>
                    <div className="strong">{project.projectName}</div>
                    <div className="small muted mono break">{project.projectPath}</div>
                  </td>
                  <td>
                    <span className={`count ${project.fileCount > 0 ? 'count-on' : ''}`}>{project.fileCount}</span>
                  </td>
                  <td className="small muted">{project.lastUpdated ? timeAgo(project.lastUpdated) : '—'}</td>
                  <td>
                    <div className="row-actions">
                      <Link
                        className="btn btn-small"
                        to={`/?project=${encodeURIComponent(project.projectId)}&tab=memory`}
                        aria-label={t('settings.memory.openNamed', { name: project.projectName })}
                      >
                        {t('settings.memory.open')}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** What one tab holds. */
function TabContent({ tab }: { tab: TabId }) {
  return (
    <>
      {tab === 'appearance' && <AppearanceTab />}
      {tab === 'account' && <AccountTab />}
      {tab === 'instructions' && <InstructionsTab scope={USER_SCOPE} scopeKey="user" />}
      {tab === 'settings' && <SettingsTab scope={USER_SCOPE} scopeKey="user" filesHref="/settings?tab=files" />}
      {tab === 'mcp' && <McpTab scope={USER_SCOPE} />}
      {tab === 'tools' && <ToolPresetsTab />}
      {RESOURCE_TABS.includes(tab as ResourceKind) && <ResourcesTab scope={USER_SCOPE} kind={tab as ResourceKind} />}
      {tab === 'files' && <FilesTab scope={USER_SCOPE} />}
      {tab === 'memory' && <MemoryOverview />}
      {tab === 'plugins' && <PluginsTab />}
      {tab === 'editor' && <EditorTab />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'install' && <InstallTab />}
      {tab === 'supervisor' && <SupervisorTab />}
      {tab === 'security' && <SecurityTab />}
    </>
  );
}

function groupOf(tab: TabId): string {
  return GROUPS.find((group) => group.tabs.includes(tab))?.id ?? 'agentry';
}

/** What the heading of a tab says under its name, when there is something worth saying. */
function useTabSubtitle(tab: TabId): string | null {
  const { t } = useTranslation(['config', 'shell']);
  if (tab === 'appearance') return t('shell:appearance.intro');
  // Tool presets are Agentry's own, kept by the server and not in ~/.claude
  if (CLAUDE_GROUPS.has(groupOf(tab)) && tab !== 'tools') return t('config.userScope');
  return null;
}

/**
 * The desktop: the groups as a side nav next to the tab's page. It is still one ARIA tablist, laid
 * out vertically, so it keeps one Tab stop and the arrow keys. The group names are headings a
 * sighted reader scans; a screen reader hears each one as the description of its tabs.
 */
function DesktopSettings({ tab, onSelect }: { tab: TabId; onSelect: (next: TabId) => void }) {
  const { t } = useTranslation(['home', 'config', 'observe', 'shell', 'components']);
  const dirtyKeys = useDirtyKeys();
  const group = useTabGroup();
  const subtitle = useTabSubtitle(tab);
  const tabId = (id: TabId) => `${group}-tab-${id}`;
  const panelId = `${group}-panel`;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = TAB_ORDER.indexOf(tab);
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    let next: TabId | undefined;
    if (event.key === 'Home') next = TAB_ORDER[0];
    else if (event.key === 'End') next = TAB_ORDER[TAB_ORDER.length - 1];
    else if (forward || backward) next = TAB_ORDER[(at + (forward ? 1 : -1) + TAB_ORDER.length) % TAB_ORDER.length];
    if (!next) return;
    event.preventDefault();
    document.getElementById(tabId(next))?.focus();
    onSelect(next);
  };

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-labelledby={`${group}-title`}>
        <h1 id={`${group}-title`} className="settings-title">
          {t('settings.title')}
        </h1>
        <div className="settings-nav-tabs" role="tablist" aria-orientation="vertical" aria-label={t('settings.sections')}>
          {GROUPS.map((item) => (
            <div key={item.id} className="settings-nav-group">
              <span id={`${group}-group-${item.id}`} className="section-label settings-nav-label" aria-hidden>
                {t(`config:config.groups.${item.id}`)}
              </span>
              {item.tabs.map((id) => {
                const on = id === tab;
                const dirty = dirtyKeys.has(id);
                return (
                  <button
                    key={id}
                    id={tabId(id)}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-controls={panelId}
                    aria-describedby={`${group}-group-${item.id}`}
                    tabIndex={on ? 0 : -1}
                    className={`settings-nav-item ${on ? 'is-on' : ''}`}
                    onClick={() => !on && onSelect(id)}
                    onKeyDown={onKeyDown}
                  >
                    <span className="settings-nav-name">{t(TAB_LABELS[id])}</span>
                    {dirty && <span className="tab-dirty" aria-hidden />}
                    {dirty && <span className="sr-only"> ({t('components:ui.unsavedChangesLabel')})</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>

      <div className="settings-body" role="tabpanel" id={panelId} aria-labelledby={tabId(tab)} key={tab}>
        <header className="settings-head">
          <h2 className="settings-head-title">{t(TAB_LABELS[tab])}</h2>
          {subtitle && <p className="settings-head-sub">{subtitle}</p>}
        </header>
        <TabContent tab={tab} />
      </div>
    </div>
  );
}

/** The phone's first screen: the theme at hand, then every tab as a cell in its group's card. */
function PhoneSettingsList() {
  const { t } = useTranslation(['home', 'config', 'observe', 'shell', 'components']);
  const dirtyKeys = useDirtyKeys();
  const theme = useThemePreference();

  return (
    <div className="settings-phone">
      <header className="settings-phone-head">
        <h1 className="settings-phone-title">{t('settings.title')}</h1>
      </header>

      <section className="card settings-phone-theme" aria-labelledby="settings-phone-theme">
        <h2 id="settings-phone-theme" className="section-label">
          {t('shell:appearance.theme')}
        </h2>
        <Segmented
          label={t('shell:appearance.theme')}
          value={theme}
          onChange={setThemePreference}
          options={THEMES.map((value) => ({ value, label: t(`shell:appearance.themeOptions.${value}`) }))}
        />
      </section>

      {GROUPS.map((group) => (
        <section key={group.id} className="settings-cells-group" aria-labelledby={`settings-group-${group.id}`}>
          <h2 id={`settings-group-${group.id}`} className="section-label settings-cells-label">
            {t(`config:config.groups.${group.id}`)}
          </h2>
          <ul className="card settings-cells">
            {group.tabs.map((id) => (
              <li key={id}>
                <Link className="settings-cell" to={`/settings?tab=${id}`}>
                  {/* The theme is already above, so the Appearance cell is named for what is left in it */}
                  <span className="settings-cell-name">{id === 'appearance' ? t('config:config.phone.appearance') : t(TAB_LABELS[id])}</span>
                  {dirtyKeys.has(id) && (
                    <>
                      <span className="tab-dirty" aria-hidden />
                      <span className="sr-only"> ({t('components:ui.unsavedChangesLabel')})</span>
                    </>
                  )}
                  <ChevronRight className="settings-cell-chevron" {...ICON} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A tab on a phone is a screen of its own, with the way back to the list above it. */
function PhoneSettingsTab({ tab, onBack }: { tab: TabId; onBack: () => void }) {
  const { t } = useTranslation(['home', 'config', 'observe', 'shell', 'components']);
  const subtitle = useTabSubtitle(tab);
  return (
    <div className={`settings-phone ${tab === 'install' ? 'glow-top settings-phone-install' : ''}`}>
      <header className="settings-phone-head">
        <button type="button" className="icon-btn settings-phone-back" aria-label={t('config:config.phone.back')} onClick={onBack}>
          <ChevronLeft {...ICON} />
        </button>
        <h1 className="settings-phone-title">{t(TAB_LABELS[tab])}</h1>
      </header>
      {subtitle && <p className="settings-head-sub">{subtitle}</p>}
      <TabContent tab={tab} />
    </div>
  );
}

function SettingsInner() {
  const { t } = useTranslation('home');
  const [params, setParams] = useSearchParams();
  const guard = useLeaveGuard();
  const phone = useMediaQuery(NARROW);
  usePageTitle(t('settings.title'));

  const asked = params.get('tab');
  const select = (next: TabId) => void guard().then((ok) => ok && setParams({ tab: next }, { replace: true }));

  if (phone) {
    if (!isTab(asked)) return <PhoneSettingsList />;
    // Back is a step up to the list, not through history: a deep link has nothing behind it
    return <PhoneSettingsTab tab={asked} onBack={() => void guard().then((ok) => ok && setParams({}))} />;
  }
  return <DesktopSettings tab={isTab(asked) ? asked : 'appearance'} onSelect={select} />;
}

export function Settings() {
  return (
    <DirtyProvider>
      <SettingsInner />
    </DirtyProvider>
  );
}
