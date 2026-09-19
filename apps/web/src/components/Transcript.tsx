import type { ContentBlock, RunEvent, TranscriptEntry } from '@agentry/shared';
import { Brain, CircleAlert, CornerDownRight, Flag, Info, Sparkles, TerminalSquare, User } from 'lucide-react';
import { lazy, memo, Suspense } from 'react';
import { formatClock, formatCost, formatDuration, truncate } from '../lib/format';
import { AttachedFiles, MediaBlock, splitAttached } from './Attachments';
import { CodeBlock } from './CodeBlock';
import { Collapsible } from './controls/Collapsible';
import { BrandMark, ICON_SM, toolIcon } from './icons';
import { RiseIn } from './motion';
import { StatusBadge } from './ui';

const RESULT_PREVIEW_CHARS = 6000;

const Markdown = lazy(() => import('./Markdown'));

/**
 * Markdown the way chat apps show it: GFM tables and task lists, highlighted code, safe links. The
 * renderer loads on first use; until then the text shows as typed, so nothing waits on it.
 */
export const RichText = memo(function RichText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`rich md ${className}`}>
      <Suspense fallback={<div className="prose">{text}</div>}>
        <Markdown text={text} />
      </Suspense>
    </div>
  );
});

function toolHint(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill']) {
    const value = o[key];
    if (typeof value === 'string' && value) return truncate(value.replace(/\s+/g, ' '), 110);
  }
  return '';
}

function Block({ block, role }: { block: ContentBlock; role: 'user' | 'assistant' }) {
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
      return (
        <Collapsible
          className="fold fold-thinking"
          title={
            <>
              <Brain {...ICON_SM} className="fold-icon" />
              <span className="tool-name">Thinking</span>
            </>
          }
        >
          <div className="prose muted fold-body">{block.text}</div>
        </Collapsible>
      );
    case 'tool_use': {
      const ToolIcon = toolIcon(block.name);
      return (
        <Collapsible
          className="fold fold-tool"
          title={
            <>
              <ToolIcon {...ICON_SM} className="fold-icon" />
              <span className="tool-name">{block.name}</span>
              <span className="tool-hint">{toolHint(block.input)}</span>
            </>
          }
        >
          <CodeBlock code={JSON.stringify(block.input, null, 2)} lang="json" />
        </Collapsible>
      );
    }
    case 'tool_result': {
      const long = block.content.length > RESULT_PREVIEW_CHARS;
      return (
        <Collapsible
          className={`fold fold-result ${block.isError ? 'is-error' : ''}`}
          title={
            <>
              {block.isError ? <CircleAlert {...ICON_SM} className="fold-icon" /> : <CornerDownRight {...ICON_SM} className="fold-icon" />}
              <span className="tool-name">{block.isError ? 'Tool error' : 'Tool result'}</span>
              <span className="tool-hint">{truncate(block.content.replace(/\s+/g, ' '), 110) || '(empty)'}</span>
            </>
          }
        >
          <CodeBlock
            tone={block.isError ? 'error' : undefined}
            code={long ? `${block.content.slice(0, RESULT_PREVIEW_CHARS)}\n… [${block.content.length - RESULT_PREVIEW_CHARS} more chars]` : block.content}
          />
        </Collapsible>
      );
    }
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

export const EntryView = memo(function EntryView({ entry }: { entry: TranscriptEntry }) {
  const onlyToolResults = entry.role === 'user' && entry.blocks.every((b) => b.type === 'tool_result');
  const role = onlyToolResults ? 'tool' : entry.role;
  return (
    <article className={`msg msg-${role} ${entry.isSidechain ? 'msg-sidechain' : ''}`}>
      {!onlyToolResults && <Avatar role={entry.role} />}
      <div className="msg-body">
        {!onlyToolResults && (
          <header className="msg-head">
            <span className="msg-role">{entry.role === 'user' ? 'User' : 'Claude'}</span>
            {entry.isSidechain && <span className="badge badge-info">subagent</span>}
            {entry.model && <span className="muted small msg-model">{entry.model}</span>}
            <span className="muted small msg-time">{formatClock(entry.timestamp)}</span>
          </header>
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

/** The block Claude is generating right now, fed by ephemeral `partial` stream events. */
export function StreamingEntry({ block, text }: { block: 'text' | 'thinking'; text: string }) {
  return (
    <article className="msg msg-assistant msg-streaming" aria-live="off">
      <Avatar role="assistant" />
      <div className="msg-body">
        <header className="msg-head">
          <span className="msg-role">Claude</span>
          <span className="badge badge-active">
            <Sparkles {...ICON_SM} /> {block === 'thinking' ? 'thinking' : 'writing'}
          </span>
        </header>
        {block === 'thinking' ? (
          <div className="streaming-thinking">
            <div className="streaming-thinking-label">
              <Brain {...ICON_SM} /> Thinking…
            </div>
            <div className="prose muted">{text.length > 1200 ? `…${text.slice(-1200)}` : text}</div>
          </div>
        ) : (
          <RichText text={text} className="streaming-text" />
        )}
      </div>
    </article>
  );
}

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  return (
    <div className="transcript">
      {entries.map((entry, i) => (
        <EntryView key={entry.uuid || i} entry={entry} />
      ))}
    </div>
  );
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function InlineEvent({ event }: { event: RunEvent }) {
  const data = event.data ?? {};
  switch (event.kind) {
    case 'status':
      return (
        <div className="evt">
          <span className="evt-label">status</span>
          <StatusBadge status={event.status ?? 'unknown'} />
          <span className="muted small">{formatClock(event.ts)}</span>
        </div>
      );
    case 'init': {
      const servers = Array.isArray(data.mcp_servers) ? data.mcp_servers.length : 0;
      const tools = Array.isArray(data.tools) ? data.tools.length : 0;
      return (
        <div className="evt">
          <span className="evt-label">init</span>
          <span>
            {str(data.model) || 'model ?'} · {str(data.permissionMode) || 'default'} · {tools} tools · {servers} MCP servers
          </span>
        </div>
      );
    }
    case 'result': {
      const isError = data.is_error === true;
      const denials = Array.isArray(data.permission_denials) ? data.permission_denials.length : 0;
      return (
        <div className={`evt evt-result ${isError ? 'is-error' : ''}`}>
          <Flag {...ICON_SM} />
          <span className="evt-label">{isError ? 'turn failed' : 'turn done'}</span>
          <span>
            {typeof data.num_turns === 'number' ? `${data.num_turns} turns · ` : ''}
            {typeof data.duration_ms === 'number' ? `${formatDuration(data.duration_ms)} · ` : ''}
            {typeof data.total_cost_usd === 'number' ? formatCost(data.total_cost_usd) : ''}
            {denials > 0 ? ` · ${denials} permission denials` : ''}
          </span>
          {isError && event.text && <span className="evt-text">{truncate(event.text, 400)}</span>}
          {data.structured_output != null && (
            <Collapsible className="fold" title="Structured output">
              <CodeBlock code={JSON.stringify(data.structured_output, null, 2)} lang="json" />
            </Collapsible>
          )}
        </div>
      );
    }
    case 'task': {
      if (event.subtype === 'background_tasks_changed') return null;
      const patch = (data.patch ?? {}) as Record<string, unknown>;
      const status = str(data.status) || str(patch.status);
      return (
        <div className="evt">
          <span className="evt-label">{(event.subtype ?? 'task').replace(/_/g, ' ')}</span>
          <code>{str(data.task_id)}</code>
          {status && <StatusBadge status={status} />}
          <span className="evt-text">{truncate(str(data.summary) || str(data.description), 200)}</span>
        </div>
      );
    }
    case 'notice':
      return (
        <div className="evt">
          <Info {...ICON_SM} />
          <span className="evt-label">wrapper</span>
          <span className="evt-text">{event.text}</span>
          <span className="muted small">{formatClock(event.ts)}</span>
        </div>
      );
    case 'stderr':
      return (
        <div className="evt is-error">
          <TerminalSquare {...ICON_SM} />
          <span className="evt-label">stderr</span>
          <span className="evt-text mono">{event.text}</span>
        </div>
      );
    default:
      return (
        <Collapsible
          className="evt fold"
          title={
            <>
              <span className="evt-label">{event.subtype ? `${event.type}/${event.subtype}` : event.type}</span>
              {event.text && <span className="evt-text">{truncate(event.text, 200)}</span>}
            </>
          }
        >
          {event.data && <CodeBlock code={JSON.stringify(event.data, null, 2)} lang="json" />}
        </Collapsible>
      );
  }
}

/** One row, memoised: appending an event must not re-render the rows already on screen. */
const TimelineRow = memo(function TimelineRow({ event }: { event: RunEvent }) {
  return event.kind === 'message' && event.entry ? (
    <RiseIn>
      <EntryView entry={event.entry} />
    </RiseIn>
  ) : (
    <InlineEvent event={event} />
  );
});

/**
 * Memoised on the event list: the page around it re-renders on every streamed partial and every
 * keystroke in the composer, and a long transcript is far too much work to redo that often.
 */
export const RunTimeline = memo(function RunTimeline({ events }: { events: RunEvent[] }) {
  return (
    <div className="transcript">
      {events.map((event) => (
        <TimelineRow key={event.seq} event={event} />
      ))}
    </div>
  );
});
