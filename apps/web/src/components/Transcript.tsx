import type { ContentBlock, TranscriptEntry } from '@agentry/shared';
import { Brain, CircleAlert, Check, PanelRightOpen, User } from 'lucide-react';
import { lazy, memo, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callCount, callHint, isDelegation, rowOf, stepDuration, stepTools, transcriptRows, type StepCall, type StepPart, type TranscriptRow } from '../lib/chat-steps';
import { formatDuration, formatClock, formatDateTime, truncate } from '../lib/format';
import { AttachedFiles, MediaBlock, splitAttached } from './Attachments';
import { CodeBlock } from './CodeBlock';
import { Collapsible } from './controls/Collapsible';
import { Tooltip } from './controls/Tooltip';
import { BrandMark, ICON_SM, toolIcon } from './icons';
import { Spinner } from './Spinner';
import { VirtualList } from './VirtualList';

const RESULT_PREVIEW_CHARS = 6000;

const Markdown = lazy(() => import('./Markdown'));

/**
 * Markdown the way chat apps show it: GFM tables and task lists, highlighted code, safe links. The
 * renderer loads on first use; until then the text shows as typed, so nothing waits on it.
 * `streaming` marks text that is still growing, so only its last block is parsed on every update.
 */
export const RichText = memo(function RichText({ text, className = '', streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  return (
    <div className={`rich md ${className}`}>
      <Suspense fallback={<div className="prose">{text}</div>}>
        <Markdown text={text} streaming={streaming} />
      </Suspense>
    </div>
  );
});

function ResultBlock({ content, isError }: { content: string; isError: boolean }) {
  const { t } = useTranslation('components');
  const long = content.length > RESULT_PREVIEW_CHARS;
  return (
    <CodeBlock
      tone={isError ? 'error' : undefined}
      code={long ? `${content.slice(0, RESULT_PREVIEW_CHARS)}\n${t('transcript.moreChars', { count: content.length - RESULT_PREVIEW_CHARS })}` : content || t('transcript.empty')}
    />
  );
}

function ThinkingFold({ text }: { text: string }) {
  const { t } = useTranslation('components');
  return (
    <Collapsible
      className="fold fold-thinking"
      title={
        <>
          <Brain {...ICON_SM} className="fold-icon" />
          <span className="tool-name">{t('transcript.thinking')}</span>
        </>
      }
    >
      <div className="prose muted fold-body">{text}</div>
    </Collapsible>
  );
}

function Block({ block, role }: { block: ContentBlock; role: 'user' | 'assistant' }) {
  const { t } = useTranslation('components');
  switch (block.type) {
    case 'text': {
      const { text, files } = splitAttached(block.text);
      return (
        <>
          {/* What a person typed is shown as typed, the way chat apps do; Claude's answers are markdown */}
          {text.trim() && (role === 'user' ? <div className="prose">{text.trim()}</div> : <RichText text={text} />)}
          <AttachedFiles files={files} />
        </>
      );
    }
    case 'image':
    case 'document':
      return <MediaBlock kind={block.type} mediaType={block.mediaType} name={block.name} uploadId={block.uploadId} />;
    case 'thinking':
      return <ThinkingFold text={block.text} />;
    // A call or a result outside a step: what is left of a turn whose other half is not held
    case 'tool_use':
      return <CallRow call={{ kind: 'call', id: block.id, name: block.name, input: block.input, result: null }} settled />;
    case 'tool_result':
      return (
        <Collapsible
          className={`fold fold-call ${block.isError ? 'is-error' : 'is-ok'}`}
          title={
            <>
              <CircleAlert {...ICON_SM} className="fold-icon" />
              <span className="tool-name">{block.isError ? t('transcript.toolError') : t('transcript.toolResult')}</span>
              <span className="tool-hint">{truncate(block.content.replace(/\s+/g, ' '), 110) || t('transcript.empty')}</span>
            </>
          }
        >
          <ResultBlock content={block.content} isError={block.isError} />
        </Collapsible>
      );
  }
}

/**
 * A message sent through the wrapper names its files in a list, which shows each one; the image and
 * PDF blocks it also carries would show them twice.
 */
function withoutListedMedia(blocks: ContentBlock[]): ContentBlock[] {
  const listed = blocks.some((b) => b.type === 'text' && b.text.includes('<attached-files>'));
  return listed ? blocks.filter((b) => b.type !== 'image' && b.type !== 'document') : blocks;
}

/** The time a row was written: out of the way until the reader points at the row or moves into it. */
function RowTime({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <time className="msg-time" dateTime={at} title={formatDateTime(at)}>
      {formatClock(at)}
    </time>
  );
}

export const EntryView = memo(function EntryView({ entry, continued = false }: { entry: TranscriptEntry; continued?: boolean }) {
  const { t } = useTranslation('components');
  const onlyToolResults = entry.role === 'user' && entry.blocks.every((b) => b.type === 'tool_result');
  const role = onlyToolResults ? 'tool' : entry.role;
  const head = !onlyToolResults && !continued;
  return (
    <article className={`msg msg-${role} ${entry.isSidechain ? 'msg-sidechain' : ''} ${continued ? 'is-continued' : ''}`}>
      {head ? <Avatar role={entry.role} /> : <span className="avatar-gap" aria-hidden />}
      <div className="msg-body">
        {head ? (
          <header className="msg-head">
            <span className="msg-role">{entry.role === 'user' ? t('transcript.user') : 'Claude'}</span>
            {entry.isSidechain && <span className="badge badge-info">{t('transcript.subagent')}</span>}
            {entry.model && <span className="muted small msg-model">{entry.model}</span>}
            <RowTime at={entry.timestamp} />
          </header>
        ) : (
          <RowTime at={entry.timestamp} />
        )}
        {withoutListedMedia(entry.blocks).map((block, i) => (
          <Block key={i} block={block} role={entry.role} />
        ))}
      </div>
    </article>
  );
});

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <span className={`avatar avatar-${role}`} aria-hidden>
      {role === 'user' ? <User {...ICON_SM} /> : <BrandMark size={26} />}
    </span>
  );
}

/** A delegation whose subagent can be opened, and how. */
export interface SubagentLink {
  find: (input: unknown) => string | null;
  open: (agentId: string) => void;
}

/**
 * One tool call as one row: its name and what it was pointed at in mono, a rail coloured by how it
 * came back, and the input and result behind the fold. `settled` is a call that will not come back
 * any more as far as this page knows (the turn is over), so it is not shown as running.
 */
function CallRow({ call, settled, subagents }: { call: StepCall; settled: boolean; subagents?: SubagentLink }) {
  const { t } = useTranslation('components');
  const running = call.result === null && !settled && call.name !== null;
  const outcome = call.result ? (call.result.isError ? 'error' : 'ok') : running ? 'running' : 'none';
  const Icon = call.name ? toolIcon(call.name) : CircleAlert;
  const agentId = subagents && isDelegation(call.name) ? subagents.find(call.input) : null;
  const hint = call.name ? callHint(call.input) : truncate((call.result?.content ?? '').replace(/\s+/g, ' '), 110);
  return (
    <div className={`call-row is-${outcome}`}>
      <Collapsible
        className="fold fold-call"
        title={
          <>
            {running ? <Spinner className="fold-icon" /> : <Icon {...ICON_SM} className="fold-icon" />}
            <span className="tool-name">{call.name ?? (call.result?.isError ? t('transcript.toolError') : t('transcript.toolResult'))}</span>
            <span className="tool-hint">{hint}</span>
            {/* The rail's colour is not the only thing that says it failed */}
            {outcome === 'error' && <span className="call-outcome">{t('transcript.callFailed')}</span>}
            {outcome === 'running' && <span className="sr-only">{t('transcript.callRunning')}</span>}
          </>
        }
      >
        <div className="call-body">
          {call.name !== null && <CodeBlock code={JSON.stringify(call.input, null, 2)} lang="json" />}
          {call.result ? <ResultBlock content={call.result.content} isError={call.result.isError} /> : running && <p className="muted small">{t('transcript.callWaiting')}</p>}
        </div>
      </Collapsible>
      {agentId && subagents && (
        <Tooltip content={t('transcript.openSubagent')}>
          <button type="button" className="icon-btn call-open" aria-label={t('transcript.openSubagent')} onClick={() => subagents.open(agentId)}>
            <PanelRightOpen {...ICON_SM} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function PartView({ part, settled, subagents }: { part: StepPart; settled: boolean; subagents?: SubagentLink }) {
  return part.kind === 'thinking' ? <ThinkingFold text={part.text} /> : <CallRow call={part} settled={settled} subagents={subagents} />;
}

/**
 * A turn's tool calls, folded into one block that says how many and how long. The step being worked
 * on right now is open and carries the live rail; once it is done it folds away, unless the reader
 * opened or closed it themselves.
 */
const StepView = memo(function StepView({ row, current, subagents }: { row: Extract<TranscriptRow, { kind: 'step' }>; current: boolean; subagents?: SubagentLink }) {
  const { t } = useTranslation('components');
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? current;
  const count = callCount(row.parts);
  const failed = row.parts.filter((p) => p.kind === 'call' && p.result?.isError).length;
  const duration = stepDuration(row);
  const tools = stepTools(row.parts);
  return (
    <article className={`msg msg-step ${row.isSidechain ? 'msg-sidechain' : ''} ${current ? 'is-current' : ''}`}>
      <span className="avatar-gap" aria-hidden />
      <div className="msg-body">
        <Collapsible
          className={`fold tool-step ${current ? 'live-rail' : ''}`}
          open={open}
          onOpenChange={setChosen}
          title={
            <>
              {current ? <Spinner className="fold-icon step-icon" /> : failed > 0 ? <CircleAlert {...ICON_SM} className="fold-icon step-icon is-error" /> : <Check {...ICON_SM} className="fold-icon step-icon" />}
              <span className="step-count">
                {t('transcript.tools', { count })}
                {duration !== null && duration >= 1000 && ` · ${formatDuration(duration)}`}
                {failed > 0 && ` · ${t('transcript.failedCalls', { count: failed })}`}
              </span>
              <span className="step-tools">{tools.map((tool) => (tool.count > 1 ? `${tool.name} ×${tool.count}` : tool.name)).join(' · ')}</span>
              {current && <span className="sr-only">{t('transcript.stepCurrent')}</span>}
              <RowTime at={row.startedAt} />
            </>
          }
        >
          <div className="step-parts">
            {row.parts.map((part, i) => (
              <PartView key={part.kind === 'call' ? part.id : `t${i}`} part={part} settled={!current} subagents={subagents} />
            ))}
          </div>
        </Collapsible>
      </div>
    </article>
  );
});

/** The block Claude is generating right now, fed by ephemeral `partial` stream events. */
export function StreamingEntry({ block, text, continued = false }: { block: 'text' | 'thinking'; text: string; continued?: boolean }) {
  const { t } = useTranslation('components');
  return (
    <article className={`msg msg-assistant msg-streaming ${continued ? 'is-continued' : ''}`} aria-live="off">
      {continued ? <span className="avatar-gap" aria-hidden /> : <Avatar role="assistant" />}
      <div className="msg-body">
        {!continued && (
          <header className="msg-head">
            <span className="msg-role">Claude</span>
          </header>
        )}
        {block === 'thinking' ? (
          <div className="streaming-thinking">
            <div className="streaming-thinking-label">
              <Brain {...ICON_SM} /> {t('transcript.thinkingNow')}
            </div>
            <div className="prose muted">{text.length > 1200 ? `…${text.slice(-1200)}` : text}</div>
          </div>
        ) : (
          <RichText text={text} className="streaming-text" streaming />
        )}
      </div>
    </article>
  );
}

/** Whether what comes after these rows is still Claude speaking, so it needs no author line. */
export function endsWithAssistant(entries: readonly TranscriptEntry[]): boolean {
  const last = entries.at(-1);
  return Boolean(last && !last.isSidechain && (last.role === 'assistant' || last.blocks.every((b) => b.type === 'tool_result')));
}

export function Transcript({
  rows,
  entries,
  pinToBottom = false,
  onReachTop,
  focus,
  working = false,
  subagents,
}: {
  entries: TranscriptEntry[];
  /** The rows of `entries`, when the caller has already worked them out */
  rows?: TranscriptRow[];
  pinToBottom?: boolean;
  onReachTop?: () => void;
  focus?: { item: TranscriptEntry } | null;
  /** The chat is working: its last step is the one being worked on */
  working?: boolean;
  subagents?: SubagentLink;
}) {
  const own = useMemo(() => rows ?? transcriptRows(entries), [rows, entries]);
  const target = focus ? rowOf(own, focus.item) : undefined;
  const focused = useMemo(() => (target ? { item: target } : null), [target, focus]);
  const last = own.at(-1);
  return (
    <VirtualList className="transcript" items={own} itemKey={(row) => row.key} pinToBottom={pinToBottom} onReachTop={onReachTop} focus={focused}>
      {(row) =>
        row.kind === 'entry' ? (
          <EntryView entry={row.entry} continued={row.continued} />
        ) : (
          <StepView row={row} current={working && row === last} subagents={subagents} />
        )
      }
    </VirtualList>
  );
}
