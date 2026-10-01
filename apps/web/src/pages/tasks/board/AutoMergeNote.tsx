import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMergeState } from '../../../api';

/**
 * "Auto-merge on" under a card's PR line: the badge and, in words, what will happen, so the person
 * sees on the board that something merges without a click of theirs. Nothing moves: it waits on the
 * host. It reads the merge state the item page reads (one shared query per request) and says
 * nothing until the host has said that auto-merge is armed.
 */
export function AutoMergeNote({ id }: { id: string | null }) {
  const { t } = useTranslation('tasks');
  const { data } = useMergeState(id ?? undefined);
  if (!data?.autoMerge.armed) return null;
  const method = data.autoMerge.method;
  return (
    <span className="workitem-strip-auto">
      <span className="badge">
        <Clock size={11} strokeWidth={2} aria-hidden />
        {t('pr.auto.badge')}
      </span>
      <span>{method ? t('pr.auto.note', { method: t(`pr.auto.method.${method}`) }) : t('pr.auto.noteBare')}</span>
    </span>
  );
}
