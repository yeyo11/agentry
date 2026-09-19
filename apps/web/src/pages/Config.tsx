import type { ResourceKind } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Collapsible } from '../components/controls';
import { EnvironmentPanel } from '../components/EnvironmentPanel';
import { PageHeader, PathLabel, Tabs } from '../components/ui';
import { DirtyProvider, useDirtyKeys, useLeaveGuard } from '../lib/dirty';
import { AccountTab } from './config/AccountTab';
import { FilesTab } from './config/FilesTab';
import { InstructionsTab } from './config/InstructionsTab';
import { McpTab } from './config/McpTab';
import { ResourcesTab } from './config/ResourcesTab';
import { ScopePicker, useScopeState } from './config/scope';
import { SettingsTab } from './config/SettingsTab';

const RESOURCE_TABS: ResourceKind[] = ['agents', 'skills', 'commands', 'output-styles', 'rules'];

const TABS = [
  { id: 'account', label: 'Account', userOnly: true },
  { id: 'instructions', label: 'Instructions', userOnly: false },
  { id: 'settings', label: 'Settings', userOnly: false },
  { id: 'mcp', label: 'MCP servers', userOnly: false },
  { id: 'agents', label: 'Agents', userOnly: false },
  { id: 'skills', label: 'Skills', userOnly: false },
  { id: 'commands', label: 'Commands', userOnly: false },
  { id: 'output-styles', label: 'Output styles', userOnly: false },
  { id: 'rules', label: 'Rules', userOnly: false },
  { id: 'files', label: 'Files', userOnly: false },
] as const;

type TabId = (typeof TABS)[number]['id'];

function ConfigInner() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') || undefined;
  const state = useScopeState(projectId);
  const { t } = useTranslation('config');
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();

  const tabs = TABS.filter((t) => !t.userOnly || !projectId);
  const requested = params.get('tab');
  const tab: TabId = tabs.find((t) => t.id === requested)?.id ?? (projectId ? 'instructions' : 'account');

  const navigate = (next: { tab?: TabId; project?: string | null }) => {
    const query: Record<string, string> = {};
    const project = next.project === undefined ? projectId : (next.project ?? undefined);
    if (project) query.project = project;
    const nextTab = next.tab ?? tab;
    // The account tab only exists in the user scope
    query.tab = project && nextTab === 'account' ? 'instructions' : nextTab;
    setParams(query, { replace: true });
  };
  const guarded = (next: Parameters<typeof navigate>[0]) => void guard().then((ok) => ok && navigate(next));
  const filesHref = `/config?${projectId ? `project=${encodeURIComponent(projectId)}&` : ''}tab=files`;

  return (
    <>
      <PageHeader
        title={t('config.title')}
        subtitle={
          state.project ? (
            <span className="scope-subtitle">
              Project scope · <PathLabel path={state.project.path} />
            </span>
          ) : (
            'User scope · personal Claude Code configuration of this account'
          )
        }
        actions={<ScopePicker state={state} onSelect={(id) => guarded({ project: id ?? null })} />}
      />

      <div className="precedence" role="note">
        <span className="small muted">Precedence</span>
        <span className={`precedence-step ${projectId ? 'precedence-on' : ''}`}>project local</span>
        <span aria-hidden>›</span>
        <span className={`precedence-step ${projectId ? 'precedence-on' : ''}`}>project shared</span>
        <span aria-hidden>›</span>
        <span className={`precedence-step ${!projectId ? 'precedence-on' : ''}`}>user</span>
        <span className="small muted">— the more specific file wins; permission rules and hooks are merged.</span>
      </div>

      {state.unknownProject && (
        <div className="alert alert-warn" role="alert">
          <strong>Unknown project</strong>
          <div>This project id is not known to the wrapper. Pick another scope.</div>
        </div>
      )}

      {state.project && (
        <Collapsible
          className="card fold-card"
          title={
            <>
              <span className="fold-card-title">Effective environment</span>
              <span className="small muted">what Claude actually loaded in the last run here</span>
            </>
          }
        >
          <EnvironmentPanel cwd={state.project.path} />
        </Collapsible>
      )}

      <Tabs
        label="Configuration sections"
        value={tab}
        tabs={tabs.map((t) => ({ id: t.id, label: t.label, dirty: dirtyKeys.has(t.id) }))}
        onChange={(id) => guarded({ tab: id })}
      />

      {!state.unknownProject && (
        <div className="tab-panel" role="tabpanel" key={`${state.scopeKey}:${tab}`}>
          {tab === 'account' && <AccountTab />}
          {tab === 'instructions' && <InstructionsTab scope={state.scope} scopeKey={state.scopeKey} />}
          {tab === 'settings' && <SettingsTab scope={state.scope} scopeKey={state.scopeKey} filesHref={filesHref} />}
          {tab === 'mcp' && <McpTab scope={state.scope} onSwitchToUser={() => guarded({ project: null, tab: 'mcp' })} />}
          {RESOURCE_TABS.includes(tab as ResourceKind) && <ResourcesTab scope={state.scope} kind={tab as ResourceKind} />}
          {tab === 'files' && <FilesTab scope={state.scope} />}
        </div>
      )}
    </>
  );
}

export function Config() {
  return (
    <DirtyProvider>
      <ConfigInner />
    </DirtyProvider>
  );
}
