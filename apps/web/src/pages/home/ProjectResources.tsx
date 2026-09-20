import type { Project, ResourceKind } from '@agentry/shared';
import { useSearchParams } from 'react-router-dom';
import { TabPanel, Tabs, useTabGroup } from '../../components/ui';
import { useDirtyKeys, useLeaveGuard } from '../../lib/dirty';
import { ResourcesTab } from '../config/ResourcesTab';

// Ids are the resource kinds, which are also the dirty keys ResourcesTab registers
const SECTIONS: Array<{ id: ResourceKind; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'commands', label: 'Commands' },
  { id: 'output-styles', label: 'Output styles' },
  { id: 'rules', label: 'Rules' },
  { id: 'workflows', label: 'Workflows' },
];

/** What Claude can be given in this project: agents, skills, commands, output styles, rules and workflows. */
export function ProjectResources({ project }: { project: Project }) {
  const [params, setParams] = useSearchParams();
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();
  const group = useTabGroup();

  const section: ResourceKind = SECTIONS.find((s) => s.id === params.get('section'))?.id ?? 'agents';
  const select = (next: ResourceKind) =>
    void guard().then(
      (ok) =>
        ok &&
        setParams(
          (previous) => {
            // The page's own `tab` (and the project) stay; only the section changes
            const query = new URLSearchParams(previous);
            query.set('section', next);
            return query;
          },
          { replace: true },
        ),
    );

  return (
    <>
      <Tabs
        label="Project resources"
        group={group}
        value={section}
        tabs={SECTIONS.map((s) => ({ id: s.id, label: s.label, dirty: dirtyKeys.has(s.id) }))}
        onChange={select}
      />

      <TabPanel className="tab-panel" key={`${project.id}:${section}`} group={group} tab={section}>
        <ResourcesTab scope={{ projectId: project.id }} kind={section} />
      </TabPanel>
    </>
  );
}
