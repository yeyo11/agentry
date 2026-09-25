import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Select } from './controls/Select';
import { ICON_SM } from './icons';
import { ALL_PROJECTS, useProjectScope } from '../lib/project-scope';

/**
 * The project scope: what Home, Chats and Orchestrations are about. In the top bar it is the
 * crumb's root, a quiet button with a folder, not a form field. `chip` is the phone's Chats header,
 * where the reference draws it as a chip beside the title and the top bar leaves its own out
 * (`pageHoldsScope`): the page has one selector, never two.
 */
export function ProjectSelector({ chip = false }: { chip?: boolean }) {
  const { t } = useTranslation(['home', 'work']);
  const { project, projects, select } = useProjectScope();
  return (
    <span className={`project-scope ${chip ? 'project-scope-chip' : ''}`.trim()}>
      {!chip && <Folder {...ICON_SM} className="project-scope-icon" />}
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
