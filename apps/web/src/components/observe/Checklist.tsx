import type { Checklist as ChecklistData } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { checklistProgress } from '../../lib/observe';
import { ICON_SM } from '../icons';
import { ErrorBox } from '../ui';

const ICON = { completed: CircleCheck, in_progress: Loader, pending: CircleDashed } as const;

/** The plan a worker wrote for itself, as of its last update: what is done, what it is on, what is left. */
export function ChecklistView({ queryKey, load, live }: { queryKey: readonly unknown[]; load: () => Promise<ChecklistData>; live: boolean }) {
  const { t } = useTranslation('observe');
  const { data, error } = useQuery({ queryKey, queryFn: load, refetchInterval: live ? 10_000 : false });
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  if (data.items.length === 0) return <p className="muted small">{t('checklist.none')}</p>;
  const { done, total, current } = checklistProgress(data.items);
  return (
    <div className="stack-tight">
      <p className="small muted">
        {t('checklist.progress', { done, total })}
        {current ? ` · ${t('checklist.onIt', { text: current.text })}` : ''}
      </p>
      <ul className="obs-checklist">
        {data.items.map((item, i) => {
          const Icon = ICON[item.status];
          return (
            <li key={i} className={`obs-check obs-check-${item.status}`}>
              <Icon {...ICON_SM} />
              {/* The icon is decorative: the state is also in words */}
              <span>
                <span className="sr-only">{t(`checklist.status.${item.status}`)}: </span>
                {item.text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
