import type { ChatSummary } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { contextLevel, contextShare, formatPercent, formatTokens } from '../lib/chat-model';
import { formatNumber } from '../lib/format';

const R = 6;
const C = 2 * Math.PI * R;

/**
 * How full a chat's context window is, small enough for a list row: a ring and the percentage.
 * The ring turns amber and red as `ContextMeter` does, and the words it carries say the same.
 */
export function ContextRing({ chat }: { chat: Pick<ChatSummary, 'context'> }) {
  const { t } = useTranslation('chat');
  const { context } = chat;
  if (!context) return <span className="ring-text muted">—</span>;
  const share = contextShare(chat);
  if (share === null) {
    return <span className="ring-text muted">{t('badges.context.tokens', { n: formatTokens(context.used) })}</span>;
  }
  const level = contextLevel(share);
  const clamped = Math.min(1, Math.max(0, share));
  const detail = t('badges.context.detail', { used: formatNumber(context.used), window: context.window === null ? '?' : formatNumber(context.window) });
  const note = level === 'full' ? t('badges.context.aboutToCompact') : level === 'warn' ? t('badges.context.fillingUp') : '';
  return (
    <span
      className={`ring ring-${level}`}
      role="meter"
      aria-label={t('badges.context.inUse')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={note ? `${detail}, ${note}` : detail}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle className="ring-track" cx="8" cy="8" r={R} />
        <circle className="ring-fill" cx="8" cy="8" r={R} strokeDasharray={`${clamped * C} ${C}`} transform="rotate(-90 8 8)" />
      </svg>
      <span className="ring-text" aria-hidden>
        {formatPercent(share)}
      </span>
    </span>
  );
}
