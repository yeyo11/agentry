import type { LimitAction, LimitWait, TaskChainEntry } from '@agentry/shared';
import { Clock, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ProviderMark } from '@agentry/ui/components/ProviderMark';
import { ICON_SM } from '@agentry/ui/components/icons';
import { timeUntil } from '@agentry/ui/lib/format';
import { useProviderLabel } from '../lib/provider-status';
import { resetWhen } from '../lib/reset-when';


/**
 * The providers a piece of work went through, oldest first, each chip opening its chat; the newest is
 * the one that runs now. A chip is never colour alone: the mark and the name say which agent.
 */
export function ProviderChain({ chain, how }: { chain: readonly Pick<TaskChainEntry, 'chatId' | 'provider'>[]; how?: ReactNode }) {
  const { t } = useTranslation('components');
  const label = useProviderLabel();
  if (chain.length === 0) return null;
  return (
    <div className="chain-row">
      <span className="chain" role="group" aria-label={t('providerChain.label')}>
        {chain.map((entry, index) => {
          const name = label(entry.provider);
          const now = index === chain.length - 1;
          return (
            <span className="chain-item" key={`${entry.chatId}-${index}`}>
              {index > 0 && <ChevronRight className="chain-arrow" aria-hidden />}
              <Link to={`/chats/${encodeURIComponent(entry.chatId)}`} className={`chain-chip ${now ? 'now' : ''}`.trim()} aria-label={t('providerChain.open', { name })}>
                <ProviderMark provider={entry.provider} label={name} decorative />
                {name}
              </Link>
            </span>
          );
        })}
      </span>
      {how && <span className="chain-how">{how}</span>}
    </div>
  );
}

/** How a chat of the chain came to be, in the person's words: "moved · handoff". */
export function useMovedWords(): (action: LimitAction | null | undefined) => string | null {
  const { t } = useTranslation('components');
  return (action) => (action === 'handoff' || action === 'restart' ? t(`providerChain.moved.${action}`) : null);
}

/**
 * The strip a waiting piece of work shows where a running one shows its command: warn tint and the
 * clock, in words, with nothing moving (waiting is not live work). `why` says what holds it.
 */
export function WaitLine({ wait, why, children }: { wait: Pick<LimitWait, 'provider' | 'resetsAt'>; why?: ReactNode; children?: ReactNode }) {
  const { t } = useTranslation('components');
  const label = useProviderLabel();
  const name = label(wait.provider);
  return (
    <div className="wait-line" role="status">
      <Clock {...ICON_SM} aria-hidden />
      <span>
        <b>{t('limitWait.title', { name })}</b>
        {' · '}
        {wait.resetsAt ? (
          <>
            {t('limitWait.resumesAt')} <span className="mono">{resetWhen(wait.resetsAt)}</span> ({timeUntil(Date.parse(wait.resetsAt) / 1000)})
          </>
        ) : (
          t('limitWait.unknown')
        )}
        {why && <span className="why">{why}</span>}
        {children}
      </span>
    </div>
  );
}
