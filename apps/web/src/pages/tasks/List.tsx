import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui';

/** The list view of Tasks, at `/tasks?view=list`. A stub until web-board replaces this file whole. */
export function List() {
  const { t } = useTranslation('tasks');
  return <PageHeader title={t('title')} />;
}
