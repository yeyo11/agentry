import { Select } from './controls/Select';
import { ALL_PROJECTS, useProjectScope } from '../lib/project-scope';

/** The top bar's project selector: what Home, Chats and Orchestrations are about. */
export function ProjectSelector() {
  const { project, projects, select } = useProjectScope();
  return (
    <Select
      className="project-selector"
      aria-label="Project"
      value={project?.id ?? ALL_PROJECTS}
      onChange={(id) => select(id === ALL_PROJECTS ? null : id)}
      options={[
        { value: ALL_PROJECTS, label: 'All projects' },
        ...projects.map((p) => ({ value: p.id, label: p.name, hint: p.path })),
      ]}
    />
  );
}
