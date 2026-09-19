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
  { id: 'account', userOnly: true },
  { id: 'instructions', userOnly: false },
  { id: 'settings', userOnly: false },
  { id: 'mcp', userOnly: false },
  { id: 'agents', userOnly: false },
  { id: 'skills', userOnly: false },
  { id: 'commands', userOnly: false },
  { id: 'output-styles', userOnly: false },
  { id: 'rules', userOnly: false },
  { id: 'files', userOnly: false },
] as const;

type TabId = (typeof TABS)[number]['id'];

function ConfigInner() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') || undefined;
  const state = useScopeState(projectId);
  const { t } = useTranslation('config');
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();

  const tabs = TABS.filter((entry) => !entry.userOnly || !projectId);
  const requested = params.get('tab');
  const tab: TabId = tabs.find((entry) => entry.id === requested)?.id ?? (projectId ? 'instructions' : 'account');

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
              {t('config.projectScope')} · <PathLabel path={state.project.path} />
            </span>
          ) : (
            t('config.userScope')
          )
        }
        actions={<ScopePicker state={state} onSelect={(id) => guarded({ project: id ?? null })} />}
      />

      <div className="precedence" role="note">
        <span className="small muted">{t('config.precedence')}</span>
        <span className={`precedence-step ${projectId ? 'precedence-on' : ''}`}>{t('config.projectLocal')}</span>
        <span aria-hidden>›</span>
        <span className={`precedence-step ${projectId ? 'precedence-on' : ''}`}>{t('config.projectShared')}</span>
        <span aria-hidden>›</span>
        <span className={`precedence-step ${!projectId ? 'precedence-on' : ''}`}>{t('config.user')}</span>
        <span className="small muted">{t('config.precedenceNote')}</span>
      </div>

      {state.unknownProject && (
        <div className="alert alert-warn" role="alert">
          <strong>{t('config.unknownProject')}</strong>
          <div>{t('config.unknownProjectHint')}</div>
        </div>
      )}

      {state.project && (
        <Collapsible
          className="card fold-card"
          title={
            <>
              <span className="fold-card-title">{t('config.environment')}</span>
              <span className="small muted">{t('config.environmentHint')}</span>
            </>
          }
        >
          <EnvironmentPanel cwd={state.project.path} />
        </Collapsible>
      )}

      <Tabs
        label={t('config.sections')}
        value={tab}
        tabs={tabs.map((entry) => ({ id: entry.id, label: t(`config.tabs.${entry.id}`), dirty: dirtyKeys.has(entry.id) }))}
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
