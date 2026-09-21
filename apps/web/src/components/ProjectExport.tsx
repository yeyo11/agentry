import type { Project } from '@agentry/shared';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
// Not the barrel: Activity is in the first-paint bundle and the barrel would pull the form controls in
import { Tooltip } from './controls/Tooltip';
import { ICON_SM } from './icons';
import { Card } from './ui';

/**
 * Every chat of a project in one file. Plain links, like a chat's export: the route answers with
 * Content-Disposition: attachment and streams, so the browser saves it without holding it in memory.
 * `wholeProject` says so where a date range is on screen, since the file does not follow it.
 */
export function ProjectExportCard({ project, wholeProject = false }: { project: Project; wholeProject?: boolean }) {
  const { t } = useTranslation('components');
  return (
    <Card
      className="project-export"
      title={t('projectExport.title', { name: project.name })}
      actions={
        <span className="toolbar">
          {(['markdown', 'json'] as const).map((format) => (
            <Tooltip key={format} content={t(`projectExport.${format}Hint`)}>
              <a className="btn btn-small" href={api.projectExportUrl(project.id, format)} download data-format={format}>
                <Download {...ICON_SM} />
                {t(`projectExport.${format}`)}
              </a>
            </Tooltip>
          ))}
        </span>
      }
    >
      <p className="muted small">
        {t('projectExport.body')}
        {wholeProject && ` ${t('projectExport.wholeProject')}`}
      </p>
    </Card>
  );
}
