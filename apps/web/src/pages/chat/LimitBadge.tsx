import { useTranslation } from 'react-i18next';
import { Tag } from '@agentry/ui/components/ui';
import { formatHour, toMs } from '@agentry/ui/lib/format';
import type { LimitPhase } from './LimitBanner';

/**
 * At a limit the pill's "idle · live" would say nothing about why the chat is not going on: the warn
 * badge says it instead, and with the hour it resumes when the chat waits for it.
 */
export function LimitBadge({ phase, resetsAt }: { phase: Exclude<LimitPhase, 'none'>; resetsAt: string | null }) {
  const { t } = useTranslation('chats');
  const at = toMs(resetsAt);
  return <Tag tone="warn">{phase === 'waiting' ? (at === null ? t('limit.header.waiting') : t('limit.header.waitingUntil', { at: formatHour(at) })) : t('limit.header.reached')}</Tag>;
}
