import type { Project, ResourceKind, WorkflowDefinition } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, keys } from '../../api';
import { ICON_SM } from '../../components/icons';
import { RunWorkflowDialog } from '../../components/RunWorkflowDialog';
import { Card, Empty, ErrorBox, PathLabel, Skeleton, Tabs, Tag } from '../../components/ui';
import { useDirtyKeys, useLeaveGuard } from '../../lib/dirty';
import { ResourcesTab } from '../config/ResourcesTab';

const RESOURCE_KINDS: ResourceKind[] = ['agents', 'skills', 'commands', 'output-styles', 'rules'];

// Ids of the resource kinds are the dirty keys ResourcesTab registers; workflows are read-only here
const SECTIONS = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'commands', label: 'Commands' },
  { id: 'output-styles', label: 'Output styles' },
  { id: 'rules', label: 'Rules' },
  { id: 'workflows', label: 'Workflows' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * The saved workflows the CLI finds from this directory. The API also returns the user's own, so the
 * scope tag says which are the project's; running any of them starts a chat here.
 */
function WorkflowsSection({ project }: { project: Project }) {
  const [running, setRunning] = useState<WorkflowDefinition | null>(null);
  const { data, error, isLoading } = useQuery({
    queryKey: keys.savedWorkflows(project.path),
    queryFn: () => api.savedWorkflows(project.path),
  });
  const workflows = data ?? [];

  return (
    <Card title="Saved workflows">
      <p className="small muted">
        Scripts in this project&apos;s <span className="mono">.claude/workflows/</span>, and the ones in your own. Running one starts a
        chat that launches it.
      </p>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={3} />
      ) : workflows.length === 0 ? (
        <Empty title="No saved workflows">
          Put a script in <span className="mono">.claude/workflows/</span> of this project to see it here.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Scope</th>
                <th>Path</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {workflows.map((workflow) => (
                <tr key={`${workflow.scope}:${workflow.name}`}>
                  <td>
                    <div className="strong mono">{workflow.name}</div>
                    {workflow.description && <div className="small muted">{workflow.description}</div>}
                  </td>
                  <td>
                    <Tag tone={workflow.scope === 'project' ? 'active' : 'muted'}>{workflow.scope}</Tag>
                  </td>
                  <td>
                    <PathLabel path={workflow.path} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="btn btn-small"
                        onClick={() => setRunning(workflow)}
                        aria-label={`Run ${workflow.name}`}
                      >
                        <Play {...ICON_SM} /> Run
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {running && <RunWorkflowDialog cwd={project.path} workflow={running} onClose={() => setRunning(null)} />}
    </Card>
  );
}

/** What Claude can be given in this project: agents, skills, commands, output styles, rules and workflows. */
export function ProjectResources({ project }: { project: Project }) {
  const [params, setParams] = useSearchParams();
  const dirtyKeys = useDirtyKeys();
  const guard = useLeaveGuard();

  const section: SectionId = SECTIONS.find((s) => s.id === params.get('section'))?.id ?? 'agents';
  const select = (next: SectionId) =>
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
  const kind = RESOURCE_KINDS.find((k) => k === section);

  return (
    <>
      <Tabs
        label="Project resources"
        value={section}
        tabs={SECTIONS.map((s) => ({ id: s.id, label: s.label, dirty: dirtyKeys.has(s.id) }))}
        onChange={select}
      />

      <div className="tab-panel" role="tabpanel" key={`${project.id}:${section}`}>
        {kind ? <ResourcesTab scope={{ projectId: project.id }} kind={kind} /> : <WorkflowsSection project={project} />}
      </div>
    </>
  );
}
