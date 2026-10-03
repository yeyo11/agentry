import type { LimitAction, LimitWait, TaskChainEntry } from '@agentry/shared';
import { Clock, ChevronRight } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { DecisionMarkOf } from './DecisionMark';
import { ProviderMark } from '@agentry/ui/components/ProviderMark';
import { ICON_SM } from '@agentry/ui/components/icons';
import { timeUntil } from '@agentry/ui/lib/format';
import { useProviderLabel } from '../lib/provider-status';
import { PROVIDERS_SETTINGS_PATH } from '../lib/provider-status';
import { resetWhen } from '../lib/reset-when';


/**
 * The providers a piece of work went through, oldest first, each chip opening its chat; the newest is
 * the one that runs now. A chip is never colour alone: the mark and the name say which agent.
 */
export function ProviderChain({ chain, how }: { chain: readonly Pick<TaskChainEntry, 'chatId' | 'provider'>[]; how?: ReactNode }) {
  const { t } = useTranslation('components');
  const label = useProviderLabel();
  const decided = useMoveDecisions(chain.length > 1);
  if (chain.length === 0) return null;
  return (
    <div className="chain-row">
      <span className="chain" role="group" aria-label={t('providerChain.label')}>
        {chain.map((entry, index) => {
          const name = label(entry.provider);
          const now = index === chain.length - 1;
          const decision = decided.get(entry.chatId);
          return (
            <span className="chain-item" key={`${entry.chatId}-${index}`}>
              {index > 0 && <ChevronRight className="chain-arrow" aria-hidden />}
              <Link to={`/chats/${encodeURIComponent(entry.chatId)}`} className={`chain-chip ${now ? 'now' : ''}`.trim()} aria-label={t('providerChain.open', { name })}>
                <ProviderMark provider={entry.provider} label={name} decorative />
                {name}
              </Link>
              {index > 0 && decision && <MoveDecisionMark decisionId={decision} />}
            </span>
          );
        })}
      </span>
      {how && <span className="chain-how">{how}</span>}
    </div>
  );
}

/**
 * The decision that moved work into each chat, by the new chat's id: the moves that an active
 * decision point made carry its `decisionId`. One read of the newest moves, shared by every chain.
 */
export function useMoveDecisions(enabled = true): ReadonlyMap<string, string> {
  const moves = useQuery({ queryKey: keys.providerMoves('recent'), queryFn: () => api.providerMoves({ limit: 500 }), enabled });
  return useMemo(() => {
    const byChat = new Map<string, string>();
    for (const move of moves.data ?? []) if (move.toChat && move.decisionId) byChat.set(move.toChat, move.decisionId);
    return byChat;
  }, [moves.data]);
}

/**
 * The provider a wait found no counterpart on, when that is why it waits. The core records the reason
 * on the wait's move (in English, as the others are), which is all there is to tell it by.
 */
export function useNoCounterpart(wait: Pick<LimitWait, 'moveId'> | null | undefined): { provider: string } | null {
  const moves = useQuery({ queryKey: keys.providerMoves('waiting'), queryFn: () => api.providerMoves({ state: 'waiting' }), enabled: Boolean(wait) });
  const reason = wait ? moves.data?.find((move) => move.id === wait.moveId)?.reason : null;
  const found = reason ? /^no counterpart is mapped for its model on (\S+)/.exec(reason) : null;
  return found?.[1] ? { provider: found[1] } : null;
}

/** "Opus has no counterpart on Codex. Choose the counterpart": what holds a wait that cannot move, and the way to fix it. */
export function NoCounterpartWhy({ provider, model }: { provider: string; model: string | null | undefined }) {
  const { t } = useTranslation('components');
  const label = useProviderLabel();
  return (
    <>
      {t('limitWait.noCounterpart', { model: model || t('limitWait.itsModel'), name: label(provider) })}{' '}
      <Link to={PROVIDERS_SETTINGS_PATH} className="link-btn">
        {t('limitWait.chooseCounterpart')}
      </Link>
    </>
  );
}

/** The "decided" mark of the decision that made a move or a pick, opening its answer; nothing while it loads or is gone. */
export function MoveDecisionMark({ decisionId }: { decisionId: string }) {
  const decision = useQuery({ queryKey: keys.decision(decisionId), queryFn: () => api.decision(decisionId), staleTime: 60_000 });
  return decision.data ? <DecisionMarkOf decision={decision.data} /> : null;
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
