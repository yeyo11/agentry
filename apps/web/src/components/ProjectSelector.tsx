import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Select } from './controls/Select';
import { ICON_SM } from './icons';
import { ALL_PROJECTS, useProjectScope } from '../lib/project-scope';

/**
 * The project scope: what Home, Chats, Orchestrations and Schedules are about. It lives in the top
 * bar on every page and every screen, as the crumb's root: a quiet button with a folder, not a
 * form field. One place, so it is always where the person last found it.
 */
export function ProjectSelector() {
  const { t } = useTranslation(['home', 'work']);
  const { project, projects, select } = useProjectScope();
  return (
    <span className="project-scope">
      <Folder {...ICON_SM} className="project-scope-icon" />
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
    </span>
  );
}
