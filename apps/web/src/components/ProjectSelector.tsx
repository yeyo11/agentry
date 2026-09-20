import { useTranslation } from 'react-i18next';
import { Select } from './controls/Select';
import { ALL_PROJECTS, useProjectScope } from '../lib/project-scope';

/** The top bar's project selector: what Home, Chats and Orchestrations are about. */
export function ProjectSelector() {
  const { t } = useTranslation(['home', 'work']);
  const { project, projects, select } = useProjectScope();
  return (
    <Select
      className="project-selector"
      aria-label={t('work:shared.project')}
      value={project?.id ?? ALL_PROJECTS}
      onChange={(id) => select(id === ALL_PROJECTS ? null : id)}
      options={[
        { value: ALL_PROJECTS, label: t('projectSelector.all') },
        ...projects.map((p) => ({ value: p.id, label: p.name, hint: p.path })),
      ]}
    />
  );
}
