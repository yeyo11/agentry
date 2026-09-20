import type { ResourceKind } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api, keys, type Scope } from '../api';
import { Card, Empty, ErrorBox, PageHeader, Skeleton, TabPanel, Tabs, useTabGroup } from '../components/ui';
import { DirtyProvider, useDirtyKeys, useLeaveGuard } from '../lib/dirty';
import { timeAgo } from '../lib/format';
import { AccountTab } from './config/AccountTab';
import { FilesTab } from './config/FilesTab';
import { InstructionsTab } from './config/InstructionsTab';
import { McpTab } from './config/McpTab';
import { PluginsTab } from './config/PluginsTab';
import { ResourcesTab } from './config/ResourcesTab';
import { SettingsTab } from './config/SettingsTab';
import { ToolPresetsTab } from './config/ToolPresetsTab';

const RESOURCE_TABS: ResourceKind[] = ['agents', 'skills', 'commands', 'output-styles', 'rules', 'workflows'];

// The label is a translation key, not text: the constant is built once, the language can change
const TABS = [
  { id: 'account', label: 'config:config.tabs.account' },
  { id: 'instructions', label: 'config:config.tabs.instructions' },
  { id: 'settings', label: 'config:config.tabs.settings' },
  { id: 'mcp', label: 'config:config.tabs.mcp' },
  { id: 'tools', label: 'config:config.tabs.tools' },
  { id: 'agents', label: 'config:config.tabs.agents' },
  { id: 'skills', label: 'config:config.tabs.skills' },
  { id: 'commands', label: 'config:config.tabs.commands' },
  { id: 'output-styles', label: 'config:config.tabs.output-styles' },
  { id: 'rules', label: 'config:config.tabs.rules' },
  { id: 'workflows', label: 'config:config.tabs.workflows' },
  { id: 'files', label: 'config:config.tabs.files' },
  { id: 'memory', label: 'home:settings.tabs.memory' },
  { id: 'plugins', label: 'home:settings.tabs.plugins' },
] as const;

type TabId = (typeof TABS)[number]['id'];

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

function SettingsInner() {
  const { t } = useTranslation(['home', 'config', 'work']);
  const [params, setParams] = useSearchParams();
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();
  const group = useTabGroup();

  const tab: TabId = TABS.find((item) => item.id === params.get('tab'))?.id ?? 'account';
  const select = (next: TabId) => void guard().then((ok) => ok && setParams({ tab: next }, { replace: true }));

  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('config:config.userScope')} />

      <Tabs
        label={t('settings.sections')}
        group={group}
        value={tab}
        tabs={TABS.map((tabItem) => ({ id: tabItem.id, label: t(tabItem.label), dirty: dirtyKeys.has(tabItem.id) }))}
        onChange={select}
      />

      <TabPanel className="tab-panel" key={tab} group={group} tab={tab}>
        {tab === 'account' && <AccountTab />}
        {tab === 'instructions' && <InstructionsTab scope={USER_SCOPE} scopeKey="user" />}
        {tab === 'settings' && <SettingsTab scope={USER_SCOPE} scopeKey="user" filesHref="/settings?tab=files" />}
        {tab === 'mcp' && <McpTab scope={USER_SCOPE} />}
        {tab === 'tools' && <ToolPresetsTab />}
        {RESOURCE_TABS.includes(tab as ResourceKind) && <ResourcesTab scope={USER_SCOPE} kind={tab as ResourceKind} />}
        {tab === 'files' && <FilesTab scope={USER_SCOPE} />}
        {tab === 'memory' && <MemoryOverview />}
        {tab === 'plugins' && <PluginsTab />}
      </TabPanel>
    </>
  );
}

export function Settings() {
  return (
    <DirtyProvider>
      <SettingsInner />
    </DirtyProvider>
  );
}
