import type { ChatBranchStatus, ChatControl, ChatOrigin, ChatState, ChatSummary, ExecutionOutcome } from '@agentry/shared';
import { CircleCheck, CirclePause, Cog, Hand, Lock, Network, OctagonX, Play, Terminal, TriangleAlert, Zap, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { contextLevel, contextShare, formatPercent, formatTokens, lastEnded } from '../lib/chat-model';
import { formatNumber } from '../lib/format';
import '../chats.css';
import { Tooltip } from './controls/Tooltip';
import { usageTone } from './motion';
import { statusText } from './ui';

/*
 * What a chat is, said the same way wherever it appears: in words and with an icon, never with a
 * colour alone. The colour only reinforces.
 */

const STATE_TONE: Record<ChatState, string> = { working: 'active', waiting: 'warn', idle: 'idle' };

const STATE_ICON: Record<Exclude<ChatState, 'working'>, LucideIcon> = { waiting: Hand, idle: CirclePause };

export function StateBadge({ state }: { state: ChatState }) {
  const { t } = useTranslation('chat');
  const Icon = state === 'working' ? null : STATE_ICON[state];
  return (
    <Tooltip content={t(`badges.stateHint.${state}`)}>
      <span className={`badge badge-${STATE_TONE[state]}`}>
        {Icon ? <Icon size={12} strokeWidth={2} aria-hidden /> : <span className="spinner spinner-xs" aria-hidden />}
        {t(`badges.state.${state}`)}
      </span>
    </Tooltip>
  );
}

const OUTCOME_TONE: Record<ExecutionOutcome, string> = { completed: 'ok', failed: 'bad', stopped: 'warn', interrupted: 'bad' };
const OUTCOME_ICON: Record<ExecutionOutcome, LucideIcon> = { completed: CircleCheck, failed: TriangleAlert, stopped: OctagonX, interrupted: Zap };

/** How an execution ended; `null` is the one still running. */
export function OutcomeBadge({ outcome }: { outcome: ExecutionOutcome | null }) {
  const { t } = useTranslation('chat');
  if (outcome === null) {
    return (
      <span className="badge badge-active">
        <span className="spinner spinner-xs" aria-hidden />
        {t('badges.outcome.running')}
      </span>
    );
  }
  const Icon = OUTCOME_ICON[outcome];
  return (
    <span className={`badge badge-${OUTCOME_TONE[outcome]}`}>
      <Icon size={12} strokeWidth={2} aria-hidden />
      {t(`badges.outcome.${outcome}`)}
    </span>
  );
}

const BRANCH_TONE: Record<ChatBranchStatus, string> = { running: 'active', completed: 'ok', failed: 'bad', stopped: 'warn' };
const BRANCH_ICON: Record<Exclude<ChatBranchStatus, 'running'>, LucideIcon> = { completed: CircleCheck, failed: TriangleAlert, stopped: OctagonX };

/** How far a subagent, a background task or a workflow has got. */
export function BranchStatus({ status }: { status: ChatBranchStatus }) {
  // Subscribes the badge to language changes; statusText reads the active language
  useTranslation();
  const Icon = status === 'running' ? null : BRANCH_ICON[status];
  return (
    <span className={`badge badge-${BRANCH_TONE[status]}`}>
      {Icon ? <Icon size={12} strokeWidth={2} aria-hidden /> : <span className="spinner spinner-xs" aria-hidden />}
      {statusText(status)}
    </span>
  );
}

const ORIGIN_ICON:Record<ChatOrigin, LucideIcon> = { agentry: Play, external: Terminal, orchestration: Network, internal: Cog };

/** Where the chat was born: it never changes, even when resuming adopts the chat. */
export function OriginBadge({ origin, label }: { origin: ChatOrigin; label?: string }) {
  const { t } = useTranslation('chat');
  const Icon = ORIGIN_ICON[origin];
  return (
    <Tooltip content={t(`badges.originHint.${origin}`)}>
      <span className="badge badge-muted">
        <Icon size={11} strokeWidth={2} aria-hidden /> {label ?? t(`badges.origin.${origin}`)}
      </span>
    </Tooltip>
  );
}

/** Who is driving, which decides what can be done now. */
export function ControlBadge({ control }: { control: ChatControl }) {
  const { t } = useTranslation('chat');
  if (control.mode === 'interactive') {
    return (
      <Tooltip content={t('badges.control.interactiveHint')}>
        <span className="badge badge-ok">
          <Zap size={12} strokeWidth={2} aria-hidden /> {t('badges.control.interactive')}
        </span>
      </Tooltip>
    );
  }
  if (control.mode === 'resumable') {
    return (
      <Tooltip content={t('badges.control.resumableHint')}>
        <span className="badge badge-info">
          <Play size={12} strokeWidth={2} aria-hidden /> {t('badges.control.resumable')}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={control.reason}>
      <span className="badge badge-warn">
        <Lock size={12} strokeWidth={2} aria-hidden /> {t('badges.control.readOnly')}
      </span>
    </Tooltip>
  );
}

/**
 * How much of the window the conversation fills, as of its last response. A share close to 1 is a
 * chat about to compact. Without a known window there is no share to invent: the tokens are shown.
 */
export function ContextMeter({ chat, wide = false }: { chat: Pick<ChatSummary, 'context'>; wide?: boolean }) {
  const { t } = useTranslation('chat');
  const { context } = chat;
  if (!context) return <span className="muted small">{t('badges.context.none')}</span>;
  const share = contextShare(chat);
  if (share === null) {
    return (
      <span className="small muted" title={t('badges.context.unknownWindow')}>
        {t('badges.context.tokens', { n: formatTokens(context.used) })}
      </span>
    );
  }
  const level = contextLevel(share);
  const detail = t('badges.context.detail', { used: formatNumber(context.used), window: context.window === null ? '?' : formatNumber(context.window) });
  return (
    <span className={`ctx ctx-${level} ${wide ? 'ctx-wide' : ''}`} title={detail}>
      <span className="ctx-bar" role="meter" aria-label={t('badges.context.inUse')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(share * 100))} aria-valuetext={detail}>
        <span style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
      <span className="ctx-text">
        {formatPercent(share)}
        {level !== 'ok' && (
          <>
            {' '}
            <TriangleAlert size={11} strokeWidth={2} aria-hidden />
            <span className="ctx-note">{level === 'full' ? t('badges.context.aboutToCompact') : t('badges.context.fillingUp')}</span>
          </>
        )}
      </span>
    </span>
  );
}

/** For an idle chat, how its last execution ended, when that was not well. */
export function LastOutcome({ chat }: { chat: Pick<ChatSummary, 'executions' | 'execution'> }) {
  if (chat.execution) return null;
  const ended = lastEnded(chat);
  if (!ended?.outcome || ended.outcome === 'completed') return null;
  return <OutcomeBadge outcome={ended.outcome} />;
}

/**
 * The context in use as a list cell: a thin bar and the share in mono. It is a usage bar, so it
 * stays neutral below 60 % and turns warn, then bad, from 60 % and 75 % (design system §1). With
 * no known window it says the tokens, and with no context at all a dash.
 */
export function ContextBar({ chat, className = '' }: { chat: Pick<ChatSummary, 'context'>; className?: string }) {
  const { t } = useTranslation('chat');
  const { context } = chat;
  if (!context) {
    return (
      <span className={`ctx-cell is-none ${className}`.trim()}>
        <span aria-hidden>—</span>
        <span className="sr-only">{t('badges.context.none')}</span>
      </span>
    );
  }
  const share = contextShare(chat);
  if (share === null) {
    return (
      <span className={`ctx-cell is-tokens ${className}`.trim()} title={t('badges.context.unknownWindow')}>
        {t('badges.context.tokens', { n: formatTokens(context.used) })}
      </span>
    );
  }
  const percent = Math.min(100, Math.round(share * 100));
  const tone = usageTone(percent);
  const detail = t('badges.context.detail', { used: formatNumber(context.used), window: context.window === null ? '?' : formatNumber(context.window) });
  return (
    <span className={`ctx-cell is-${tone} ${className}`.trim()} title={detail}>
      <span className="meter-track meter-thin" role="meter" aria-label={t('badges.context.inUse')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={detail}>
        <span className={tone === 'neutral' ? 'meter-fill' : `meter-fill is-${tone}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="ctx-cell-value">{formatPercent(share)}</span>
    </span>
  );
}
