import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui';

/**
 * `/projects/new`: the wizard that creates or imports a project with its template and modules. A
 * stub until web-projects replaces this file whole.
 */
export function NewProject() {
  const { t } = useTranslation('work');
  return <PageHeader title={t('projects.newProject')} />;
}
