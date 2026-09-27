import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui';

/** `/tasks/milestones`. A stub until web-board replaces this file whole. */
export function Milestones() {
  const { t } = useTranslation('tasks');
  return <PageHeader title={t('views.milestones')} />;
}
