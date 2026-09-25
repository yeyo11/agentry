import type { ChatWorkflow, ChatWorkflowAgent, ContentBlock, TranscriptEntry } from '@agentry/shared';
import { Brain, CircleAlert, CircleStop, Check, ChevronRight, Info, PanelRightOpen, Terminal, User, Zap, type LucideIcon } from 'lucide-react';
import { lazy, memo, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { readNotices, type Notice, type NoticeKind } from '../lib/chat-notice';
import { justStreamed } from '../lib/chat-stream';
import { callCount, callHint, isDelegation, rowOf, stepDuration, stepTools, transcriptRows, type StepCall, type StepPart, type TranscriptRow } from '../lib/chat-steps';
import { formatDuration, formatClock, formatDateTime, truncate } from '../lib/format';
import type { ProgressStatus } from '../lib/progress';
import { AttachedFiles, MediaBlock, splitAttached } from './Attachments';
import { CodeBlock } from './CodeBlock';
import { ProgressBar } from './ProgressBar';
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

const NOTICE_ICONS: Record<NoticeKind, LucideIcon> = { task: Zap, reminder: Info, command: Terminal, output: Terminal, interrupt: CircleStop };

/**
 * Something the system said, not the person: a strip in the machine's own voice — mono, in the
 * accent colour, with its payload behind a fold — so a reader never mistakes it for a message.
 */
function NoticeRow({ notice }: { notice: Notice }) {
  const { t } = useTranslation('components');
  const Icon = NOTICE_ICONS[notice.kind];
  const failed = Boolean(notice.status) && notice.status !== 'completed';
  const line = (
    <>
      <Icon {...ICON_SM} className="notice-icon" />
      <span className="notice-label">{t(`transcript.notice.${notice.kind}`)}</span>
      {notice.status && <span className={`notice-status ${failed ? 'is-bad' : 'is-ok'}`}>{notice.status}</span>}
      {/* Two lines at most: what the system says is worth a glance, not a screen of the conversation */}
      <span className="notice-detail" title={notice.detail}>
        {notice.detail}
      </span>
    </>
  );
  const tone = `notice is-${notice.kind} ${failed ? 'is-bad' : ''}`.trim();
  if (!notice.body) return <div className={tone}>{line}</div>;
  return (
    <Collapsible className={`fold notice-fold ${tone}`} title={line}>
      {/* Behind the fold the whole of it, the line included: the line above may have been cut */}
      <div className="notice-body">{`${notice.detail}\n${notice.body}`}</div>
    </Collapsible>
  );
}

/**
 * What a `user` entry really holds: the prose a person typed, and the notices the harness wrote
 * into it. Only user entries carry them, and a message that is nothing but notices has no prose.
 */
function readEntry(entry: TranscriptEntry): { blocks: ContentBlock[]; notices: Notice[] } {
  if (entry.role !== 'user') return { blocks: entry.blocks, notices: [] };
  const notices: Notice[] = [];
  const blocks: ContentBlock[] = [];
  for (const block of entry.blocks) {
    if (block.type !== 'text') {
      blocks.push(block);
      continue;
    }
    const read = readNotices(block.text);
    notices.push(...read.notices);
    if (read.prose) blocks.push({ type: 'text', text: read.prose });
  }
  return { blocks, notices };
}

export const EntryView = memo(function EntryView({ entry, continued = false, fresh = false }: { entry: TranscriptEntry; continued?: boolean; /** Said a moment ago: the row rises into place once */ fresh?: boolean }) {
  const { t } = useTranslation('components');
  const { blocks, notices } = useMemo(() => readEntry(entry), [entry]);
  const onlyToolResults = entry.role === 'user' && entry.blocks.every((b) => b.type === 'tool_result');
  const role = onlyToolResults ? 'tool' : entry.role;
  const head = !onlyToolResults && !continued;
  // Nothing but notices: they stand on their own, without an avatar and without a name on them
  if (notices.length > 0 && blocks.length === 0) {
    return (
      <div className="msg msg-notice">
        <span className="avatar-gap" aria-hidden />
        <div className="msg-body">
          {notices.map((notice, i) => (
            <NoticeRow key={i} notice={notice} />
          ))}
          <RowTime at={entry.timestamp} />
        </div>
      </div>
    );
  }
  return (
    <article className={`msg msg-${role} ${entry.isSidechain ? 'msg-sidechain' : ''} ${continued ? 'is-continued' : ''} ${fresh ? 'is-fresh' : ''}`.trimEnd()}>
      {head ? <Avatar role={entry.role} /> : <span className="avatar-gap" aria-hidden />}
      <div className="msg-body">
        <RowTime at={entry.timestamp} />
        {head && (
          <header className="msg-head">
            <span className="msg-role">{entry.role === 'user' ? t('transcript.user') : 'Claude'}</span>
            {entry.isSidechain && <span className="badge badge-info">{t('transcript.subagent')}</span>}
            {entry.model && <span className="muted small msg-model">{entry.model}</span>}
          </header>
        )}
        {withoutListedMedia(blocks).map((block, i) => (
          <Block key={i} block={block} role={entry.role} />
        ))}
        {notices.map((notice, i) => (
          <NoticeRow key={`notice-${i}`} notice={notice} />
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
const StepView = memo(function StepView({
  row,
  current,
  subagents,
  fresh = false,
  launches,
  onOpenLaunch,
}: {
  row: Extract<TranscriptRow, { kind: 'step' }>;
  current: boolean;
  subagents?: SubagentLink;
  fresh?: boolean;
  /** The workflows its `Workflow` calls started, each shown as a card under the step */
  launches?: ChatWorkflow[];
  onOpenLaunch?: () => void;
}) {
  const { t } = useTranslation('components');
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? current;
  const count = callCount(row.parts);
  const failed = row.parts.filter((p) => p.kind === 'call' && p.result?.isError).length;
  const duration = stepDuration(row);
  const tools = stepTools(row.parts);
  return (
    <article className={`msg msg-step ${row.isSidechain ? 'msg-sidechain' : ''} ${current ? 'is-current' : ''} ${fresh ? 'is-fresh' : ''}`.trimEnd()}>
      <span className="avatar-gap" aria-hidden />
      <div className="msg-body">
        <RowTime at={row.startedAt} />
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
              <span className="step-tools">
                {tools.map((tool) => (
                  <span key={tool.name} className="badge step-tool">
                    {tool.count > 1 ? `${tool.name} ×${tool.count}` : tool.name}
                  </span>
                ))}
              </span>
              {current && <span className="sr-only">{t('transcript.stepCurrent')}</span>}
            </>
          }
        >
          <div className="step-parts">
            {row.parts.map((part, i) => (
              <PartView key={part.kind === 'call' ? part.id : `t${i}`} part={part} settled={!current} subagents={subagents} />
            ))}
          </div>
        </Collapsible>
        {launches?.map((workflow) => <LaunchCard key={workflow.id} workflow={workflow} onOpen={onOpenLaunch} />)}
      </div>
    </article>
  );
});

/** Workflows a chat started, and where to see them whole. */
export interface WorkflowLaunches {
  list: readonly ChatWorkflow[];
  open: () => void;
}

// A call is answered in seconds, the run it starts is stamped a moment after: some slack either side
const LAUNCH_SLACK_MS = 30_000;

/**
 * The workflows a step's `Workflow` calls started. The transcript does not carry the run's id, so a
 * run belongs to the step it started during: between the step's first entry and its last.
 */
function launchesOf(row: Extract<TranscriptRow, { kind: 'step' }>, list: readonly ChatWorkflow[]): ChatWorkflow[] | undefined {
  if (!row.startedAt || !row.parts.some((part) => part.kind === 'call' && part.name === WORKFLOW_TOOL)) return undefined;
  const from = Date.parse(row.startedAt) - LAUNCH_SLACK_MS;
  const to = Date.parse(row.endedAt ?? row.startedAt) + LAUNCH_SLACK_MS;
  const found = list.filter((workflow) => {
    const at = Date.parse(workflow.startedAt);
    return at >= from && at <= to;
  });
  return found.length > 0 ? found : undefined;
}

const WORKFLOW_TOOL = 'Workflow';
const LAUNCH_SEGMENT: Record<ChatWorkflowAgent['status'], ProgressStatus> = { completed: 'done', running: 'running', failed: 'failed' };

/**
 * A workflow the chat started, as the card the conversation points at: its name, how far it has
 * got, one segment per agent, and a way to its full card in the inspector.
 */
function LaunchCard({ workflow, onOpen }: { workflow: ChatWorkflow; onOpen?: () => void }) {
  const { t } = useTranslation('chat');
  const name = workflow.name ?? workflow.description;
  const running = workflow.status === 'running';
  const done = workflow.agents.filter((agent) => agent.status === 'completed').length;
  // The phase it is in: the last one an agent has started in
  const phase = workflow.agents.reduce((at, agent) => Math.max(at, agent.phase ? workflow.phases.indexOf(agent.phase) + 1 : 0), 0);
  const facts = [
    workflow.phases.length > 0 && phase > 0 ? t('launch.phase', { n: phase, total: workflow.phases.length }) : null,
    workflow.agents.length > 0 ? t('launch.agents', { done, total: workflow.agents.length }) : null,
  ].filter(Boolean);
  return (
    <div className={`chat-launch grad-border ${running ? 'is-running' : ''}`.trim()}>
      <div className="chat-launch-head">
        <span className="chat-launch-mark" aria-hidden>
          {name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()}
        </span>
        <span className="chat-launch-what">
          <span className="chat-launch-name ellipsis">{name}</span>
          <span className="chat-launch-state">
            {running && <Spinner />}
            <span className={`chat-launch-status is-${workflow.status}`}>{t(`badges.outcome.${workflow.status}`)}</span>
            {facts.length > 0 && <span className="chat-launch-facts">{facts.join(' · ')}</span>}
          </span>
        </span>
        {onOpen && (
          <button type="button" className="btn btn-small chat-launch-open" onClick={onOpen} aria-label={t('launch.openHint', { name })}>
            {t('launch.open')}
            <ChevronRight {...ICON_SM} />
          </button>
        )}
      </div>
      {workflow.agents.length > 0 && (
        <ProgressBar variant="segments" size="sm" decorative cells={workflow.agents.map((agent) => LAUNCH_SEGMENT[agent.status])} />
      )}
    </div>
  );
}

/** The block Claude is generating right now, fed by ephemeral `partial` stream events. */
export function StreamingEntry({ block, text, continued = false }: { block: 'text' | 'thinking'; text: string; continued?: boolean }) {
  const { t } = useTranslation('components');
  return (
    <article className={`msg msg-assistant msg-streaming ${continued ? 'is-continued' : ''}`} aria-live="off" data-find-ignore>
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

/**
 * How tall a row will be, before it has ever been drawn. A step is one folded line; a message is
 * its text at the width it will wrap to, plus what each block of another kind takes. Rough on
 * purpose and never exact — it only has to be closer than "every row is 140px", which is what the
 * list reserved before and had to take back, in front of the reader, the moment a row was measured.
 */
function estimateRow(row: TranscriptRow, width: number): number {
  if (row.kind === 'step') return 40;
  const perLine = Math.max(20, Math.floor((width - 44) / 7.2));
  let lines = 0;
  let extra = 0;
  for (const block of row.entry.blocks) {
    if (block.type === 'text' || block.type === 'thinking') lines += Math.ceil(block.text.length / perLine) + (block.text.match(/\n/g)?.length ?? 0) / 2;
    else if (block.type === 'tool_result') extra += 44;
    else if (block.type === 'tool_use') extra += 44;
    else extra += 190; // an image or a document, shown as a thumbnail or a chip
  }
  const head = row.continued ? 0 : 24;
  return Math.min(1400, head + extra + Math.ceil(lines) * 21 + 12);
}

export function Transcript({
  rows,
  entries,
  pinToBottom = false,
  onReachTop,
  focus,
  working = false,
  subagents,
  workflows,
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
  /** Workflows the chat started: each shows as a card under the step that started it */
  workflows?: WorkflowLaunches;
}) {
  const own = useMemo(() => rows ?? transcriptRows(entries), [rows, entries]);
  const target = focus ? rowOf(own, focus.item) : undefined;
  const focused = useMemo(() => (target ? { item: target } : null), [target, focus]);
  const last = own.at(-1);
  // Worked out once per change of rows or runs, so a step's props hold still between renders
  const launches = useMemo(() => {
    if (!workflows || workflows.list.length === 0) return null;
    const byRow = new Map<string, ChatWorkflow[]>();
    for (const row of own) {
      const found = row.kind === 'step' ? launchesOf(row, workflows.list) : undefined;
      if (found) byRow.set(row.key, found);
    }
    return byRow;
  }, [own, workflows]);
  return (
    <VirtualList className="transcript" items={own} itemKey={(row) => row.key} pinToBottom={pinToBottom} onReachTop={onReachTop} focus={focused} estimate={estimateRow}>
      {(row) =>
        row.kind === 'entry' ? (
          // Only what a person sent: an answer of Claude's was already on screen as it was written
          <EntryView entry={row.entry} continued={row.continued} fresh={row.entry.role === 'user' && justStreamed(row.entry)} />
        ) : (
          <StepView
            row={row}
            current={working && row === last}
            subagents={subagents}
            fresh={justStreamed(row.entries[row.entries.length - 1] ?? row.entries[0]!)}
            launches={launches?.get(row.key)}
            onOpenLaunch={workflows?.open}
          />
        )
      }
    </VirtualList>
  );
}
