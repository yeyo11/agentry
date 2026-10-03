import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Chat, Exclusion, ProviderCandidates, ProviderMove, ProviderStatus } from '@agentry/shared';
import { Hourglass, Repeat2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { formatDateTime, formatDuration, formatHour, timeAgo, toMs } from '@agentry/ui/lib/format';
import { api, keys } from '../../api';
import { useProviders } from '../../lib/providers';
import { isKnownLimitWindow, useLimitWindowName } from '../../lib/limit-words';
import { PROVIDERS_SETTINGS_PATH } from '../../lib/provider-status';
import { rotationOf } from '../config/providers/rotation';
import { MoveSheet, type MoveChoice } from './MoveSheet';

export type LimitPhase = 'none' | 'limit' | 'waiting';

export interface LimitState {
  phase: LimitPhase;
  status: ProviderStatus | undefined;
  /** The open wait for this chat, when there is one */
  wait: ProviderMove | null;
  /** When the binding window resets; the wait's own time wins, since it is what will be replayed */
  resetsAt: string | null;
}

/**
 * Whether the chat sits at its provider's limit. The server keeps the fact only in memory, so the
 * page reads it from what survives a reload: an open wait, or the provider's own reading, together
 * with a chat that is not working and whose last turn did not end well, after the reading was taken. A chat that moved on, or
 * whose reading says the limit is not reached, shows nothing.
 */
export function limitPhase(chat: Chat, status: ProviderStatus | undefined, wait: ProviderMove | null): LimitPhase {
  if (chat.continuedIn) return 'none';
  if (wait) return 'waiting';
  if (chat.state === 'working') return 'none';
  // The server saw this chat's turn die on the limit: that is the fact, whatever was read since
  if (chat.atLimit) return 'limit';
  const limit = status?.limit;
  if (!limit || limit.state !== 'exhausted') return 'none';
  const last = chat.executions.at(-1);
  if (!last || last.outcome === 'completed' || last.outcome === 'stopped') return 'none';
  // The turn must have ended on this limit: one that ended before the reading was taken failed for
  // another reason, or on an earlier window, and the limit is not what stopped it
  const ended = toMs(last.endedAt);
  const observed = toMs(limit.observedAt);
  if (ended === null || (observed !== null && ended < observed)) return 'none';
  const reset = toMs(limit.resetsAt);
  return reset !== null && reset <= Date.now() ? 'none' : 'limit';
}

export function useLimitState(chat: Chat | undefined): LimitState {
  const providers = useProviders();
  const id = chat?.id ?? '';
  const waits = useQuery({ queryKey: keys.chatMoves(id), queryFn: () => api.providerMoves({ chatId: id, state: 'waiting' }), enabled: Boolean(chat) });
  const status = providers.data?.find((p) => p.id === chat?.provider);
  const wait = waits.data?.find((move) => move.fromChat === id && move.state === 'waiting') ?? null;
  const phase = chat ? limitPhase(chat, status, wait) : 'none';
  return { phase, status, wait, resetsAt: wait?.resetsAt ?? status?.limit?.resetsAt ?? null };
}

/** "Resets at 14:05 · in 2 h 10 min", or what is known when the reset is not. */
export function useResetWords(state: LimitState): string {
  const { t } = useTranslation('chats');
  const reset = toMs(state.resetsAt);
  if (reset === null) return t('limit.resetUnknown', { age: timeAgo(state.status?.limit?.observedAt) });
  const left = reset - Date.now();
  const sameDay = new Date(reset).toDateString() === new Date().toDateString();
  const at = sameDay ? formatHour(reset) : formatDateTime(reset);
  return left <= 0 ? t('limit.resetsOn', { at }) : t(sameDay ? 'limit.resets' : 'limit.resetsOn', { at, in: formatDuration(left) });
}

/** What each reason a provider cannot take the chat reads like; `no-mapping` also says where to fix it. */
export function ExcludedList({ excluded, labelOf, capped }: { excluded: ProviderCandidates['excluded']; labelOf: (id: string) => string; capped?: boolean }) {
  const { t } = useTranslation('chats');
  if (excluded.length === 0 && !capped) return null;
  return (
    <ul className="lim-out" aria-label={t('limit.outAria')}>
      {capped && <li>{t('limit.capped')}</li>}
      {excluded.map((row) => (
        <li key={row.provider}>
          <b>{labelOf(row.provider)}</b>
          <span>{t(`limit.excluded.${row.excluded}` as `limit.excluded.${Exclusion}`)}</span>
          {row.excluded === 'no-mapping' && <Link to={PROVIDERS_SETTINGS_PATH}>{t('limit.setCounterpart')}</Link>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Above the composer of a chat whose provider reached its limit, and of one that waits for the
 * reset. At a limit it offers the feasible actions with the setting's first as the zone's one
 * primary; nothing is sent to another vendor without a click. Waiting, it offers Move now and Stop
 * waiting, with no primary. Nothing in it moves: a limit is not live work.
 */
export function LimitBanner({ chat, state }: { chat: Chat; state: LimitState }) {
  const { t } = useTranslation(['chats', 'providers']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const providers = useProviders();
  const [sheet, setSheet] = useState<MoveChoice | null>(null);
  const resetWords = useResetWords(state);
  const windowOf = useLimitWindowName();
  const { phase, status, wait } = state;
  const settings = useQuery({ queryKey: keys.providerSettings, queryFn: () => api.providerSettings(), enabled: phase === 'limit' });
  const candidates = useQuery({ queryKey: keys.providerCandidates(chat.id), queryFn: () => api.providerCandidates(chat.id), enabled: phase !== 'none' });

  const labelOf = (id: string) => providers.data?.find((p) => p.id === id)?.label ?? id;
  const name = status?.label ?? labelOf(chat.provider);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.chatMoves(chat.id) });
    void queryClient.invalidateQueries({ queryKey: keys.providerCandidates(chat.id) });
    void queryClient.invalidateQueries({ queryKey: keys.chatScope(chat.id) });
  };
  const waitMutation = useMutation({ mutationFn: () => api.waitForLimit(chat.id), onSuccess: refresh, onError: (error) => toast.error(t('chats:limit.waitFailed'), error) });
  const stopMutation = useMutation({
    mutationFn: (moveId: string) => api.cancelProviderMove(moveId),
    onSuccess: refresh,
    onError: (error) => toast.error(t('chats:limit.stopWaitingFailed'), error),
  });

  if (phase === 'none') return null;
  const found = candidates.data;
  const first = found && !found.movesCapped ? found.candidates[0] : undefined;
  const window = status?.limit?.window ?? null;
  // A window the app has no words for is not named: "reached its usage limit" says it
  const title = isKnownLimitWindow(window) ? t('chats:limit.titleWindow', { name, window: windowOf(window) }) : t('chats:limit.title', { name });

  if (phase === 'waiting') {
    return (
      <section className="lim" aria-label={t('chats:limit.region')}>
        <div className="lim-head">
          <Hourglass {...ICON} className="lim-icon" />
          <div className="lim-text">
            <span className="lim-title">{t('chats:limit.waitingTitle', { name })}</span>
            <span className="lim-reset">{resetWords}</span>
            <span>{t('chats:limit.waitingNote')}</span>
          </div>
        </div>
        <div className="lim-acts">
          <button
            type="button"
            className="btn"
            disabled={!first}
            title={first ? undefined : t('chats:limit.moveNowNone')}
            onClick={() => first && setSheet({ provider: first.provider, action: 'handoff' })}
          >
            <Repeat2 {...ICON_SM} /> {t('chats:limit.moveNow')}
          </button>
          <button type="button" className="btn" disabled={!wait || stopMutation.isPending} onClick={() => wait && stopMutation.mutate(wait.id)}>
            {t('chats:limit.stopWaiting')}
          </button>
        </div>
        {sheet && found && <MoveSheet chat={chat} candidates={found} labelOf={labelOf} initial={sheet} onClose={() => setSheet(null)} />}
      </section>
    );
  }

  // The setting's action goes first, and is the primary only when it can be taken
  const preferred = settings.data ? rotationOf(settings.data).onLimit.action : 'wait';
  const primary = preferred === 'restart' && first ? 'restart' : preferred === 'handoff' && first ? 'handoff' : 'wait';
  const target = first ? labelOf(first.provider) : '';
  const handoff = first && (
    <button key="handoff" type="button" className={`btn ${primary === 'handoff' ? 'btn-primary' : ''}`.trim()} onClick={() => setSheet({ provider: first.provider, action: 'handoff' })}>
      <Repeat2 {...ICON_SM} /> {t('chats:limit.continueOn', { name: target })}
    </button>
  );
  const restart = first && (
    <button key="restart" type="button" className={`btn ${primary === 'restart' ? 'btn-primary' : ''}`.trim()} onClick={() => setSheet({ provider: first.provider, action: 'restart' })}>
      <Repeat2 {...ICON_SM} /> {t('chats:limit.startOverOn', { name: target })}
    </button>
  );
  const waitButton = (
    <button key="wait" type="button" className={`btn ${primary === 'wait' ? 'btn-primary' : ''}`.trim()} disabled={waitMutation.isPending} onClick={() => waitMutation.mutate()}>
      <Hourglass {...ICON_SM} /> {t('chats:limit.wait')}
    </button>
  );
  const ordered = primary === 'restart' ? [restart, handoff, waitButton] : primary === 'wait' ? [waitButton, handoff, restart] : [handoff, restart, waitButton];

  return (
    <section className="lim" aria-label={t('chats:limit.region')}>
      <div className="lim-head">
        <TriangleAlert {...ICON} className="lim-icon" />
        <div className="lim-text">
          <span className="lim-title">{title}</span>
          <span className="lim-reset">{resetWords}</span>
        </div>
      </div>
      <div className="lim-acts">
        {ordered}
        {first && (
          <button type="button" className="btn btn-ghost" onClick={() => setSheet({ provider: first.provider, action: 'handoff' })}>
            {t('chats:limit.seeHandoff')}
          </button>
        )}
      </div>
      <p className="lim-note">
        {first ? <Trans t={t} i18nKey="chats:limit.note" values={{ name: target }} components={{ b: <b /> }} /> : t('chats:limit.noteWait')}
      </p>
      {found && <ExcludedList excluded={found.excluded} labelOf={labelOf} capped={found.movesCapped} />}
      {sheet && found && <MoveSheet chat={chat} candidates={found} labelOf={labelOf} initial={sheet} onClose={() => setSheet(null)} />}
    </section>
  );
}

/** The box where the message would go, while the chat cannot take one: the banner above is where to act. */
export function BlockedComposer({ chat, state }: { chat: Chat; state: LimitState }) {
  const { t } = useTranslation('chats');
  const providers = useProviders();
  const nameOf = (id: string) => providers.data?.find((p) => p.id === id)?.label ?? id;
  const said = chat.continuedIn
    ? t('limit.composer.continued', { name: nameOf(chat.continuedIn.provider) })
    : state.phase === 'waiting'
      ? t('limit.composer.waiting', { name: nameOf(chat.provider) })
      : t('limit.composer.limit');
  return (
    <div className="lim-composer">
      <textarea rows={1} disabled placeholder={said} aria-label={t('limit.composer.aria')} />
    </div>
  );
}
