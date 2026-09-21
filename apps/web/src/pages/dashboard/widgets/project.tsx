import type { ResourceKind } from '@agentry/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { GitBranch, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../../api';
import { ProjectExportCard } from '../../../components/ProjectExport';
import { Skeleton } from '../../../components/ui';
import { formatNumber } from '../../../lib/format';
import { configCount } from '../layout';
import { excerpt } from '../model';
import type { WidgetProps } from '../registry';
import { WidgetCard } from '../WidgetCard';

/** The same kinds, in the same order, as the Resources view's sections. */
const RESOURCE_KINDS: readonly ResourceKind[] = ['agents', 'skills', 'commands', 'output-styles', 'rules', 'workflows'];

/** The project's CLAUDE.md, first lines only, and a way into the editor and into its memory files. */
export function MemoryWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation('home');
  const scope = { projectId: project?.id };
  const instructions = useQuery({
    queryKey: keys.instructions(scope, 'shared'),
    queryFn: () => api.getInstructions(scope, 'shared'),
    enabled: !!project,
  });
  const memory = useQuery({ queryKey: keys.memoryFiles(project?.id ?? ''), queryFn: () => api.memoryFiles(project?.id ?? ''), enabled: !!project });
  if (!project) return null;
  const text = instructions.data?.exists ? excerpt(instructions.data.content) : '';
  const files = memory.data?.length ?? 0;
  return (
    <WidgetCard
      id={id}
      title={title}
      actions={
        <Link to="/?view=settings&section=instructions" className="link-more">
          {t('widgets.memory.edit')}
        </Link>
      }
    >
      {instructions.isLoading ? (
        <Skeleton rows={3} height={14} />
      ) : text ? (
        <figure className="memory-figure">
          <figcaption className="small muted">{t('widgets.memory.excerpt')}</figcaption>
          <pre className="memory-excerpt mono small">{text}</pre>
        </figure>
      ) : (
        <p className="muted small">{t('widgets.memory.noInstructions')}</p>
      )}
      <Link to="/?view=memory" className="widget-row widget-link">
        <span>{t('widgets.memory.files')}</span>
        <span className="mono small muted">{memory.isLoading ? '…' : formatNumber(files)}</span>
      </Link>
    </WidgetCard>
  );
}

/** A few of the project's worktrees by branch; the full view has them all with their actions. */
export function WorktreesWidget({ project, title, id, config }: WidgetProps) {
  const { t } = useTranslation('home');
  if (!project) return null;
  const limit = configCount(config, 'limit', 4);
  const shown = project.worktrees.slice(0, limit);
  return (
    <WidgetCard
      id={id}
      title={title}
      aside={project.worktrees.length > 0 ? <span className="mono small muted">{formatNumber(project.worktrees.length)}</span> : undefined}
      actions={
        <Link to="/?view=worktrees" className="link-more">
          {t('widgets.worktrees.all')}
        </Link>
      }
    >
      {shown.length === 0 ? (
        <p className="muted small">{t('widgets.worktrees.none')}</p>
      ) : (
        <ul className="widget-rows">
          {shown.map((worktree) => (
            <li key={worktree.path} className="widget-row">
              <span className="mono ellipsis worktree-branch">
                <GitBranch size={12} strokeWidth={1.75} aria-hidden />
                {worktree.branch ?? worktree.name ?? worktree.path}
              </span>
              {worktree.createdBy && (
                <span className="small muted ellipsis">
                  <Workflow size={12} strokeWidth={1.75} aria-hidden /> {worktree.createdBy.taskName}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {project.worktrees.length > shown.length && (
        <span className="small muted">{t('widgets.worktrees.more', { n: formatNumber(project.worktrees.length - shown.length) })}</span>
      )}
    </WidgetCard>
  );
}

/** How many of each kind of resource the project gives Claude; each opens its section of the full view. */
export function ResourcesWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation(['home', 'config']);
  const scope = { projectId: project?.id };
  const counts = useQueries({
    queries: RESOURCE_KINDS.map((kind) => ({
      queryKey: keys.resources(scope, kind),
      queryFn: () => api.resources(scope, kind),
      enabled: !!project,
    })),
  });
  if (!project) return null;
  return (
    <WidgetCard id={id} title={title}>
      <ul className="widget-rows">
        {RESOURCE_KINDS.map((kind, i) => {
          const query = counts[i];
          const n = query?.data?.length;
          return (
            <li key={kind}>
              <Link to={`/?view=resources&section=${kind}`} className="widget-row widget-link">
                <span>{t(`config:config.tabs.${kind}`)}</span>
                <span className="mono small muted">{n === undefined ? (query?.isError ? '—' : '…') : formatNumber(n)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </WidgetCard>
  );
}

/** Every chat of the project in one file, as the Activity tab offered it. */
export function ExportWidget({ project }: WidgetProps) {
  if (!project) return null;
  return <ProjectExportCard project={project} />;
}
