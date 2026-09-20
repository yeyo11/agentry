import type { ChatBranchStatus, ChatControl, ChatOrigin, ChatState, ChatSummary, ExecutionOutcome } from '@agentry/shared';
import { CircleCheck, CirclePause, Cog, Hand, Lock, Network, OctagonX, Play, Terminal, TriangleAlert, Zap, type LucideIcon } from 'lucide-react';
import { contextLevel, contextShare, formatPercent, formatTokens, lastEnded, ORIGIN_LABEL, OUTCOME_LABEL, STATE_LABEL } from '../lib/chat-model';
import '../chats.css';
import { Tooltip } from './controls/Tooltip';
import { ICON_SM } from './icons';

/*
 * What a chat is, said the same way wherever it appears: in words and with an icon, never with a
 * colour alone. The colour only reinforces.
 */

const STATE_TONE: Record<ChatState, string> = { working: 'active', waiting: 'warn', idle: 'idle' };
const STATE_HINT: Record<ChatState, string> = {
  working: 'A process is generating or running tools',
  waiting: 'Stopped until a person answers a permission, a question or a plan',
  idle: 'Nothing is running and nothing is waiting',
};

const STATE_ICON: Record<Exclude<ChatState, 'working'>, LucideIcon> = { waiting: Hand, idle: CirclePause };

export function StateBadge({ state }: { state: ChatState }) {
  const Icon = state === 'working' ? null : STATE_ICON[state];
  return (
    <Tooltip content={STATE_HINT[state]}>
      <span className={`badge badge-${STATE_TONE[state]}`}>
        {Icon ? <Icon size={12} strokeWidth={2} aria-hidden /> : <span className="spinner spinner-xs" aria-hidden />}
        {STATE_LABEL[state]}
      </span>
    </Tooltip>
  );
}

const OUTCOME_TONE: Record<ExecutionOutcome, string> = { completed: 'ok', failed: 'bad', stopped: 'warn', interrupted: 'bad' };
const OUTCOME_ICON: Record<ExecutionOutcome, LucideIcon> = { completed: CircleCheck, failed: TriangleAlert, stopped: OctagonX, interrupted: Zap };

/** How an execution ended; `null` is the one still running. */
export function OutcomeBadge({ outcome }: { outcome: ExecutionOutcome | null }) {
  if (outcome === null) {
    return (
      <span className="badge badge-active">
        <span className="spinner spinner-xs" aria-hidden />
        Running
      </span>
    );
  }
  const Icon = OUTCOME_ICON[outcome];
  return (
    <span className={`badge badge-${OUTCOME_TONE[outcome]}`}>
      <Icon size={12} strokeWidth={2} aria-hidden />
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

const BRANCH_TONE: Record<ChatBranchStatus, string> = { running: 'active', completed: 'ok', failed: 'bad', stopped: 'warn' };
const BRANCH_ICON: Record<Exclude<ChatBranchStatus, 'running'>, LucideIcon> = { completed: CircleCheck, failed: TriangleAlert, stopped: OctagonX };

/** How far a subagent, a background task or a workflow has got. */
export function BranchStatus({ status }: { status: ChatBranchStatus }) {
  const Icon = status === 'running' ? null : BRANCH_ICON[status];
  return (
    <span className={`badge badge-${BRANCH_TONE[status]}`}>
      {Icon ? <Icon size={12} strokeWidth={2} aria-hidden /> : <span className="spinner spinner-xs" aria-hidden />}
      {status}
    </span>
  );
}

const ORIGIN_ICON:Record<ChatOrigin, LucideIcon> = { agentry: Play, external: Terminal, orchestration: Network, internal: Cog };
const ORIGIN_TIP: Record<ChatOrigin, string> = {
  agentry: 'Started from Agentry',
  external: 'Started in a terminal with Claude Code',
  orchestration: 'Works for an orchestration',
  internal: 'Housekeeping of Agentry itself',
};

/** Where the chat was born: it never changes, even when resuming adopts the chat. */
export function OriginBadge({ origin, label }: { origin: ChatOrigin; label?: string }) {
  const Icon = ORIGIN_ICON[origin];
  return (
    <Tooltip content={ORIGIN_TIP[origin]}>
      <span className="badge badge-muted">
        <Icon size={11} strokeWidth={2} aria-hidden /> {label ?? ORIGIN_LABEL[origin]}
      </span>
    </Tooltip>
  );
}

/** Who is driving, which decides what can be done now. */
export function ControlBadge({ control }: { control: ChatControl }) {
  if (control.mode === 'interactive') {
    return (
      <Tooltip content="Agentry is driving this chat: write to it, interrupt it, change how it runs">
        <span className="badge badge-ok">
          <Zap size={12} strokeWidth={2} aria-hidden /> Interactive
        </span>
      </Tooltip>
    );
  }
  if (control.mode === 'resumable') {
    return (
      <Tooltip content="Nothing holds this chat: sending a message resumes it">
        <span className="badge badge-info">
          <Play size={12} strokeWidth={2} aria-hidden /> Resumable
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={control.reason}>
      <span className="badge badge-warn">
        <Lock size={12} strokeWidth={2} aria-hidden /> Read-only
      </span>
    </Tooltip>
  );
}

/**
 * How much of the window the conversation fills, as of its last response. A share close to 1 is a
 * chat about to compact. Without a known window there is no share to invent: the tokens are shown.
 */
export function ContextMeter({ chat, wide = false }: { chat: Pick<ChatSummary, 'context'>; wide?: boolean }) {
  const { context } = chat;
  if (!context) return <span className="muted small">no context yet</span>;
  const share = contextShare(chat);
  if (share === null) {
    return (
      <span className="small muted" title="The window of this model is not known yet, so no percentage is shown">
        {formatTokens(context.used)} tokens
      </span>
    );
  }
  const level = contextLevel(share);
  const detail = `${context.used.toLocaleString()} of ${context.window?.toLocaleString() ?? '?'} tokens`;
  return (
    <span className={`ctx ctx-${level} ${wide ? 'ctx-wide' : ''}`} title={detail}>
      <span className="ctx-bar" role="meter" aria-label="Context in use" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(share * 100))} aria-valuetext={detail}>
        <span style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
      <span className="ctx-text">
        {formatPercent(share)}
        {level !== 'ok' && (
          <>
            {' '}
            <TriangleAlert size={11} strokeWidth={2} aria-hidden />
            <span className="ctx-note">{level === 'full' ? 'about to compact' : 'filling up'}</span>
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
