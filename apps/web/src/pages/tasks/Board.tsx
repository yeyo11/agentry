import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui';

/**
 * `/tasks`: the board of the selected project, or of every project with All projects, and the list
 * at `?view=list` (List.tsx). A stub until web-board replaces this file whole.
 */
export function Board() {
  const { t } = useTranslation('tasks');
  return <PageHeader title={t('title')} />;
}
