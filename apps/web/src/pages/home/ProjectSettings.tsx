import type { Project } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Collapsible } from '../../components/controls';
import { EnvironmentPanel } from '../../components/EnvironmentPanel';
import { TabPanel, Tabs, useTabGroup } from '../../components/ui';
import { useDirtyKeys, useLeaveGuard } from '../../lib/dirty';
import { FilesTab } from '../config/FilesTab';
import { InstructionsTab } from '../config/InstructionsTab';
import { McpTab } from '../config/McpTab';
import { SettingsTab } from '../config/SettingsTab';

// The ids double as the dirty keys the tabs register, which is what marks a section as unsaved
const SECTIONS = ['instructions', 'settings', 'mcp', 'files'] as const;

type SectionId = (typeof SECTIONS)[number];

/** The Claude Code configuration that lives in the project: CLAUDE.md, settings, MCP servers and files. */
export function ProjectSettings({ project }: { project: Project }) {
  const { t } = useTranslation(['projects', 'config']);
  const [params, setParams] = useSearchParams();
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();
  const scope = { projectId: project.id };
  const group = useTabGroup();

  const section: SectionId = SECTIONS.find((s) => s === params.get('section')) ?? 'instructions';
  const select = (next: SectionId) =>
    void guard().then(
      (ok) =>
        ok &&
        setParams(
          (previous) => {
            // The page's own `view` (and the project) stay; only the section changes
            const query = new URLSearchParams(previous);
            query.set('section', next);
            return query;
          },
          { replace: true },
        ),
    );

  return (
    <>
      <Collapsible
        className="card fold-card"
        title={
          <>
            <span className="fold-card-title">{t('config:config.environment')}</span>
            <span className="small muted">{t('settings.environmentHint')}</span>
          </>
        }
      >
        <EnvironmentPanel cwd={project.path} />
      </Collapsible>

      <Tabs
        label={t('settings.sections')}
        group={group}
        value={section}
        tabs={SECTIONS.map((s) => ({ id: s, label: t(`config:config.tabs.${s}`), dirty: dirtyKeys.has(s) }))}
        onChange={select}
      />

      <TabPanel className="tab-panel" key={`${project.id}:${section}`} group={group} tab={section}>
        {section === 'instructions' && <InstructionsTab scope={scope} scopeKey={project.id} />}
        {section === 'settings' && (
          <SettingsTab scope={scope} scopeKey={project.id} filesHref="/?view=settings&section=files" />
        )}
        {section === 'mcp' && <McpTab scope={scope} />}
        {section === 'files' && <FilesTab scope={scope} />}
      </TabPanel>
    </>
  );
}
