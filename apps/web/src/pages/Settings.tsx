import type { ResourceKind } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
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

const RESOURCE_TABS: ResourceKind[] = ['agents', 'skills', 'commands', 'output-styles', 'rules', 'workflows'];

const TABS = [
  { id: 'account', label: 'Account' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'settings', label: 'Settings' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'commands', label: 'Commands' },
  { id: 'output-styles', label: 'Output styles' },
  { id: 'rules', label: 'Rules' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'files', label: 'Files' },
  { id: 'memory', label: 'Memory' },
  { id: 'plugins', label: 'Plugins' },
] as const;

type TabId = (typeof TABS)[number]['id'];

// The user scope is the empty one: no project id means the account's own files
const USER_SCOPE: Scope = {};

/** Claude's memory is kept per project, so the user scope only gets the way to each project's. */
function MemoryOverview() {
  const { data, error, isLoading } = useQuery({ queryKey: keys.memoryProjects, queryFn: api.memoryProjects, refetchInterval: 15_000 });
  const projects = data ?? [];

  return (
    <Card title="Memory">
      <p className="small muted">
        Claude keeps its memory per project, so it is read and edited on the project page, in its Memory tab.
      </p>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={4} />
      ) : projects.length === 0 ? (
        <Empty
          title="No projects imported"
          action={
            <Link to="/projects" className="btn btn-primary">
              Go to Projects
            </Link>
          }
        >
          Import a project to see the memory Claude keeps for it.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Files</th>
                <th scope="col">Last update</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
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
                        aria-label={`Open the memory of ${project.projectName}`}
                      >
                        Open memory
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
  const [params, setParams] = useSearchParams();
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();
  const group = useTabGroup();

  const tab: TabId = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'account';
  const select = (next: TabId) => void guard().then((ok) => ok && setParams({ tab: next }, { replace: true }));

  return (
    <>
      <PageHeader title="Settings" subtitle="User scope · personal Claude Code configuration of this account" />

      <Tabs
        label="Settings sections"
        group={group}
        value={tab}
        tabs={TABS.map((t) => ({ id: t.id, label: t.label, dirty: dirtyKeys.has(t.id) }))}
        onChange={select}
      />

      <TabPanel className="tab-panel" key={tab} group={group} tab={tab}>
        {tab === 'account' && <AccountTab />}
        {tab === 'instructions' && <InstructionsTab scope={USER_SCOPE} scopeKey="user" />}
        {tab === 'settings' && <SettingsTab scope={USER_SCOPE} scopeKey="user" filesHref="/settings?tab=files" />}
        {tab === 'mcp' && <McpTab scope={USER_SCOPE} />}
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
