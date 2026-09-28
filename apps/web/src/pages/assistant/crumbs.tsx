import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useProjects } from '../../api';
import { projectPath } from './model';

/** The project assistant's id in a path, or null for any other page. */
export function assistantProjectOf(pathname: string): string | null {
  const id = /^\/projects\/([^/]+)\/assistant\/?$/.exec(pathname)?.[1];
  return id === undefined ? null : decodeURIComponent(id);
}

/** "Projects / pagos-api / Assistant", as the reference's top bar reads on the assistant's page. */
export function AssistantCrumbs({ projectId, projectsLabel }: { projectId: string; projectsLabel: string }) {
  const { t } = useTranslation('assistant');
  const project = useProjects(false).data?.find((p) => p.id === projectId);
  return (
    <>
      <Link to="/projects" className="crumb-page muted ellipsis">
        {projectsLabel}
      </Link>
      <span className="crumb-sep" aria-hidden>
        /
      </span>
      {project && (
        <>
          <Link to={projectPath(project.id)} className="crumb-page muted ellipsis">
            {project.name}
          </Link>
          <span className="crumb-sep" aria-hidden>
            /
          </span>
        </>
      )}
      <span className="crumb-page ellipsis">{t('crumb')}</span>
    </>
  );
}
