import type { MergeState } from '@agentry/shared';
import { CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@agentry/ui/components/icons';
import { timeAgo } from '@agentry/ui/lib/format';
import { autoMergeOffKey } from '../lib/merge';

/**
 * What the merge state says besides what blocks it, worded the same on the item page and the
 * orchestration page: the host limiting reads, auto-merge that Agentry turned off before it pushed
 * (until the person arms it again), and a rebase on the host that is not offered because it would
 * drop what is only in the checkout.
 */
export function MergeNotices({ state, host }: { state: Pick<MergeState, 'limitedUntil' | 'autoMergeOff' | 'rebaseOnHostWhy'>; host: string }) {
  const { t } = useTranslation('merge');
  const off = state.autoMergeOff;
  return (
    <>
      {state.limitedUntil && (
        <p className="small muted" role="status">
          {t('limited', { host, time: new Date(state.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
        </p>
      )}
      {(off || state.rebaseOnHostWhy) && (
        <span className="callout callout-warn" role="note">
          <CircleAlert {...ICON_SM} aria-hidden />
          <span>
            {off && <>{off.pushing ? t('autoMergeOff.pushing') : t(autoMergeOffKey(off.why, off.by), { when: timeAgo(off.at), who: off.by })}</>}
            {off && state.rebaseOnHostWhy && ' '}
            {state.rebaseOnHostWhy && t(`rebaseOnHostWhy.${state.rebaseOnHostWhy}`, { host })}
          </span>
        </span>
      )}
    </>
  );
}
